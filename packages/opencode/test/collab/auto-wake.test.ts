import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { LLM } from "../../src/session/llm"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { CollabMessage } from "../../src/collab/message"
import { Collab } from "../../src/collab"
import { CollabAutoWake } from "../../src/collab/auto-wake"
import { CollabEvent } from "../../src/collab/events"
import { CollabLoop } from "../../src/collab/loop"
import { CollabDelivery } from "../../src/collab/delivery"
import { CollabSupervisor } from "../../src/collab/supervisor"
import { buildChildDonePart, finalizeParts } from "../../src/collab/return-parts"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

// This file intentionally KEEPS auto-wake enabled to observe transitions,
// but we never invoke SessionPrompt with a real model — we rely on the fact
// that the prompt call will fail fast and be swallowed; the status
// transitions around it are what we verify.
CollabAutoWake.setEnabled(true)

async function tree(title: string) {
  const session = await Session.create({ title: `${title}-root` })
  const root = Identifier.ascending("collab_agent")
  CollabAgentNode.create({
    id: root,
    sessionId: session.id,
    parentAgentId: null,
    name: "root",
    projectId: Instance.project.id,
    rootAgentId: root,
    subagentType: "general",
    spec: { initialPrompt: "root" },
  })
  CollabAgentNode.transition(root, "running", { phase: "main_loop" })

  const childSession = await Session.create({ parentID: session.id, title: `${title}-child` })
  const child = Identifier.ascending("collab_agent")
  const info = CollabAgentNode.create({
    id: child,
    sessionId: childSession.id,
    parentAgentId: root,
    name: "child",
    projectId: Instance.project.id,
    rootAgentId: root,
    subagentType: "general",
    spec: { initialPrompt: "child" },
  })
  return { session, root, child: info }
}

