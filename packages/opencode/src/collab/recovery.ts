import { and, eq, inArray } from "drizzle-orm"
import { Database } from "@/storage/db"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { CollabAgentTable, CollabMessageTable } from "./collab.sql"
import { CollabAgentNode } from "./agent-node"
import { CollabMessage } from "./message"
import { CollabRuntime } from "./runtime"
import { CollabLoop } from "./loop"
import { CollabProgressHook } from "./progress-hook"
import { CollabAutoWake } from "./auto-wake"
import type { ChildDonePayload, ChildFailedPayload } from "./types"

export namespace CollabRecovery {
  const log = Log.create({ service: "collab.recovery" })

  const ACTIVE_STATUSES = ["pending", "running", "blocked_on_children", "waiting_interaction"] as const

  export async function scan() {
    CollabProgressHook.ensure()
    CollabAutoWake.ensure()

    const project = Instance.project
    const active = CollabAgentNode.loadActiveByProject(project.id)
    log.info("scan.start", { project: project.id, activeCount: active.length })

    for (const node of active) {
      // Skip agents whose sessions are already being driven by an existing loop.
      if (CollabRuntime.has(node.id)) continue

      // 1) Reconcile active_children count.
      CollabAgentNode.recomputeActiveChildren(node.id)

      // 2) Patch missing done/failed messages from terminated children.
      await synthesizeMissingChildReports(node.id)

      if (!node.parent_agent_id) {
        // Root agents (primary sessions that have spawned Collab peers) are
        // driven by CollabAutoWake — NOT CollabLoop. Kicking off CollabLoop
        // on a root would restart it as if it were a fresh subagent: the
        // first tick tries to replay `spec.initialPrompt`, which is an empty
        // string for roots, producing an empty user message that strict
        // providers (Bedrock) reject with "conversation must end with a user
        // message". AutoWake's own initial scan (in CollabAutoWake.ensure)
        // already re-subscribes and re-drives any pending inbox for roots.
        log.info("scan.skip.root", { agentId: node.id, status: node.status })
        continue
      }

      if (node.status === "waiting_interaction" && !CollabMessage.hasPendingWakeMsg(node.id)) {
        log.info("scan.skip.waiting", { agentId: node.id })
        continue
      }

      // 3) Restart the loop for non-root peers.
      log.info("scan.resume", { agentId: node.id, status: node.status })
      void CollabLoop.start(node.id)
    }
  }

  async function synthesizeMissingChildReports(parentId: string) {
    const children = CollabAgentNode.loadChildren(parentId)

    for (const child of children) {
      if (child.status !== "completed" && child.status !== "failed" && child.status !== "canceled") continue

      const already = Database.use((db) =>
        db
          .select({ id: CollabMessageTable.id })
          .from(CollabMessageTable)
          .where(
            and(
              eq(CollabMessageTable.recipient_agent_id, parentId),
              eq(CollabMessageTable.sender_agent_id, child.id),
              inArray(CollabMessageTable.kind, ["child_done", "child_failed"]),
            ),
          )
          .limit(1)
          .get(),
      )
      if (already) continue

      if (child.status === "completed") {
        const payload: ChildDonePayload = {
          childAgentId: child.id,
          childName: child.name,
          summary: child.result?.summary ?? "",
          result: child.result?.result,
        }
        log.info("recovery.synth child_done", { parentId, childId: child.id })
        await CollabMessage.post({
          recipientAgentId: parentId,
          senderAgentId: child.id,
          kind: "child_done",
          payload,
        })
      } else {
        const payload: ChildFailedPayload = {
          childAgentId: child.id,
          childName: child.name,
          reason: child.status === "canceled" ? "canceled" : "error",
          message: child.error?.message ?? child.status,
          detail: child.error?.detail,
        }
        log.info("recovery.synth child_failed", { parentId, childId: child.id })
        await CollabMessage.post({
          recipientAgentId: parentId,
          senderAgentId: child.id,
          kind: "child_failed",
          payload,
        })
      }
    }
  }

  export const ACTIVE_STATUS_LIST: readonly string[] = ACTIVE_STATUSES
}

// Keep unused import errors quiet if CollabAgentTable tree-shakes.
void CollabAgentTable
