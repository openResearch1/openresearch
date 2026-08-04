import { describe, expect, spyOn, test } from "bun:test"

import { Agent } from "../../src/agent/agent"
import { Collab } from "../../src/collab"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { CollabAutoWake } from "../../src/collab/auto-wake"
import { CollabLoop } from "../../src/collab/loop"
import { CollabMessage } from "../../src/collab/message"
import { CollabRecovery } from "../../src/collab/recovery"
import { Identifier } from "../../src/id/id"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Question } from "../../src/question"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SpawnAgentTool } from "../../src/tool/spawn-agent"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

CollabAutoWake.setEnabled(false)

async function tree() {
  const parentSession = await Session.create({ title: "failure parent" })
  const parentId = Identifier.ascending("collab_agent")
  CollabAgentNode.create({
    id: parentId,
    sessionId: parentSession.id,
    name: "parent",
    projectId: Instance.project.id,
    rootAgentId: parentId,
    subagentType: "general",
    spec: { initialPrompt: "parent" },
    status: "running",
  })

  const session = await Collab.createSubSession({ title: "failure child" })
  const id = Identifier.ascending("collab_agent")
  CollabAgentNode.create({
    id,
    sessionId: session.id,
    parentAgentId: parentId,
    name: "child",
    projectId: Instance.project.id,
    rootAgentId: parentId,
    subagentType: "general",
    spec: {
      initialPrompt: "run",
      model: { providerID: "provider", modelID: "model" },
    },
  })
  return { id, parentId }
}