describe("CollabAutoWake blocks root on active children", () => {
  test("queues a remote task terminal event while busy and drives it when idle", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()
        const session = await Session.create({ title: "remote-task-wake-root" })
        const id = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id,
          sessionId: session.id,
          parentAgentId: null,
          name: "root",
          projectId: Instance.project.id,
          rootAgentId: id,
          subagentType: "general",
          spec: { initialPrompt: "root" },
        })
        CollabAgentNode.transition(id, "running", { phase: "main_loop" })
        SessionStatus.set(session.id, { type: "busy" })

        let turns = 0
        CollabAutoWake.setDriveTurnOverrideForTesting(async (agentId) => {
          turns++
          CollabMessage.drain(agentId)
        })
        try {
          await CollabMessage.post({
            recipientAgentId: id,
            senderAgentId: null,
            kind: "remote_task_terminal",
            payload: {
              taskId: "task-1",
              expId: "exp-1",
              kind: "experiment_run",
              title: "Train model",
              status: "finished",
              logPath: "/tmp/task.log",
              errorMessage: null,
            },
          })
          await new Promise((resolve) => setTimeout(resolve, 20))
          expect(turns).toBe(0)
          expect(CollabMessage.hasPendingWakeMsg(id)).toBe(true)

          SessionStatus.set(session.id, { type: "idle" })
          await new Promise((resolve) => setTimeout(resolve, 20))
          expect(turns).toBe(1)
          expect(CollabMessage.hasPendingWakeMsg(id)).toBe(false)
        } finally {
          CollabAutoWake.setDriveTurnOverrideForTesting(undefined)
        }
      },
    })
  })

  test("busy child starts its loop for queued resume prompt when it becomes idle", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()

        const rootSession = await Session.create({ title: "resume-busy-root" })
        const rootId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: rootId,
          sessionId: rootSession.id,
          parentAgentId: null,
          name: "root",
          projectId: Instance.project.id,
          rootAgentId: rootId,
          subagentType: "general",
          spec: { initialPrompt: "root" },
        })
        CollabAgentNode.transition(rootId, "running", { phase: "main_loop" })

        const childSession = await Session.create({ parentID: rootSession.id, title: "resume-busy-child" })
        const childId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: childId,
          sessionId: childSession.id,
          parentAgentId: rootId,
          name: "child",
          projectId: Instance.project.id,
          rootAgentId: rootId,
          subagentType: "general",
          spec: { initialPrompt: "child" },
        })
        CollabAgentNode.transition(childId, "running", { phase: "main_loop" })
        SessionStatus.set(childSession.id, { type: "busy" })

        let direct = 0
        CollabAutoWake.setDriveTurnOverrideForTesting(async (id) => {
          if (id === childId) direct++
        })
        let done!: () => void
        const waited = new Promise<void>((resolve) => {
          done = resolve
        })
        const off = Bus.subscribe(CollabEvent.MessageConsumed, (e) => {
          if (e.properties.recipientAgentId !== childId || e.properties.kind !== "user_input") return
          done()
        })
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(
          (async (input: SessionPrompt.PromptInput) =>
            ({
              info: { role: "assistant", parentID: input.messageID },
              parts: [],
            }) as never) as unknown as typeof SessionPrompt.prompt,
        )

        try {
          await Collab.resume({ agentId: childId, prompt: "new instruction" })
          expect(CollabMessage.hasPendingWakeMsg(childId)).toBe(true)

          SessionStatus.set(childSession.id, { type: "idle" })
          await Promise.race([
            waited,
            new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for child wake")), 1000)),
          ])

          expect(direct).toBe(0)
          expect(CollabMessage.hasPendingWakeMsg(childId)).toBe(false)
        } finally {
          off()
          prompt.mockRestore()
          CollabAutoWake.setDriveTurnOverrideForTesting(undefined)
          Collab.runtime().abort(childId)
        }
      },
    })
  })

  test("root reports outstanding async work for active children and pending wake messages", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()

        const rootSession = await Session.create({ title: "async-work-root" })
        const rootId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: rootId,
          sessionId: rootSession.id,
          parentAgentId: null,
          name: "root",
          projectId: Instance.project.id,
          rootAgentId: rootId,
          subagentType: "general",
          spec: { initialPrompt: "x" },
        })
        CollabAgentNode.transition(rootId, "running", { phase: "main_loop" })

        expect(Collab.hasOutstandingAsyncWork(rootSession.id)).toBe(false)

        const childSession = await Session.create({ parentID: rootSession.id, title: "async-work-child" })
        const childId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: childId,
          sessionId: childSession.id,
          parentAgentId: rootId,
          name: "child",
          projectId: Instance.project.id,
          rootAgentId: rootId,
          subagentType: "general",
          spec: { initialPrompt: "y" },
        })

        expect(Collab.hasOutstandingAsyncWork(rootSession.id)).toBe(true)

        SessionStatus.set(rootSession.id, { type: "busy" })
        CollabAgentNode.transition(childId, "completed", { phase: "main_loop", timeEnded: Date.now() })
        await CollabMessage.post({
          recipientAgentId: rootId,
          senderAgentId: childId,
          kind: "child_done",
          payload: { childAgentId: childId, childName: "child", summary: "done" },
        })

        expect(CollabAgentNode.load(rootId).active_children).toBe(0)
        expect(Collab.hasOutstandingAsyncWork(rootSession.id)).toBe(true)

        const claimed = CollabMessage.drain(rootId)
        CollabMessage.ack(claimed)
        expect(Collab.hasOutstandingAsyncWork(rootSession.id)).toBe(false)
      },
    })
  })

  test("root with active_children transitions to blocked_on_children on SessionStatus idle", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()

        const rootSession = await Session.create({ title: "auto-wake-root-block" })
        const rootId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: rootId,
          sessionId: rootSession.id,
          parentAgentId: null,
          name: "root",
          projectId: Instance.project.id,
          rootAgentId: rootId,
          subagentType: "general",
          spec: { initialPrompt: "x" },
        })
        // Root starts running.
        CollabAgentNode.transition(rootId, "running", { phase: "main_loop" })

        // Simulate a child spawn having incremented active_children without
        // actually creating a child session (avoid LLM dependency).
        const childSession = await Session.create({ parentID: rootSession.id, title: "fake-child" })
        const childId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: childId,
          sessionId: childSession.id,
          parentAgentId: rootId,
          name: "child",
          projectId: Instance.project.id,
          rootAgentId: rootId,
          subagentType: "general",
          spec: { initialPrompt: "y" },
        })
        expect(CollabAgentNode.load(rootId).active_children).toBe(1)

        // Fire Idle for root session — AutoWake should notice active_children > 0 and flip to blocked.
        SessionStatus.set(rootSession.id, { type: "idle" })

        // SessionStatus.set publishes Bus synchronously; AutoWake subscribes and
        // kicks an async handler. Give it a tick.
        await new Promise((r) => setTimeout(r, 30))

        expect(CollabAgentNode.load(rootId).status).toBe("blocked_on_children")
      },
    })
  })
})

