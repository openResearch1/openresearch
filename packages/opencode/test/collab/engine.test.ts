import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { CollabMessage } from "../../src/collab/message"
import { CollabSupervisor } from "../../src/collab/supervisor"
import { CollabLoop } from "../../src/collab/loop"
import { CollabAutoWake } from "../../src/collab/auto-wake"
import type { AgentSpec, ChildProgressPayload } from "../../src/collab/types"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

// Tests assert raw FIFO/queue semantics. The auto-wake driver would drain
// the inbox and try to run SessionPrompt on bare test sessions; keep it
// disabled so we can observe the primitive layer directly.
CollabAutoWake.setEnabled(false)

function makeSpec(overrides?: Partial<AgentSpec>): AgentSpec {
  return {
    initialPrompt: "hi",
    ...overrides,
  }
}

async function makeSession(parentID?: string) {
  return Session.create({ parentID, title: "collab-test " + Identifier.ascending("session") })
}

describe("CollabMessage FIFO + active_children atomicity", () => {
  test("post drains in insertion order; child_done decrements active_children", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const parentSession = await makeSession()
        const parentId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: parentId,
          sessionId: parentSession.id,
          parentAgentId: null,
          name: "parent",
          projectId: Instance.project.id,
          rootAgentId: parentId,
          subagentType: "general",
          spec: makeSpec(),
        })

        const child1Session = await makeSession(parentSession.id)
        const child1Id = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: child1Id,
          sessionId: child1Session.id,
          parentAgentId: parentId,
          name: "child1",
          projectId: Instance.project.id,
          rootAgentId: parentId,
          subagentType: "general",
          spec: makeSpec(),
        })

        const child2Session = await makeSession(parentSession.id)
        const child2Id = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: child2Id,
          sessionId: child2Session.id,
          parentAgentId: parentId,
          name: "child2",
          projectId: Instance.project.id,
          rootAgentId: parentId,
          subagentType: "general",
          spec: makeSpec(),
        })

        // After creating two children, parent.active_children should be 2.
        expect(CollabAgentNode.load(parentId).active_children).toBe(2)
        expect(CollabAgentNode.load(parentId).spawned_total).toBe(2)

        // Post progress (does NOT decrement active_children).
        await CollabMessage.post({
          recipientAgentId: parentId,
          senderAgentId: child1Id,
          kind: "child_progress",
          payload: { childAgentId: child1Id, childName: "c1", turn: 1, assistant_text: "tick", tools: [] },
        })
        expect(CollabAgentNode.load(parentId).active_children).toBe(2)

        // Post a child_done from child1 — should decrement to 1.
        await CollabMessage.post({
          recipientAgentId: parentId,
          senderAgentId: child1Id,
          kind: "child_done",
          payload: { childAgentId: child1Id, childName: "c1", summary: "c1 done" },
        })
        expect(CollabAgentNode.load(parentId).active_children).toBe(1)

        // Post child_failed from child2 — should decrement to 0.
        await CollabMessage.post({
          recipientAgentId: parentId,
          senderAgentId: child2Id,
          kind: "child_failed",
          payload: { childAgentId: child2Id, childName: "c2", reason: "error", message: "boom" },
        })
        expect(CollabAgentNode.load(parentId).active_children).toBe(0)

        // Drain: should come out in insertion order (progress, done, failed).
        const drained = CollabMessage.drain(parentId)
        const kinds = drained.map((m) => m.kind)
        expect(kinds).toEqual(["child_progress", "child_done", "child_failed"])

        // After drain, hasPending = false.
        expect(CollabMessage.hasPending(parentId)).toBe(false)
        expect(CollabMessage.hasPendingWakeMsg(parentId)).toBe(false)
      },
    })
  })
})

describe("hasPendingWakeMsg ignores child_progress", () => {
  test("progress alone does not wake; done does", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const parentSession = await makeSession()
        const parentId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: parentId,
          sessionId: parentSession.id,
          parentAgentId: null,
          name: "p",
          projectId: Instance.project.id,
          rootAgentId: parentId,
          subagentType: "general",
          spec: makeSpec(),
        })

        const childSession = await makeSession(parentSession.id)
        const childId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: childId,
          sessionId: childSession.id,
          parentAgentId: parentId,
          name: "c",
          projectId: Instance.project.id,
          rootAgentId: parentId,
          subagentType: "general",
          spec: makeSpec(),
        })

        await CollabMessage.post({
          recipientAgentId: parentId,
          senderAgentId: childId,
          kind: "child_progress",
          payload: { childAgentId: childId, childName: "c", turn: 1, assistant_text: "x", tools: [] },
        })
        expect(CollabMessage.hasPending(parentId)).toBe(true)
        expect(CollabMessage.hasPendingWakeMsg(parentId)).toBe(false)

        await CollabMessage.post({
          recipientAgentId: parentId,
          senderAgentId: childId,
          kind: "child_done",
          payload: { childAgentId: childId, childName: "c", summary: "done" },
        })
        expect(CollabMessage.hasPendingWakeMsg(parentId)).toBe(true)
      },
    })
  })
})

