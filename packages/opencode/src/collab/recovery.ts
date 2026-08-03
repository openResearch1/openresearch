import { and, eq, gte, inArray, isNull } from "drizzle-orm"
import { Database } from "@/storage/db"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Session } from "@/session"
import { SessionOwnership } from "@/session/ownership"
import { ExperimentRemoteTaskListener } from "@/research/experiment-remote-task-listener"
import { Workflow } from "@/workflow"
import { CollabMessageTable } from "./collab.sql"
import { CollabAgentNode } from "./agent-node"
import { CollabMessage } from "./message"
import { CollabRuntime } from "./runtime"
import { CollabLoop } from "./loop"
import { CollabProgressHook } from "./progress-hook"
import { CollabAutoWake } from "./auto-wake"
import { CollabSupervisor } from "./supervisor"
import type { ChildDonePayload, ChildFailedPayload } from "./types"

export namespace CollabRecovery {
  const log = Log.create({ service: "collab.recovery" })

  const ACTIVE_STATUSES = ["pending", "running", "blocked_on_children", "waiting_interaction"] as const

  export async function reconcile() {
    const initial = CollabAgentNode.loadByProject(Instance.project.id)
    for (const node of initial) {
      if (node.parent_agent_id || node.root_agent_id !== node.id) continue
      if (!CollabAgentNode.isStopped(node) || node.spec.metadata?.stopReady === true) continue
      const claimed = node.spec.metadata?.stopClaimedAt
      const delay = typeof claimed === "number" ? claimed + CollabAgentNode.STOP_TIMEOUT - Date.now() : 0
      if (delay > 0) {
        CollabRuntime.schedule(node.id, delay, () => {
          void CollabSupervisor.stop(node.id, CollabAgentNode.generation(node.spec))
        })
        continue
      }
      await CollabSupervisor.stop(node.id, CollabAgentNode.generation(node.spec))
    }
    const nodes = CollabAgentNode.loadByProject(Instance.project.id)
    for (const node of nodes) {
      ExperimentRemoteTaskListener.reconcile(node.id)
      CollabMessage.reconcileRemoteTerminals(node.id)
    }
  }

  export async function scan() {
    await reconcile()
    CollabProgressHook.ensure()
    CollabAutoWake.ensure()

    const project = Instance.project
    const initial = CollabAgentNode.loadByProject(project.id)
    for (const node of initial) {
      if (node.parent_agent_id && !node.run_id) CollabAgentNode.ensureRun(node.id)
      if (CollabRuntime.has(node.id) || CollabAutoWake.isDriving(node.session_id)) continue
      const release = SessionOwnership.claim(node.session_id, "collab")
      if (!release) continue
      CollabMessage.retryProcessing(node.id)
      release()
    }

    for (const node of initial) await synthesizeMissingChildReports(node.id)
    for (const node of CollabAgentNode.loadByProject(project.id)) {
      if (node.status !== "completed" && node.status !== "failed" && node.status !== "canceled") continue
      CollabMessage.closeInbox(node.id)
      if (!node.parent_agent_id || !node.spec.policy?.detach_on_terminal) continue
      CollabAgentNode.release(node.id)
    }

    for (const node of CollabAgentNode.loadActiveByProject(project.id)) {
      CollabAgentNode.recomputeActiveChildren(node.id)
    }
    for (const node of CollabAgentNode.loadActiveByProject(project.id)) {
      const session = await Session.get(node.session_id).catch(() => undefined)
      if (!session?.collabPeer) continue
      const guard = {
        runId: node.run_id,
        parentId: node.parent_agent_id,
        status: node.status,
        timeUpdated: node.time_updated,
      }

      const workflow = Workflow.latest(node.session_id)
      if (node.status === "waiting_interaction" && workflow?.status !== "waiting_interaction") {
        await CollabLoop.fail(
          node.id,
          {
            code: node.error?.code ?? "ORPHANED_WAIT",
            message: node.error?.message ?? "Spawned agent was waiting without an active interaction workflow.",
          },
          guard,
        )
        continue
      }
      const timeout = node.spec.policy?.timeout_ms ?? CollabLoop.DEFAULT_TIMEOUT
      if (Date.now() >= (node.time_started ?? node.time_created) + timeout) {
        await CollabLoop.fail(
          node.id,
          {
            code: "TIMEOUT",
            message: `Agent exceeded its ${timeout}ms timeout.`,
          },
          guard,
        )
        continue
      }
      if (node.status === "waiting_interaction") CollabLoop.watch(node.id)

      const messages = await Session.messages({ sessionID: node.session_id })
      const failed = messages.findLast(
        (message) =>
          message.info.role === "assistant" &&
          !!message.info.error &&
          message.info.time.created >= (node.time_started ?? node.time_created),
      )
      if (failed?.info.role !== "assistant" || !failed.info.error) continue
      const error = failed.info.error as { name?: string; data?: { message?: string } }
      await CollabLoop.fail(
        node.id,
        {
          code: error.name ?? "SESSION_ERROR",
          message: error.data?.message ?? "Spawned agent session failed.",
        },
        guard,
      )
    }
    const active = CollabAgentNode.loadActiveByProject(project.id)
    log.info("scan.start", { project: project.id, activeCount: active.length })

    for (const node of active) {
      // Skip agents whose sessions are already being driven by an existing loop.
      if (CollabRuntime.has(node.id)) continue

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

      if (node.status === "waiting_interaction" && !CollabMessage.hasOutstandingWakeMsg(node.id)) {
        log.info("scan.skip.waiting", { agentId: node.id })
        continue
      }

      // Restart the loop for non-root peers.
      log.info("scan.resume", { agentId: node.id, status: node.status })
      void CollabLoop.start(node.id)
    }
  }

  async function synthesizeMissingChildReports(parentId: string) {
    const children = CollabAgentNode.loadChildren(parentId)

    for (const child of children) {
      if (child.status !== "completed" && child.status !== "failed" && child.status !== "canceled") continue
      if (child.initiator === "human") continue

      const already = Database.use((db) =>
        db
          .select({ id: CollabMessageTable.id })
          .from(CollabMessageTable)
          .where(
            and(
              eq(CollabMessageTable.recipient_agent_id, parentId),
              eq(CollabMessageTable.sender_agent_id, child.id),
              inArray(CollabMessageTable.kind, ["child_done", "child_failed"]),
              child.run_id ? eq(CollabMessageTable.run_id, child.run_id) : isNull(CollabMessageTable.run_id),
              child.run_id ? undefined : gte(CollabMessageTable.time_created, child.time_started ?? child.time_created),
            ),
          )
          .limit(1)
          .get(),
      )
      if (already) continue

      if (child.status === "completed") {
        const payload: ChildDonePayload = {
          runId: child.run_id ?? undefined,
          childAgentId: child.id,
          childName: child.name,
          summary: child.result?.summary ?? "",
          result: child.result?.result,
        }
        log.info("recovery.synth child_done", { parentId, childId: child.id })
        await CollabMessage.post({
          recipientAgentId: parentId,
          senderAgentId: child.id,
          runId: child.run_id,
          kind: "child_done",
          payload,
        })
      } else {
        const payload: ChildFailedPayload = {
          runId: child.run_id ?? undefined,
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
          runId: child.run_id,
          kind: "child_failed",
          payload,
        })
      }
    }
  }

  export const ACTIVE_STATUS_LIST: readonly string[] = ACTIVE_STATUSES
}