describe("spawned collab failures", () => {
  test("spawn rejects an invalid explicit model before creating a child", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "spawn validation" })
        const message = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          parentID: Identifier.ascending("message"),
          mode: "build",
          agent: "build",
          modelID: "model",
          providerID: "provider",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        })) as MessageV2.Assistant
        const model = spyOn(Provider, "getModel").mockRejectedValue(
          new Provider.ModelNotFoundError({
            providerID: "openai",
            modelID: "openai/gpt-5.6-terra",
            suggestions: [],
          }),
        )
        const ctx = {
          sessionID: session.id,
          messageID: message.id,
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } satisfies Tool.Context
        const tool = await SpawnAgentTool.init()
        try {
          await expect(
            tool.execute({
              agent_type: "general",
              name: "invalid model",
              prompt: "run",
              model: { providerID: "openai", modelID: "openai/gpt-5.6-terra" },
            }, ctx),
          ).rejects.toBeInstanceOf(Provider.ModelNotFoundError)
        } finally {
          model.mockRestore()
        }

        const root = Collab.getBySession(session.id)
        expect(root).toBeDefined()
        expect(CollabAgentNode.loadChildren(root!.id)).toHaveLength(0)
      },
    })
  })

  test("spawn follows the parent model ahead of the target agent model", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "spawn sender model" })
        const message = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          parentID: Identifier.ascending("message"),
          mode: "build",
          agent: "build",
          modelID: "current",
          providerID: "sender",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        })) as MessageV2.Assistant
        const target = await Agent.get("general")
        if (!target) throw new Error("general agent is unavailable")
        const original = Agent.get
        const get = spyOn(Agent, "get").mockImplementation(async (name) =>
          name === "general" ? { ...target, model: { providerID: "target", modelID: "configured" } } : original(name),
        )
        const model = spyOn(Provider, "getModel").mockResolvedValue({} as never)
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        try {
          const tool = await SpawnAgentTool.init()
          await tool.execute(
            { agent_type: "general", name: "sender model", prompt: "run" },
            {
              sessionID: session.id,
              messageID: message.id,
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => {},
              ask: async () => {},
            },
          )
          const root = Collab.getBySession(session.id)
          const child = CollabAgentNode.loadChildren(root!.id)[0]
          expect(child.spec.model).toEqual({ providerID: "sender", modelID: "current" })
        } finally {
          start.mockRestore()
          model.mockRestore()
          get.mockRestore()
        }
      },
    })
  })

  test("model errors fail and report to the parent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await tree()
        const prompt = spyOn(SessionPrompt, "prompt").mockRejectedValue(
          new Provider.ModelNotFoundError({ providerID: "provider", modelID: "missing", suggestions: [] }),
        )
        try {
          await CollabLoop.start(item.id)
        } finally {
          prompt.mockRestore()
        }

        const child = CollabAgentNode.load(item.id)
        expect(child.status).toBe("failed")
        expect(child.error?.code).toBe("MODEL_UNAVAILABLE")
        expect(CollabAgentNode.load(item.parentId).active_children).toBe(0)
        expect(CollabMessage.list(item.parentId, { kind: "child_waiting" })).toHaveLength(0)
        expect(CollabMessage.list(item.parentId, { kind: "child_failed" })).toHaveLength(1)
      },
    })
  })

  test("assistant API errors cannot complete successfully", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await tree()
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({
          info: {
            role: "assistant",
            error: new MessageV2.APIError({ message: "provider unavailable", isRetryable: true }).toObject(),
          },
          parts: [],
        } as never)
        try {
          await CollabLoop.start(item.id)
        } finally {
          prompt.mockRestore()
        }

        const child = CollabAgentNode.load(item.id)
        expect(child.status).toBe("failed")
        expect(child.error?.code).toBe("PROVIDER_API_RETRY_EXHAUSTED")
        expect(child.error?.message).toBe("provider unavailable")
        expect(CollabMessage.list(item.parentId, { kind: "child_failed" })).toHaveLength(1)
      },
    })
  })

  test("recovery fails an orphaned interaction wait", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await tree()
        CollabAgentNode.transition(item.id, "waiting_interaction", {
          phase: "awaiting_children",
          timeStarted: Date.now(),
        })

        await CollabRecovery.scan()

        const child = CollabAgentNode.load(item.id)
        expect(child.status).toBe("failed")
        expect(child.error?.code).toBe("ORPHANED_WAIT")
        expect(CollabAgentNode.load(item.parentId).active_children).toBe(0)
        expect(CollabMessage.list(item.parentId, { kind: "child_failed" })).toHaveLength(1)
      },
    })
  })

  test("recovery fails a spawned agent after its deadline", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await tree()
        const child = CollabAgentNode.load(item.id)
        CollabAgentNode.spec(item.id, {
          ...child.spec,
          policy: { ...child.spec.policy, timeout_ms: 1 },
        })
        CollabAgentNode.transition(item.id, "running", {
          phase: "main_loop",
          timeStarted: Date.now() - 10,
        })

        await CollabRecovery.scan()

        const failed = CollabAgentNode.load(item.id)
        expect(failed.status).toBe("failed")
        expect(failed.error?.code).toBe("TIMEOUT")
        expect(CollabAgentNode.load(item.parentId).active_children).toBe(0)
        expect(CollabMessage.list(item.parentId, { kind: "child_failed" })).toHaveLength(1)
      },
    })
  })

  test("a live non-Controller peer still enforces its lifecycle timeout", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await tree()
        const child = CollabAgentNode.load(item.id)
        CollabAgentNode.spec(item.id, {
          ...child.spec,
          policy: { ...child.spec.policy, timeout_ms: 1 },
        })
        CollabAgentNode.transition(item.id, "running", { timeStarted: Date.now() - 10 })
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({
          info: { role: "assistant" },
          parts: [],
        } as never)

        try {
          await CollabLoop.start(item.id)
          expect(prompt).not.toHaveBeenCalled()
          expect(CollabAgentNode.load(item.id)).toMatchObject({ status: "failed", error: { code: "TIMEOUT" } })
        } finally {
          prompt.mockRestore()
        }
      },
    })
  })

  test("Controller trees ignore lifecycle timeouts during recovery", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const controllerSession = await Session.create({ title: "Controller" })
        const controllerId = Identifier.ascending("collab_agent")
        const controller = CollabAgentNode.create({
          id: controllerId,
          sessionId: controllerSession.id,
          name: "Controller",
          projectId: Instance.project.id,
          rootAgentId: controllerId,
          subagentType: "controller",
          spec: { initialPrompt: "", metadata: { controllerRole: "controller" } },
          status: "running",
        })
        const mainSession = await Collab.createSubSession({ title: "Research Main" })
        const main = CollabAgentNode.create({
          id: Identifier.ascending("collab_agent"),
          sessionId: mainSession.id,
          parentAgentId: controller.id,
          name: "Research Main",
          projectId: Instance.project.id,
          rootAgentId: controller.id,
          subagentType: "research",
          spec: { initialPrompt: "research", policy: { timeout_ms: 1 } },
          status: "running",
        })
        const leafSession = await Collab.createSubSession({ title: "Research leaf" })
        const leaf = CollabAgentNode.create({
          id: Identifier.ascending("collab_agent"),
          sessionId: leafSession.id,
          parentAgentId: main.id,
          name: "Research leaf",
          projectId: Instance.project.id,
          rootAgentId: controller.id,
          subagentType: "general",
          spec: { initialPrompt: "work", policy: { timeout_ms: 1 } },
          status: "running",
        })
        CollabAgentNode.transition(main.id, "running", { timeStarted: Date.now() - 10 })
        CollabAgentNode.transition(leaf.id, "running", { timeStarted: Date.now() - 10 })
        const start = spyOn(CollabLoop, "start").mockResolvedValue()

        try {
          expect(CollabLoop.timeout(CollabAgentNode.load(main.id))).toBeUndefined()
          expect(CollabLoop.timeout(CollabAgentNode.load(leaf.id))).toBeUndefined()
          await CollabRecovery.scan()
          expect(CollabAgentNode.load(main.id)).toMatchObject({ status: "running", error: null })
          expect(CollabAgentNode.load(leaf.id)).toMatchObject({ status: "running", error: null })
        } finally {
          start.mockRestore()
        }
      },
    })
  })

  test("a live Controller Research Main ignores an explicit lifecycle timeout", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const controllerSession = await Session.create({ title: "Controller" })
        const controllerId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: controllerId,
          sessionId: controllerSession.id,
          name: "Controller",
          projectId: Instance.project.id,
          rootAgentId: controllerId,
          subagentType: "controller",
          spec: { initialPrompt: "", metadata: { controllerRole: "controller" } },
          status: "running",
        })
        const session = await Collab.createSubSession({ title: "Research Main" })
        const main = CollabAgentNode.create({
          id: Identifier.ascending("collab_agent"),
          sessionId: session.id,
          parentAgentId: controllerId,
          name: "Research Main",
          projectId: Instance.project.id,
          rootAgentId: controllerId,
          subagentType: "research",
          spec: { initialPrompt: "research", policy: { timeout_ms: 1 } },
        })
        let release: ((value: never) => void) | undefined
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(
          (() => new Promise((resolve) => (release = resolve)) as never) as unknown as typeof SessionPrompt.prompt,
        )

        try {
          const loop = CollabLoop.start(main.id)
          const deadline = Date.now() + 1000
          while (!release && Date.now() < deadline) await Bun.sleep(5)
          expect(release).toBeDefined()
          await Bun.sleep(10)
          expect(CollabAgentNode.load(main.id)).toMatchObject({ status: "running", error: null })
          release!({ info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] } as never)
          await loop
          expect(CollabAgentNode.load(main.id).error?.code).not.toBe("TIMEOUT")
        } finally {
          prompt.mockRestore()
        }
      },
    })
  })

  test("a stale recovery guard cannot fail a resumed peer", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await tree()
        const waiting = CollabAgentNode.transition(item.id, "waiting_interaction", { phase: "awaiting_children" })
        CollabAgentNode.transition(item.id, "running", { phase: "main_loop" })

        await CollabLoop.fail(
          item.id,
          { code: "ORPHANED_WAIT", message: "stale recovery" },
          {
            runId: waiting.run_id,
            parentId: waiting.parent_agent_id,
            status: waiting.status,
            timeUpdated: waiting.time_updated,
          },
        )

        expect(CollabAgentNode.load(item.id).status).toBe("running")
        expect(CollabMessage.list(item.parentId, { kind: "child_failed" })).toHaveLength(0)
      },
    })
  })

  test("a failure lock cannot be overwritten by completion", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await tree()
        const child = CollabAgentNode.transition(item.id, "running", {
          error: { code: "PROVIDER_API", message: "provider failed" },
        })

        expect(
          CollabAgentNode.finish({
            id: child.id,
            runId: child.run_id,
            parentId: child.parent_agent_id,
            status: "completed",
            phase: "main_loop",
            timeEnded: Date.now(),
          }),
        ).toBeUndefined()
        expect(CollabAgentNode.load(item.id).status).toBe("running")
        expect(CollabAgentNode.load(item.id).error?.code).toBe("PROVIDER_API")
      },
    })
  })

  test("transition cannot revive a terminal peer", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await tree()
        CollabAgentNode.transition(item.id, "failed", {
          error: { code: "LOOP_CRASH", message: "failed" },
          timeEnded: Date.now(),
        })

        expect(() => CollabAgentNode.transition(item.id, "running")).toThrow()
        expect(CollabAgentNode.load(item.id).status).toBe("failed")
      },
    })
  })

  test("pending questions reject when their turn is aborted", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const abort = new AbortController()
        const pending = Question.ask({
          sessionID: "session",
          questions: [{ question: "Continue?", header: "Continue", options: [] }],
          signal: abort.signal,
        })
        abort.abort()
        await expect(pending).rejects.toBeInstanceOf(Question.RejectedError)
        expect((await Question.list()).filter((item) => item.sessionID === "session")).toHaveLength(0)
      },
    })
  })

  test("pending permissions reject when their turn is aborted", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const abort = new AbortController()
        const pending = PermissionNext.ask({
          sessionID: "session",
          permission: "tool",
          patterns: ["*"],
          metadata: {},
          always: ["*"],
          ruleset: [{ permission: "tool", pattern: "*", action: "ask" }],
          signal: abort.signal,
        })
        abort.abort()
        await expect(pending).rejects.toBeInstanceOf(PermissionNext.RejectedError)
        expect((await PermissionNext.list()).filter((item) => item.sessionID === "session")).toHaveLength(0)
      },
    })
  })
})
