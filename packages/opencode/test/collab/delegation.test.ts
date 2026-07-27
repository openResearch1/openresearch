import { describe, expect, spyOn, test } from "bun:test"
import path from "path"

import { Bus } from "../../src/bus"
import { Collab } from "../../src/collab"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { CollabAutoWake } from "../../src/collab/auto-wake"
import { CollabEvent } from "../../src/collab/events"
import { CollabLoop } from "../../src/collab/loop"
import { CollabMessage } from "../../src/collab/message"
import { CollabRecovery } from "../../src/collab/recovery"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"

const root = path.join(__dirname, "../..")
Log.init({ print: false })
CollabAutoWake.setEnabled(false)

async function node(input: { name: string; parent?: string; root?: string; status?: "idle" | "pending" }) {
  const session = await Session.create({ title: `collab-${input.name}-${Identifier.ascending("session")}` })
  const id = Identifier.ascending("collab_agent")
  return CollabAgentNode.create({
    id,
    sessionId: session.id,
    parentAgentId: input.parent ?? null,
    name: input.name,
    projectId: Instance.project.id,
    rootAgentId: input.root ?? id,
    subagentType: "general",
    spec: { initialPrompt: input.name },
    status: input.status,
  })
}

describe("Collab run correlation", () => {
  test("duplicate terminal reports decrement the parent only once", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const parent = await node({ name: "dedupe-parent" })
        const child = await node({ name: "dedupe-child", parent: parent.id, root: parent.id })
        expect(child.run_id).not.toBeNull()
        expect(CollabAgentNode.load(parent.id).active_children).toBe(1)
        const payload = { childAgentId: child.id, childName: child.name, summary: "done" }
        const done = CollabAgentNode.finish({
          id: child.id,
          runId: child.run_id,
          parentId: parent.id,
          status: "completed",
          phase: "main_loop",
          result: { summary: "done" },
          timeEnded: Date.now(),
          report: { kind: "child_done", payload },
        })
        expect(done?.status).toBe("completed")
        const first = CollabMessage.list(parent.id, { kind: "child_done" })[0].id
        const second = CollabMessage.post({
          recipientAgentId: parent.id,
          senderAgentId: child.id,
          runId: child.run_id,
          kind: "child_failed",
          payload: { childAgentId: child.id, childName: child.name, reason: "error", message: "late" },
        })

        expect(second).toBe(first)
        expect(CollabAgentNode.load(parent.id).active_children).toBe(0)
        expect(
          CollabMessage.list(parent.id).filter(
            (item) => item.sender_agent_id === child.id && ["child_done", "child_failed"].includes(item.kind),
          ),
        ).toHaveLength(1)
      },
    })
  })

  test("a second activation gets a new run and recovery ignores the old terminal", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const parent = await node({ name: "recovery-parent" })
        const child = await node({ name: "recovery-child", parent: parent.id, root: parent.id })
        const first = child.run_id
        CollabAgentNode.transition(child.id, "completed", { result: { summary: "first" }, timeEnded: Date.now() })
        CollabMessage.post({
          recipientAgentId: parent.id,
          senderAgentId: child.id,
          runId: first,
          kind: "child_done",
          payload: { childAgentId: child.id, childName: child.name, summary: "first" },
        })

        const active = CollabAgentNode.activate(child.id)
        expect(active.run_id).not.toBe(first)
        CollabAgentNode.transition(child.id, "completed", { result: { summary: "second" }, timeEnded: Date.now() })
        await CollabRecovery.scan()

        const reports = CollabMessage.list(parent.id).filter(
          (item) => item.sender_agent_id === child.id && ["child_done", "child_failed"].includes(item.kind),
        )
        expect(reports.map((item) => item.run_id)).toEqual([first, active.run_id])
        expect((reports[1].payload_json as { runId?: string }).runId).toBe(active.run_id!)
      },
    })
  })

  test("stale reports from a replaced run are dropped", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const parent = await node({ name: "stale-parent" })
        const child = await node({ name: "stale-child", parent: parent.id, root: parent.id })
        const old = child.run_id
        CollabAgentNode.transition(child.id, "completed", { timeEnded: Date.now() })
        const active = CollabAgentNode.activate(child.id)
        CollabAgentNode.recomputeActiveChildren(parent.id)

        expect(
          CollabMessage.post({
            recipientAgentId: parent.id,
            senderAgentId: child.id,
            runId: old,
            kind: "child_progress",
            payload: { childAgentId: child.id, childName: child.name, turn: 1, assistant_text: "late", tools: [] },
          }),
        ).toBeUndefined()
        expect(
          CollabMessage.post({
            recipientAgentId: parent.id,
            senderAgentId: child.id,
            runId: old,
            kind: "child_done",
            payload: { childAgentId: child.id, childName: child.name, summary: "late" },
          }),
        ).toBeUndefined()
        expect(
          await CollabMessage.postChildWaiting({
            agentId: child.id,
            rootAgentId: parent.id,
            recipientAgentId: parent.id,
            payload: {
              runId: old ?? undefined,
              childAgentId: child.id,
              childName: child.name,
              childSessionId: child.session_id,
            },
          }),
        ).toBeUndefined()
        expect(CollabMessage.list(parent.id).filter((item) => item.sender_agent_id === child.id)).toHaveLength(0)
        expect(CollabAgentNode.load(parent.id).active_children).toBe(1)
        expect(CollabAgentNode.load(child.id).run_id).toBe(active.run_id)
        expect(CollabAgentNode.load(child.id).status).toBe("running")
      },
    })
  })

  test("an old loop cannot complete a replacement run", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const parent = await node({ name: "loop-parent" })
        const child = await node({ name: "loop-child", parent: parent.id, root: parent.id })
        CollabAgentNode.transition(child.id, "running")
        let release: ((value: Awaited<ReturnType<typeof Session.messages>>) => void) | undefined
        const original = Session.messages
        const messages = spyOn(Session, "messages").mockImplementation(((input) => {
          if (input.sessionID !== child.session_id) return original(input)
          return new Promise((resolve) => (release = resolve))
        }) as typeof Session.messages)

        try {
          const loop = CollabLoop.start(child.id)
          const deadline = Date.now() + 1000
          while (!release && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
          expect(release).toBeDefined()

          CollabAgentNode.transition(child.id, "completed", { timeEnded: Date.now() })
          const active = CollabAgentNode.activate(child.id)
          release!([])
          await loop

          const fresh = CollabAgentNode.load(child.id)
          expect(fresh.status).toBe("running")
          expect(fresh.run_id).toBe(active.run_id)
          expect(CollabMessage.list(parent.id, { kind: "child_done" })).toHaveLength(0)
        } finally {
          Collab.runtime().abort(child.id)
          messages.mockRestore()
        }
      },
    })
  })
})