describe("CollabAutoWake confirms callback delivery", () => {
  test("drops a callback after its delivery refresh budget is exhausted", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.setEnabled(false)
        const item = await tree("callback-refresh-budget")
        CollabMessage.post({
          recipientAgentId: item.root,
          senderAgentId: item.child.id,
          kind: "child_done",
          payload: { childAgentId: item.child.id, childName: item.child.name, summary: "done" },
        })

        const prompt = async (messageID?: string) =>
          ({
            info: { role: "assistant", parentID: `${messageID}-unrelated` },
            parts: [],
          }) as unknown as MessageV2.WithParts

        try {
          for (let attempt = 0; attempt < 3; attempt++) {
            const claims = CollabMessage.drain(item.root)
            const messageID = (claims[0].payload_json as { deliveryMessageId: string }).deliveryMessageId
            await expect(
              CollabDelivery.deliver({
                node: CollabAgentNode.load(item.root),
                msgs: claims,
                messageID,
                match: () => true,
                prompt,
              }),
            ).rejects.toBeInstanceOf(CollabDelivery.Stale)
            CollabMessage.retry(claims, false)
          }

          CollabMessage.post({
            recipientAgentId: item.root,
            senderAgentId: null,
            kind: "remote_task_terminal",
            payload: {
              taskId: "fresh-task",
              expId: "exp",
              kind: "experiment_run",
              title: "fresh",
              status: "finished",
              logPath: null,
              errorMessage: null,
            },
          })
          const claims = CollabMessage.drain(item.root)
          const messageID = (claims[0].payload_json as { deliveryMessageId: string }).deliveryMessageId
          const error = await CollabDelivery.deliver({
            node: CollabAgentNode.load(item.root),
            msgs: claims,
            messageID,
            match: () => true,
            prompt,
          }).catch((err) => err)
          expect(error).toBeInstanceOf(CollabDelivery.Exhausted)
          if (!(error instanceof CollabDelivery.Exhausted)) throw error
          expect(error.claims).toHaveLength(1)
          CollabMessage.drop(error.claims)
          CollabMessage.retry(
            claims.filter((msg) => !error.claims.some((claim) => claim.id === msg.id)),
            false,
          )

          expect(CollabMessage.list(item.root, { kind: "child_done" })[0]?.status).toBe("dropped")
          expect(CollabMessage.list(item.root, { kind: "remote_task_terminal" })[0]?.status).toBe("pending")
          CollabMessage.drop(CollabMessage.drain(item.root))
        } finally {
          CollabAutoWake.setEnabled(true)
        }
      },
    })
  })

  test("latches root cancellation before scanning children", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()
        const item = await tree("cancel-latch")
        const session = await Session.create({ title: "late child" })
        const original = CollabSupervisor.cancelChildren
        let failure: unknown
        const cancel = spyOn(CollabSupervisor, "cancelChildren").mockImplementation((agentId, payload) => {
          if (agentId === item.root) {
            try {
              CollabAgentNode.create({
                id: Identifier.ascending("collab_agent"),
                sessionId: session.id,
                parentAgentId: item.root,
                name: "late child",
                projectId: Instance.project.id,
                rootAgentId: item.root,
                subagentType: "general",
                spec: { initialPrompt: "late" },
                activeParent: true,
                parentGeneration: CollabAgentNode.generation(CollabAgentNode.load(item.root).spec),
              })
            } catch (error) {
              failure = error
            }
          }
          return original(agentId, payload)
        })

        try {
          CollabMessage.post({
            recipientAgentId: item.root,
            kind: "cancel",
            payload: { reason: "stop", initiator: "user" },
          })
          for (let i = 0; i < 100 && CollabAgentNode.load(item.root).status !== "canceled"; i++) await Bun.sleep(10)

          expect(CollabAgentNode.load(item.root).status).toBe("canceled")
          expect(failure).toBeInstanceOf(Error)
          expect((failure as Error).message).toContain("terminating")
          expect(CollabAgentNode.loadBySessionId(session.id)).toBeUndefined()
        } finally {
          cancel.mockRestore()
        }
      },
    })
  })

  test("interrupts an in-flight root turn from the same lifecycle", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()
        const item = await tree("cancel-root-turn")
        let finish: ((value: Awaited<ReturnType<typeof SessionPrompt.prompt>>) => void) | undefined
        let messageID: string | undefined
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(((input: SessionPrompt.PromptInput) => {
          messageID = input.messageID
          return new Promise((resolve) => (finish = resolve))
        }) as unknown as typeof SessionPrompt.prompt)
        const cancel = spyOn(SessionPrompt, "cancel")

        try {
          CollabAgentNode.finish({
            id: item.child.id,
            runId: item.child.run_id,
            parentId: item.root,
            status: "completed",
            phase: "main_loop",
            result: { summary: "done" },
            timeEnded: Date.now(),
            report: {
              kind: "child_done",
              payload: { childAgentId: item.child.id, childName: item.child.name, summary: "done" },
            },
          })
          for (let i = 0; i < 100 && !finish; i++) await Bun.sleep(5)
          expect(finish).toBeDefined()

          await Collab.cancel(item.root, "stop current root")
          expect(cancel).toHaveBeenCalledWith(item.session.id)
          finish!({
            info: {
              role: "assistant",
              parentID: messageID,
              error: new MessageV2.AbortedError({ message: "The operation was aborted." }).toObject(),
            },
            parts: [],
          } as never)

          for (let i = 0; i < 300 && CollabAgentNode.load(item.root).status !== "canceled"; i++) await Bun.sleep(10)
          expect(CollabAgentNode.load(item.root)).toMatchObject({
            status: "canceled",
            error: { code: "CANCELED", message: "stop current root" },
          })
        } finally {
          cancel.mockRestore()
          prompt.mockRestore()
        }
      },
    })
  })

  for (const kind of ["error", "stale"] as const) {
    test(`retries a callback after an ${kind} assistant result`, async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          CollabAutoWake.ensure()
          const item = await tree(`callback-${kind}`)
          let turns = 0
          const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
            input: SessionPrompt.PromptInput,
          ) => {
            turns++
            return {
              info: {
                role: "assistant",
                parentID: turns === 1 && kind === "stale" ? Identifier.ascending("message") : input.messageID,
                error: turns === 1 && kind === "error" ? { name: "APIError", data: { message: "retry" } } : undefined,
              },
              parts: [],
            } as never
          }) as unknown as typeof SessionPrompt.prompt)

          try {
            CollabAgentNode.finish({
              id: item.child.id,
              runId: item.child.run_id,
              parentId: item.root,
              status: "completed",
              phase: "main_loop",
              result: { summary: "done" },
              timeEnded: Date.now(),
              report: {
                kind: "child_done",
                payload: { childAgentId: item.child.id, childName: item.child.name, summary: "done" },
              },
            })

            for (let i = 0; i < 300 && turns < 2; i++) await Bun.sleep(10)
            expect(turns).toBe(2)
            expect(CollabMessage.list(item.root, { kind: "child_done" }).map((msg) => msg.status)).toEqual(["consumed"])
          } finally {
            prompt.mockRestore()
          }
        },
      })
    })
  }

  test("canceled child callbacks do not fail-fast the root", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()
        const item = await tree("callback-canceled")
        let callback: SessionPrompt.PromptInput | undefined
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: SessionPrompt.PromptInput) => {
          callback = input
          return { info: { role: "assistant", parentID: input.messageID }, parts: [] } as never
        }) as unknown as typeof SessionPrompt.prompt)

        try {
          CollabAgentNode.finish({
            id: item.child.id,
            runId: item.child.run_id,
            parentId: item.root,
            status: "canceled",
            phase: "main_loop",
            error: { code: "CANCELED", message: "no longer needed" },
            timeEnded: Date.now(),
            report: {
              kind: "child_failed",
              payload: {
                childAgentId: item.child.id,
                childName: item.child.name,
                reason: "canceled",
                message: "no longer needed",
              },
            },
          })

          for (let i = 0; i < 300; i++) {
            if (CollabMessage.list(item.root, { kind: "child_failed" })[0]?.status === "consumed") break
            await Bun.sleep(10)
          }

          const root = CollabAgentNode.load(item.root)
          expect(root.status).not.toBe("failed")
          expect(root.error).toBeNull()
          expect(callback?.parts).toContainEqual(
            expect.objectContaining({
              type: "collab_return",
              kind: "child_failed",
              childAgentId: item.child.id,
              payload: { reason: "canceled" },
            }),
          )
          expect(CollabMessage.list(item.root, { kind: "child_failed" })[0]?.status).toBe("consumed")
        } finally {
          prompt.mockRestore()
        }
      },
    })
  })

  test("recovers a callback when delivery crashes after drain", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()
        const item = await tree("callback-crash")
        const original = CollabLoop.collapseProgress
        let crashed = false
        const collapse = spyOn(CollabLoop, "collapseProgress").mockImplementation((msgs, strategy) => {
          if (!crashed) {
            crashed = true
            throw new Error("delivery crashed")
          }
          return original(msgs, strategy)
        })
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(
          (async (input: SessionPrompt.PromptInput) =>
            ({
              info: { role: "assistant", parentID: input.messageID },
              parts: [],
            }) as never) as unknown as typeof SessionPrompt.prompt,
        )

        try {
          CollabAgentNode.finish({
            id: item.child.id,
            runId: item.child.run_id,
            parentId: item.root,
            status: "completed",
            phase: "main_loop",
            result: { summary: "done" },
            timeEnded: Date.now(),
            report: {
              kind: "child_done",
              payload: { childAgentId: item.child.id, childName: item.child.name, summary: "done" },
            },
          })

          for (let i = 0; i < 300; i++) {
            if (CollabMessage.list(item.root, { kind: "child_done" })[0]?.status === "consumed") break
            await Bun.sleep(10)
          }
          expect(crashed).toBe(true)
          expect(CollabMessage.list(item.root, { kind: "child_done" })[0]?.status).toBe("consumed")
        } finally {
          prompt.mockRestore()
          collapse.mockRestore()
        }
      },
    })
  })

  test("refreshes a durable callback after an unrelated assistant", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()
        CollabAutoWake.setEnabled(false)
        const item = await tree("callback-durable-stale")
        const prior = await SessionPrompt.prompt({
          sessionID: item.session.id,
          agent: "general",
          model: { providerID: "opencode", modelID: "kimi-k2.5-free" },
          noReply: true,
          parts: [{ type: "text", text: "previous message" }],
        })
        CollabAgentNode.finish({
          id: item.child.id,
          runId: item.child.run_id,
          parentId: item.root,
          status: "completed",
          phase: "main_loop",
          result: { summary: "done" },
          timeEnded: Date.now(),
          report: {
            kind: "child_done",
            payload: { childAgentId: item.child.id, childName: item.child.name, summary: "done" },
          },
        })
        const callback = CollabMessage.list(item.root, { kind: "child_done" })[0]
        const payload = callback.payload_json as {
          childAgentId: string
          childName: string
          summary: string
          deliveryMessageId: string
        }
        await SessionPrompt.prompt({
          sessionID: item.session.id,
          messageID: payload.deliveryMessageId,
          agent: "general",
          model: { providerID: "opencode", modelID: "kimi-k2.5-free" },
          noReply: true,
          parts: finalizeParts([buildChildDonePart(payload)]),
        })
        await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: item.session.id,
          role: "assistant",
          parentID: prior.info.id,
          mode: "general",
          agent: "general",
          modelID: "kimi-k2.5-free",
          providerID: "opencode",
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now(), completed: Date.now() },
          finish: "stop",
        })

        let turns = 0
        const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
          if (input.small) {
            return {
              text: Promise.resolve("title"),
              fullStream: (async function* () {})(),
            } as unknown as Awaited<ReturnType<typeof LLM.stream>>
          }
          turns++
          return {
            fullStream: (async function* () {
              yield { type: "start" }
              yield {
                type: "finish-step",
                finishReason: "stop",
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              }
              yield { type: "finish" }
            })(),
          } as unknown as Awaited<ReturnType<typeof LLM.stream>>
        })

        try {
          CollabAutoWake.setEnabled(true)
          CollabAutoWake.wake(item.session.id)
          for (let i = 0; i < 300; i++) {
            if (CollabMessage.list(item.root, { kind: "child_done" })[0]?.status === "consumed") break
            await Bun.sleep(10)
          }
          expect(turns).toBe(1)
          expect(CollabMessage.list(item.root, { kind: "child_done" })[0]?.status).toBe("consumed")
          expect(
            (
              CollabMessage.list(item.root, { kind: "child_done" })[0]?.payload_json as {
                deliveryMessageId?: string
              }
            ).deliveryMessageId,
          ).not.toBe(payload.deliveryMessageId)
          expect(
            await MessageV2.get({ sessionID: item.session.id, messageID: payload.deliveryMessageId }).catch(
              () => undefined,
            ),
          ).toBeUndefined()
        } finally {
          stream.mockRestore()
          CollabAutoWake.setEnabled(true)
        }
      },
    })
  })

  test("accepts a successful synthetic continuation of a callback", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()
        CollabAutoWake.setEnabled(false)
        const item = await tree("callback-synthetic")
        CollabAgentNode.finish({
          id: item.child.id,
          runId: item.child.run_id,
          parentId: item.root,
          status: "completed",
          phase: "main_loop",
          result: { summary: "done" },
          timeEnded: Date.now(),
          report: {
            kind: "child_done",
            payload: { childAgentId: item.child.id, childName: item.child.name, summary: "done" },
          },
        })
        const callback = CollabMessage.list(item.root, { kind: "child_done" })[0]
        const payload = callback.payload_json as {
          childAgentId: string
          childName: string
          summary: string
          deliveryMessageId: string
        }
        await SessionPrompt.prompt({
          sessionID: item.session.id,
          messageID: payload.deliveryMessageId,
          agent: "general",
          model: { providerID: "opencode", modelID: "kimi-k2.5-free" },
          noReply: true,
          parts: finalizeParts([buildChildDonePart(payload)]),
        })
        await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: item.session.id,
          role: "assistant",
          parentID: payload.deliveryMessageId,
          mode: "general",
          agent: "general",
          modelID: "kimi-k2.5-free",
          providerID: "opencode",
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now(), completed: Date.now() },
          finish: "tool-calls",
        })
        const user = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: item.session.id,
          role: "user",
          agent: "general",
          model: { providerID: "opencode", modelID: "kimi-k2.5-free" },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: item.session.id,
          messageID: user.id,
          type: "text",
          text: "",
          synthetic: true,
          ignored: true,
          metadata: { originMessageID: payload.deliveryMessageId },
        })
        await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: item.session.id,
          role: "assistant",
          parentID: user.id,
          mode: "general",
          agent: "general",
          modelID: "kimi-k2.5-free",
          providerID: "opencode",
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now(), completed: Date.now() },
          finish: "stop",
        })
        let prompts = 0
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: SessionPrompt.PromptInput) => {
          if (input.sessionID === item.session.id) prompts++
          return {} as never
        }) as unknown as typeof SessionPrompt.prompt)

        try {
          CollabAutoWake.setEnabled(true)
          CollabAutoWake.wake(item.session.id)
          for (let i = 0; i < 100; i++) {
            if (CollabMessage.list(item.root, { kind: "child_done" })[0]?.status === "consumed") break
            await Bun.sleep(10)
          }
          expect(prompts).toBe(0)
          expect(CollabMessage.list(item.root, { kind: "child_done" })[0]?.status).toBe("consumed")
        } finally {
          prompt.mockRestore()
          CollabAutoWake.setEnabled(true)
        }
      },
    })
  })

  test("does not partially refresh a changed delivery batch", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()
        CollabAutoWake.setEnabled(false)
        const session = await Session.create({ title: "callback-redeliver-atomic" })
        const root = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: root,
          sessionId: session.id,
          parentAgentId: null,
          name: "root",
          projectId: Instance.project.id,
          rootAgentId: root,
          subagentType: "general",
          spec: { initialPrompt: "root" },
        })
        for (const taskId of ["first", "second"]) {
          CollabMessage.post({
            recipientAgentId: root,
            senderAgentId: null,
            kind: "remote_task_terminal",
            payload: {
              taskId,
              expId: "exp",
              kind: "experiment_run",
              title: taskId,
              status: "finished",
              logPath: null,
              errorMessage: null,
            },
          })
        }
        const claims = CollabMessage.drain(root)
        const before = (claims[0].payload_json as { deliveryMessageId: string }).deliveryMessageId
        CollabMessage.retry([claims[1]], false)

        try {
          expect(CollabMessage.redeliver(claims, Identifier.ascending("message"))).toBe(false)
          expect((CollabMessage.list(root)[0].payload_json as { deliveryMessageId: string }).deliveryMessageId).toBe(
            before,
          )
        } finally {
          CollabMessage.retry([claims[0]], false)
          CollabMessage.drop(CollabMessage.drain(root))
          CollabAutoWake.setEnabled(true)
        }
      },
    })
  })

  test("re-drives a callback posted during the final drive iteration", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()
        const session = await Session.create({ title: "callback-final-iteration" })
        const root = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: root,
          sessionId: session.id,
          parentAgentId: null,
          name: "root",
          projectId: Instance.project.id,
          rootAgentId: root,
          subagentType: "general",
          spec: { initialPrompt: "root" },
        })
        CollabAgentNode.transition(root, "running", { phase: "main_loop" })

        let turns = 0
        CollabAutoWake.setDriveTurnOverrideForTesting(async (agentId) => {
          turns++
          CollabMessage.drain(agentId)
          if (turns >= 65) return
          CollabMessage.post({
            recipientAgentId: root,
            senderAgentId: null,
            kind: "remote_task_terminal",
            payload: {
              taskId: `task-${turns + 1}`,
              expId: "exp",
              kind: "experiment_run",
              title: "task",
              status: "finished",
              logPath: null,
              errorMessage: null,
            },
          })
        })

        try {
          CollabMessage.post({
            recipientAgentId: root,
            senderAgentId: null,
            kind: "remote_task_terminal",
            payload: {
              taskId: "task-1",
              expId: "exp",
              kind: "experiment_run",
              title: "task",
              status: "finished",
              logPath: null,
              errorMessage: null,
            },
          })

          for (let i = 0; i < 300; i++) {
            if (turns >= 65 && !CollabMessage.hasOutstandingWakeMsg(root)) break
            await Bun.sleep(10)
          }
          expect(turns).toBeGreaterThanOrEqual(65)
          expect(CollabMessage.hasOutstandingWakeMsg(root)).toBe(false)
        } finally {
          CollabAutoWake.setDriveTurnOverrideForTesting(undefined)
        }
      },
    })
  })

  test("re-drives the direct inbox after a collab callback turn", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()
        const session = await Session.create({ title: "callback-cross-inbox" })
        const root = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: root,
          sessionId: session.id,
          parentAgentId: null,
          name: "root",
          projectId: Instance.project.id,
          rootAgentId: root,
          subagentType: "general",
          spec: { initialPrompt: "root" },
        })
        CollabAgentNode.transition(root, "running", { phase: "main_loop" })

        let turns = 0
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: SessionPrompt.PromptInput) => {
          turns++
          if (turns === 1) {
            CollabMessage.post({
              recipientAgentId: root,
              senderAgentId: null,
              kind: "session_remote_task_terminal",
              payload: {
                taskId: "direct-task",
                expId: "exp",
                kind: "experiment_run",
                title: "task",
                status: "finished",
                logPath: null,
                errorMessage: null,
              },
            })
          }
          return { info: { role: "assistant", parentID: input.messageID }, parts: [] } as never
        }) as unknown as typeof SessionPrompt.prompt)

        try {
          CollabMessage.post({
            recipientAgentId: root,
            senderAgentId: null,
            kind: "remote_task_terminal",
            payload: {
              taskId: "collab-task",
              expId: "exp",
              kind: "experiment_run",
              title: "task",
              status: "finished",
              logPath: null,
              errorMessage: null,
            },
          })

          for (let i = 0; i < 300; i++) {
            if (
              turns >= 2 &&
              !CollabMessage.hasOutstandingWakeMsg(root) &&
              !CollabMessage.hasOutstanding(root, "session_remote_task_terminal")
            )
              break
            await Bun.sleep(10)
          }
          expect(turns).toBe(2)
          expect(CollabMessage.hasOutstandingWakeMsg(root)).toBe(false)
          expect(CollabMessage.hasOutstanding(root, "session_remote_task_terminal")).toBe(false)
        } finally {
          prompt.mockRestore()
        }
      },
    })
  })

  test("drops a direct callback after its delivery refresh budget is exhausted", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()
        const session = await Session.create({ title: "direct-refresh-budget" })
        const root = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: root,
          sessionId: session.id,
          parentAgentId: null,
          name: "root",
          projectId: Instance.project.id,
          rootAgentId: root,
          subagentType: "general",
          spec: { initialPrompt: "root" },
        })
        CollabAgentNode.transition(root, "running", { phase: "main_loop" })
        let turns = 0
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
          turns++
          return {
            info: { role: "assistant", parentID: Identifier.ascending("message") },
            parts: [],
          } as never
        }) as unknown as typeof SessionPrompt.prompt)

        try {
          CollabMessage.post({
            recipientAgentId: root,
            senderAgentId: null,
            kind: "session_remote_task_terminal",
            payload: {
              taskId: "stale-direct-task",
              expId: "exp",
              kind: "experiment_run",
              title: "task",
              status: "failed",
              logPath: null,
              errorMessage: "failed",
            },
          })

          for (let i = 0; i < 500; i++) {
            const row = CollabMessage.list(root, { kind: "session_remote_task_terminal" })[0]
            if (row?.status === "dropped") break
            await Bun.sleep(10)
          }

          expect(CollabMessage.list(root, { kind: "session_remote_task_terminal" })[0]?.status).toBe("dropped")
          expect(turns).toBeGreaterThan(0)
          expect(turns).toBeLessThan(10)
        } finally {
          prompt.mockRestore()
        }
      },
    })
  })
})

