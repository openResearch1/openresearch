import { describe, expect, test } from "bun:test"
import path from "path"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { CollabMessage } from "../../src/collab/message"
import { Collab } from "../../src/collab"
import { CollabAutoWake } from "../../src/collab/auto-wake"
import { CollabEvent } from "../../src/collab/events"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

// This file intentionally KEEPS auto-wake enabled to observe transitions,
// but we never invoke SessionPrompt with a real model — we rely on the fact
// that the prompt call will fail fast and be swallowed; the status
// transitions around it are what we verify.
CollabAutoWake.setEnabled(true)

describe("CollabAutoWake blocks root on active children", () => {
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

        CollabMessage.drain(rootId)
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

describe("CollabAutoWake does not touch non-root agents", () => {
  test("posting child_done to a NON-root parent does not trigger auto-wake", async () => {
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

        // Count message.posted events; make sure auto-wake does NOT drain mid-parent's inbox.
        let mpCount = 0
        const unsub = Bus.subscribe(CollabEvent.MessageConsumed, (e) => {
          if (e.properties.recipientAgentId === parentId) mpCount++
        })

        await CollabMessage.post({
          recipientAgentId: parentId,
          senderAgentId: childId,
          kind: "child_done",
          payload: { childAgentId: childId, childName: "child", summary: "done" },
        })

        await new Promise((r) => setTimeout(r, 80))
        unsub()

        // Since parent is non-root, AutoWake should NOT consume this message.
        // The runLoop (not started in this test) is the only thing that would drain it.
        expect(mpCount).toBe(0)
        // Message should still be pending in inbox.
        expect(CollabMessage.hasPendingWakeMsg(parentId)).toBe(true)
      },
    })
  })
})
