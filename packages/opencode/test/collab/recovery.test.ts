import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { CollabMessage } from "../../src/collab/message"
import { CollabRecovery } from "../../src/collab/recovery"
import { CollabAutoWake } from "../../src/collab/auto-wake"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

// Recovery test inspects inbox state directly; disable auto-wake to avoid drain.
CollabAutoWake.setEnabled(false)

describe("CollabRecovery.scan synthesizes missing child reports", () => {
  test("completed child without child_done message gets one synthesized on scan", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const parentSession = await Session.create({ title: "recovery-parent" })
        const parentId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: parentId,
          sessionId: parentSession.id,
          parentAgentId: null,
          name: "parent",
          projectId: Instance.project.id,
          rootAgentId: parentId,
          subagentType: "general",
          spec: { initialPrompt: "x" },
        })

        const childSession = await Session.create({ parentID: parentSession.id, title: "recovery-child" })
        const childId = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: childId,
          sessionId: childSession.id,
          parentAgentId: parentId,
          name: "child",
          projectId: Instance.project.id,
          rootAgentId: parentId,
          subagentType: "general",
          spec: { initialPrompt: "x" },
        })

        // Put parent into blocked_on_children state (as if it was waiting).
        CollabAgentNode.transition(parentId, "blocked_on_children", { phase: "awaiting_children" })

        // Mark child completed but DO NOT post child_done — simulating crash after child finished.
        CollabAgentNode.transition(childId, "completed", {
          phase: "main_loop",
          result: { summary: "partial" },
          timeEnded: Date.now(),
        })

        // Before scan: parent has no child_done messages.
        expect(CollabMessage.list(parentId).length).toBe(0)

        // scan() will restart parent's loop. We only care about message synthesis; the loop will try
        // to run SessionPrompt which we don't have mocked, so we wait a tick, then inspect state.
        // Instead of letting the loop run, we inspect messages synchronously after scan triggers post.
        //
        // Force-ensure the parent message count before the loop's drain consumes them.
        // The scan re-posts synthetic messages before loop starts. Because post() + drain() race,
        // we check list() which returns both pending and consumed rows.
        await CollabRecovery.scan()
        const msgs = CollabMessage.list(parentId)
        expect(msgs.some((m) => m.kind === "child_done" && m.sender_agent_id === childId)).toBe(true)
      },
    })
  })
})