describe("CollabAutoWake is robust under concurrent child completions", () => {
  test("multiple child_done posted concurrently are all drained (inflight loop re-checks)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()

        const rootSession = await Session.create({ title: "race-root" })
        const rootId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: rootId,
          sessionId: rootSession.id,
          parentAgentId: null,
          name: "root",
          projectId: Instance.project.id,
          rootAgentId: rootId,
          subagentType: "general",
          spec: { initialPrompt: "x" },
        })
        CollabAgentNode.transition(rootId, "running", { phase: "main_loop" })

        // Pre-create 5 fake children so active_children reflects reality (5).
        const childIds: string[] = []
        for (let i = 0; i < 5; i++) {
          const cs = await Session.create({ parentID: rootSession.id, title: `c${i}` })
          const cid = Identifier.ascending("collab_agent")
          CollabAgentNode.create({
            id: cid,
            sessionId: cs.id,
            parentAgentId: rootId,
            name: `c${i}`,
            projectId: Instance.project.id,
            rootAgentId: rootId,
            subagentType: "general",
            spec: { initialPrompt: "" },
          })
          childIds.push(cid)
        }
        expect(CollabAgentNode.load(rootId).active_children).toBe(5)

        // Replace the real driveTurn (which would call SessionPrompt and hang in tests)
        // with a stub that:
        //   1. drains pending wake messages
        //   2. yields a microtask so additional Bus-triggered posts can land during the "turn"
        //   3. returns
        // This simulates a real LLM turn in miniature — it lets us verify the inflight
        // loop in maybeWakeOrBlock picks up messages that arrive *during* a driveTurn.
        let turnCount = 0
        CollabAutoWake.setDriveTurnOverrideForTesting(async (agentId) => {
          turnCount++
          CollabMessage.drain(agentId)
          await new Promise((r) => setTimeout(r, 10))
        })

        try {
          // Session must be idle so auto-wake will engage.
          SessionStatus.set(rootSession.id, { type: "idle" })

          // Post the first 3 eagerly...
          await Promise.all(
            childIds.slice(0, 3).map((cid, i) =>
              CollabMessage.post({
                recipientAgentId: rootId,
                senderAgentId: cid,
                kind: "child_done",
                payload: { childAgentId: cid, childName: `c${i}`, summary: `done ${i}` },
              }),
            ),
          )
          // ...then post 2 more after a microtask so they land WHILE the first
          // driveTurn is mid-flight (inside its setTimeout(10)):
          await new Promise((r) => setTimeout(r, 2))
          await Promise.all(
            childIds.slice(3).map((cid, i) =>
              CollabMessage.post({
                recipientAgentId: rootId,
                senderAgentId: cid,
                kind: "child_done",
                payload: { childAgentId: cid, childName: `c${i + 3}`, summary: `done ${i + 3}` },
              }),
            ),
          )

          // Wait for the inflight loop to settle.
          const deadline = Date.now() + 2000
          let pendingDone = 5
          while (Date.now() < deadline) {
            const msgs = CollabMessage.list(rootId, { kind: "child_done", limit: 1000 })
            pendingDone = msgs.filter((m) => m.status === "pending").length
            if (pendingDone === 0) break
            await new Promise((r) => setTimeout(r, 20))
          }
          expect(pendingDone).toBe(0)
          // active_children should have drained to 0 via the atomic decrement in post().
          expect(CollabAgentNode.load(rootId).active_children).toBe(0)
          // The loop must have taken AT LEAST 2 turns (the 2 late posts arrived during turn 1 → trigger turn 2).
          expect(turnCount).toBeGreaterThanOrEqual(2)
        } finally {
          CollabAutoWake.setDriveTurnOverrideForTesting(undefined)
        }
      },
    })
  })
})