describe("Collab roots", () => {
  test("concurrent ensureRootFromSession calls create one root", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({ title: `root-${Identifier.ascending("session")}` })
        const roots = await Promise.all(
          Array.from({ length: 8 }, () =>
            Collab.ensureRootFromSession(session.id, {
              name: "root",
              subagentType: "general",
              spec: { initialPrompt: "" },
            }),
          ),
        )

        expect(new Set(roots.map((item) => item.id)).size).toBe(1)
        expect(
          CollabAgentNode.loadByProject(Instance.project.id).filter((item) => item.session_id === session.id),
        ).toHaveLength(1)
      },
    })
  })
})

describe("Collab ancestry", () => {
  test("ancestors include transitive descendants but reject siblings", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const top = await node({ name: "ancestry-root" })
        const left = await node({ name: "ancestry-left", parent: top.id, root: top.id })
        const right = await node({ name: "ancestry-right", parent: top.id, root: top.id })
        const leaf = await node({ name: "ancestry-leaf", parent: left.id, root: top.id })

        expect(Collab.isAncestor(top.id, right.id)).toBe(true)
        expect(Collab.isAncestor(top.id, leaf.id)).toBe(true)
        expect(Collab.isAncestor(left.id, leaf.id)).toBe(true)
        expect(Collab.isAncestor(left.id, right.id)).toBe(false)
        expect(Collab.isAncestor(right.id, left.id)).toBe(false)
        expect(Collab.isAncestor(left.id, left.id)).toBe(false)
      },
    })
  })
})