describe("progress_injection strategies", () => {
  test("none drops; latest collapses per child; all keeps all", () => {
    const p = (id: string, turn: number): ChildProgressPayload => ({
      childAgentId: id,
      childName: id,
      turn,
      assistant_text: `t${turn}`,
      tools: [],
    })
    const msgs = [p("A", 1), p("A", 2), p("B", 1), p("A", 3), p("B", 2)]

    expect(CollabLoop.collapseProgress(msgs, "none")).toEqual([])
    expect(CollabLoop.collapseProgress(msgs, "all")).toEqual(msgs)

    const latest = CollabLoop.collapseProgress(msgs, "latest")
    // Expect latest from A (turn=3) and B (turn=2), set order undefined but content strict.
    const byId = new Map(latest.map((x) => [x.childAgentId, x.turn]))
    expect(byId.get("A")).toBe(3)
    expect(byId.get("B")).toBe(2)
    expect(latest.length).toBe(2)
  })
})

describe("cancel propagation via supervisor", () => {
  test("cancelDescendants posts cancel to every active descendant", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const rootSession = await makeSession()
        const rootId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: rootId,
          sessionId: rootSession.id,
          parentAgentId: null,
          name: "root",
          projectId: Instance.project.id,
          rootAgentId: rootId,
          subagentType: "general",
          spec: makeSpec(),
        })

        const aSession = await makeSession(rootSession.id)
        const aId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: aId,
          sessionId: aSession.id,
          parentAgentId: rootId,
          name: "A",
          projectId: Instance.project.id,
          rootAgentId: rootId,
          subagentType: "general",
          spec: makeSpec(),
        })

        const a1Session = await makeSession(aSession.id)
        const a1Id = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: a1Id,
          sessionId: a1Session.id,
          parentAgentId: aId,
          name: "A1",
          projectId: Instance.project.id,
          rootAgentId: rootId,
          subagentType: "general",
          spec: makeSpec(),
        })

        // Request cancel on root's descendants.
        await CollabSupervisor.cancelDescendants(rootId, { reason: "test", initiator: "user" })

        // A and A1 should both get a cancel message; root should not.
        const aMsgs = CollabMessage.list(aId)
        const a1Msgs = CollabMessage.list(a1Id)
        const rootMsgs = CollabMessage.list(rootId)

        expect(aMsgs.some((m) => m.kind === "cancel")).toBe(true)
        expect(a1Msgs.some((m) => m.kind === "cancel")).toBe(true)
        expect(rootMsgs.some((m) => m.kind === "cancel")).toBe(false)
      },
    })
  })
})

describe("subscription race fuzz", () => {
  test("posting immediately after (or during) waitForInbox setup never hangs", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        for (let i = 0; i < 20; i++) {
          const sess = await makeSession()
          const id = Identifier.ascending("collab_agent")
          CollabAgentNode.create({
            id,
            sessionId: sess.id,
            parentAgentId: null,
            name: "race",
            projectId: Instance.project.id,
            rootAgentId: id,
            subagentType: "general",
            spec: makeSpec(),
          })

          // Race: post concurrently with waiting.
          const waitPromise = waitForInboxTest(id)
          await Promise.all([
            CollabMessage.post({
              recipientAgentId: id,
              senderAgentId: null,
              kind: "user_input",
              payload: { text: "hi" },
            }),
            waitPromise,
          ])
        }
      },
    })
  })
})

// Reimplemented minimal wait to avoid pulling in full loop.
async function waitForInboxTest(agentId: string): Promise<void> {
  const { Bus } = await import("../../src/bus")
  const { CollabEvent } = await import("../../src/collab/events")
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      unsub()
      resolve()
    }
    const unsub = Bus.subscribe(CollabEvent.MessagePosted, (e) => {
      if (e.properties.recipientAgentId !== agentId) return
      if (!["child_done", "child_failed", "cancel", "user_input"].includes(e.properties.kind)) return
      finish()
    })
    if (CollabMessage.hasPendingWakeMsg(agentId)) finish()
  })
}