describe("CollabAutoWake delegates non-root agents to CollabLoop", () => {
  test("redelivers callbacks whose message IDs were overtaken by an active turn", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()
        CollabAutoWake.setEnabled(false)
        const item = await tree("stale-non-root-callback")
        CollabAgentNode.transition(item.child.id, "running", { phase: "main_loop" })

        const workerSession = await Session.create({ parentID: item.child.session_id, title: "worker" })
        const worker = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: worker,
          sessionId: workerSession.id,
          parentAgentId: item.child.id,
          name: "worker",
          projectId: Instance.project.id,
          rootAgentId: item.root,
          subagentType: "general",
          spec: { initialPrompt: "wait" },
        })

        for (const taskId of ["late-b", "late-c"]) {
          CollabMessage.post({
            recipientAgentId: item.child.id,
            senderAgentId: null,
            runId: item.child.run_id,
            kind: "remote_task_terminal",
            payload: {
              taskId,
              expId: "exp",
              kind: "resource_download",
              title: taskId,
              status: "finished",
              logPath: null,
              errorMessage: null,
            },
          })
        }
        const before = CollabMessage.list(item.child.id, { kind: "remote_task_terminal" })
        const old = before.map((msg) => (msg.payload_json as { deliveryMessageId: string }).deliveryMessageId)

        const prior = await SessionPrompt.prompt({
          sessionID: item.child.session_id,
          agent: "general",
          model: { providerID: "opencode", modelID: "kimi-k2.5-free" },
          noReply: true,
          parts: [{ type: "text", text: "active turn" }],
        })
        const assistant = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: item.child.session_id,
          role: "assistant",
          parentID: prior.info.id,
          mode: "general",
          agent: "general",
          modelID: "kimi-k2.5-free",
          providerID: "opencode",
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now(), completed: Date.now() },
          finish: "stop",
        })
        expect(old.every((id) => id < assistant.id)).toBe(true)

        let turns = 0
        const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
          if (input.small) {
            return {
              text: Promise.resolve("title"),
              fullStream: (async function* () {})(),
            } as unknown as Awaited<ReturnType<typeof LLM.stream>>
          }
          turns++
          return {
            fullStream: (async function* () {
              yield { type: "start" }
              yield {
                type: "finish-step",
                finishReason: "stop",
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              }
              yield { type: "finish" }
            })(),
          } as unknown as Awaited<ReturnType<typeof LLM.stream>>
        })
        const run = CollabLoop.start(item.child.id)

        try {
          for (let i = 0; i < 300; i++) {
            const rows = CollabMessage.list(item.child.id, { kind: "remote_task_terminal" })
            if (rows.length === 2 && rows.every((msg) => msg.status === "consumed")) break
            await Bun.sleep(10)
          }

          const rows = CollabMessage.list(item.child.id, { kind: "remote_task_terminal" })
          expect(rows.map((msg) => msg.status)).toEqual(["consumed", "consumed"])
          const ids = rows.map((msg) => (msg.payload_json as { deliveryMessageId: string }).deliveryMessageId)
          expect(new Set(ids).size).toBe(1)
          expect(old).not.toContain(ids[0])
          expect(turns).toBe(1)

          const user = await MessageV2.get({ sessionID: item.child.session_id, messageID: ids[0] })
          expect(user.parts.filter((part) => part.type === "collab_return")).toHaveLength(2)
          const messages = await Session.messages({ sessionID: item.child.session_id })
          expect(
            messages.some((msg) => msg.info.role === "assistant" && !msg.info.error && msg.info.parentID === ids[0]),
          ).toBe(true)
          for (const id of old) {
            expect(
              await MessageV2.get({ sessionID: item.child.session_id, messageID: id }).catch(() => undefined),
            ).toBeUndefined()
          }
        } finally {
          Collab.runtime().abort(item.child.id)
          await run
          stream.mockRestore()
          CollabAutoWake.setEnabled(true)
        }
      },
    })
  })

  test("posting child_done to a NON-root parent starts its loop", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        CollabAutoWake.ensure()

        // supra-root (we never actually drive this via AutoWake for this test)
        const supraSession = await Session.create({ title: "supra" })
        const supraId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: supraId,
          sessionId: supraSession.id,
          parentAgentId: null,
          name: "supra",
          projectId: Instance.project.id,
          rootAgentId: supraId,
          subagentType: "general",
          spec: { initialPrompt: "x" },
        })

        // non-root parent
        const parentSession = await Session.create({ parentID: supraSession.id, title: "mid" })
        const parentId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: parentId,
          sessionId: parentSession.id,
          parentAgentId: supraId,
          name: "mid",
          projectId: Instance.project.id,
          rootAgentId: supraId,
          subagentType: "general",
          spec: { initialPrompt: "y" },
        })

        // child of the mid parent
        const childSession = await Session.create({ parentID: parentSession.id, title: "child" })
        const childId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: childId,
          sessionId: childSession.id,
          parentAgentId: parentId,
          name: "child",
          projectId: Instance.project.id,
          rootAgentId: supraId,
          subagentType: "general",
          spec: { initialPrompt: "z" },
        })

        let direct = 0
        CollabAutoWake.setDriveTurnOverrideForTesting(async (id) => {
          if (id === parentId) direct++
          CollabMessage.drain(id)
        })

        // Count consumed events; non-root agents should drain through CollabLoop,
        // not AutoWake.driveTurn.
        let mpCount = 0
        const unsub = Bus.subscribe(CollabEvent.MessageConsumed, (e) => {
          if (e.properties.recipientAgentId === parentId) mpCount++
        })
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(
          (async (input: SessionPrompt.PromptInput) =>
            ({
              info: { role: "assistant", parentID: input.messageID },
              parts: [],
            }) as never) as unknown as typeof SessionPrompt.prompt,
        )

        try {
          await CollabMessage.post({
            recipientAgentId: parentId,
            senderAgentId: childId,
            kind: "child_done",
            payload: { childAgentId: childId, childName: "child", summary: "done" },
          })

          await new Promise((r) => setTimeout(r, 80))
        } finally {
          unsub()
          prompt.mockRestore()
          CollabAutoWake.setDriveTurnOverrideForTesting(undefined)
          Collab.runtime().abort(parentId)
        }

        expect(direct).toBe(0)
        expect(mpCount).toBe(1)
        expect(CollabMessage.hasPendingWakeMsg(parentId)).toBe(false)
      },
    })
  })
})