describe("Collab temporary leases", () => {
  test("lease attaches atomically and terminal recovery restores the independent subtree", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const parent = await node({ name: "lease-parent" })
        const target = await node({ name: "lease-target" })
        const leaf = await node({ name: "lease-leaf", parent: target.id, root: target.id, status: "idle" })
        const run = `lease-${Identifier.ascending("collab_agent")}`
        const events: string[] = []
        const off = Bus.subscribe(CollabEvent.AgentReparented, (event) => {
          if (event.properties.info.id === target.id) events.push(event.properties.newRootAgentId)
        })
        const start = spyOn(CollabLoop, "start").mockResolvedValue()

        try {
          expect(Collab.branchSettled(target.id)).toBe(true)
          const leased = await Collab.leaseAndResume({
            agentId: target.id,
            parentAgentId: parent.id,
            prompt: "temporary work",
            runId: run,
          })
          expect(leased.parent_agent_id).toBe(parent.id)
          expect(leased.root_agent_id).toBe(parent.id)
          expect(leased.run_id).toBe(run)
          expect(leased.status).toBe("running")
          expect(leased.spec.policy?.detach_on_terminal).toBe(true)
          expect(CollabAgentNode.load(leaf.id).root_agent_id).toBe(parent.id)
          expect(CollabAgentNode.load(parent.id).active_children).toBe(1)
          expect(CollabAgentNode.load(parent.id).spawned_total).toBe(1)
          expect(CollabMessage.list(target.id, { kind: "user_input" })).toHaveLength(1)

          await Collab.leaseAndResume({
            agentId: target.id,
            parentAgentId: parent.id,
            prompt: "temporary work",
            runId: run,
          })
          expect(CollabAgentNode.load(parent.id).active_children).toBe(1)
          expect(CollabAgentNode.load(parent.id).spawned_total).toBe(1)
          expect(CollabMessage.list(target.id, { kind: "user_input" })).toHaveLength(1)

          CollabAgentNode.transition(target.id, "completed", {
            result: { summary: "leased work complete" },
            timeEnded: Date.now(),
          })
          await CollabRecovery.scan()

          const released = CollabAgentNode.load(target.id)
          expect(released.parent_agent_id).toBeNull()
          expect(released.root_agent_id).toBe(target.id)
          expect(released.run_id).toBeNull()
          expect(released.status).toBe("running")
          expect(released.spec.policy?.detach_on_terminal).toBe(false)
          expect(CollabAgentNode.load(leaf.id).root_agent_id).toBe(target.id)
          expect(Collab.branchSettled(target.id)).toBe(true)
          expect(CollabAgentNode.load(parent.id).active_children).toBe(0)
          expect(CollabMessage.list(parent.id, { kind: "child_done" })[0]?.run_id).toBe(run)
          expect(events).toEqual([parent.id, target.id])
        } finally {
          off()
          start.mockRestore()
        }
      },
    })
  })

  test("leased agents only resume from waiting with the expected topology", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const parent = await node({ name: "resume-lease-parent" })
        const target = await node({ name: "resume-lease-target", status: "idle" })
        const start = spyOn(CollabLoop, "start").mockResolvedValue()

        try {
          const leased = await Collab.leaseAndResume({
            agentId: target.id,
            parentAgentId: parent.id,
            prompt: "work",
            runId: `lease-${Identifier.ascending("collab_agent")}`,
          })
          await expect(
            Collab.resume({
              agentId: leased.id,
              prompt: "duplicate",
              expectedParentAgentId: parent.id,
              expectedRunId: leased.run_id,
            }),
          ).rejects.toThrow("Cannot resume leased agent")

          CollabAgentNode.transition(leased.id, "waiting_interaction")
          await expect(
            Collab.resume({
              agentId: leased.id,
              prompt: "wrong run",
              expectedParentAgentId: parent.id,
              expectedRunId: "replaced",
            }),
          ).rejects.toThrow("run changed")

          const resumed = await Collab.resume({
            agentId: leased.id,
            prompt: "continue",
            expectedParentAgentId: parent.id,
            expectedRunId: leased.run_id,
          })
          expect(resumed.status).toBe("running")
          expect(resumed.run_id).toBe(leased.run_id)
        } finally {
          start.mockRestore()
        }
      },
    })
  })
})

describe("Collab durable inbox", () => {
  test("cancel preempts an earlier pending user input", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const parent = await node({ name: "cancel-parent" })
        const child = await node({ name: "cancel-child", parent: parent.id, root: parent.id })
        CollabMessage.post({
          recipientAgentId: child.id,
          runId: child.run_id,
          kind: "user_input",
          payload: { text: "work" },
        })
        CollabMessage.post({
          recipientAgentId: child.id,
          runId: child.run_id,
          kind: "cancel",
          payload: { reason: "stop", initiator: "parent" },
        })

        const claimed = CollabMessage.drain(child.id)
        expect(claimed).toHaveLength(1)
        expect(claimed[0].kind).toBe("cancel")
        expect(CollabMessage.list(child.id, { kind: "user_input" })[0].status).toBe("pending")
      },
    })
  })

  test("waiting resume merges a replacement model into the stranded input", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const parent = await node({ name: "model-parent" })
        const child = await node({ name: "model-child", parent: parent.id, root: parent.id })
        CollabMessage.post({
          recipientAgentId: child.id,
          runId: child.run_id,
          kind: "user_input",
          payload: { text: "original task", model: { providerID: "old", modelID: "missing" } },
        })
        const claimed = CollabMessage.drain(child.id)
        CollabMessage.retry(claimed, false)
        CollabAgentNode.transition(child.id, "waiting_interaction")
        const start = spyOn(CollabLoop, "start").mockResolvedValue()

        try {
          await Collab.resume({
            agentId: child.id,
            prompt: "continue with replacement",
            model: { providerID: "new", modelID: "available" },
          })

          const inputs = CollabMessage.listRun(child.id, child.run_id!)
          expect(inputs).toHaveLength(1)
          expect(inputs[0].status).toBe("pending")
          expect(inputs[0].payload_json).toMatchObject({
            text: "original task\n\nParent follow-up: continue with replacement",
            model: { providerID: "new", modelID: "available" },
          })
        } finally {
          start.mockRestore()
        }
      },
    })
  })

  test("claims retry and acknowledge explicitly", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const target = await node({ name: "claim-root" })
        CollabMessage.post({ recipientAgentId: target.id, kind: "user_input", payload: { text: "work" } })

        const first = CollabMessage.drain(target.id)
        expect(first).toHaveLength(1)
        expect(first[0].status).toBe("processing")
        expect((first[0].payload_json as { messageId?: string }).messageId).toStartWith("msg_")
        CollabMessage.retry(first)
        expect(CollabMessage.list(target.id)[0].status).toBe("pending")

        const second = CollabMessage.drain(target.id)
        CollabMessage.ack(first)
        expect(CollabMessage.list(target.id)[0].status).toBe("processing")
        CollabMessage.ack(second)
        expect(CollabMessage.list(target.id)[0].status).toBe("consumed")
      },
    })
  })

  test("cancel preempts messages beyond one drain batch", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const target = await node({ name: "cancel-batch" })
        Array.from({ length: 65 }, (_, index) =>
          CollabMessage.post({ recipientAgentId: target.id, kind: "system", payload: { index } }),
        )
        CollabMessage.post({ recipientAgentId: target.id, kind: "user_input", payload: { text: "do not run" } })
        CollabMessage.post({ recipientAgentId: target.id, kind: "cancel", payload: { reason: "stop" } })

        const claimed = CollabMessage.drain(target.id)
        expect(claimed).toHaveLength(1)
        expect(claimed[0].kind).toBe("cancel")
      },
    })
  })

  test("a durable user message resumes its incomplete SessionPrompt loop", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const parent = await node({ name: "durable-parent" })
        const child = await node({ name: "durable-child", parent: parent.id, root: parent.id })
        CollabAgentNode.transition(child.id, "running")
        CollabMessage.post({
          recipientAgentId: child.id,
          runId: child.run_id,
          kind: "user_input",
          payload: { text: "durable work" },
        })
        const claimed = CollabMessage.drain(child.id)
        const payload = claimed[0].payload_json as { text: string; messageId: string }
        await SessionPrompt.prompt({
          sessionID: child.session_id,
          agent: child.subagent_type,
          model: { providerID: "opencode", modelID: "kimi-k2.5-free" },
          messageID: payload.messageId,
          parts: [{ type: "text", text: payload.text }],
          noReply: true,
        })
        CollabMessage.retry(claimed)

        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(
          {} as Awaited<ReturnType<typeof SessionPrompt.prompt>>,
        )
        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(
          {} as Awaited<ReturnType<typeof SessionPrompt.loop>>,
        )
        try {
          await CollabLoop.start(child.id)
          expect(loop).toHaveBeenCalledTimes(1)
          expect(prompt).toHaveBeenCalledTimes(0)
          expect(CollabMessage.list(child.id, { kind: "user_input" })[0].status).toBe("consumed")
        } finally {
          loop.mockRestore()
          prompt.mockRestore()
        }
      },
    })
  })
})
