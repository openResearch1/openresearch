import { and, Database, eq, inArray } from "@/storage/db"
import { CollabAgentTable } from "@/collab/collab.sql"
import { CollabAgentNode } from "@/collab/agent-node"
import { CollabMessage } from "@/collab/message"
import type { RemoteTaskTerminalPayload } from "@/collab/types"
import { RemoteTaskListenerTable } from "./remote-task-listener.sql"
import { RemoteTaskTable } from "./research.sql"

type Task = typeof RemoteTaskTable.$inferSelect

const terminal = new Set<Task["status"]>(["finished", "failed", "crashed", "canceled"])
const active = new Set(["pending", "running", "blocked_on_children", "waiting_interaction"])

export namespace ExperimentRemoteTaskListener {
  function lifecycle(agent: typeof CollabAgentTable.$inferSelect) {
    const mode = active.has(agent.status) && agent.run_id ? ("collab" as const) : ("direct" as const)
    return { mode, run: mode === "collab" ? agent.run_id : null }
  }

  export function register(input: { taskId: string; agentId: string }) {
    return Database.transaction((tx) => {
      const task = tx.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.task_id, input.taskId)).get()
      if (!task) throw new Error(`remote task not found: ${input.taskId}`)
      if (terminal.has(task.status)) return { listening: false as const, duplicate: false, task }
      const agent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.agentId)).get()
      if (!agent) throw new Error(`collab agent not found: ${input.agentId}`)
      const restored = CollabAgentNode.restoreExperiment(agent.id)
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, restored.id)).get()!
      if ((current.spec_json as { metadata?: Record<string, unknown> }).metadata?.stoppedByUser === true) {
        throw new Error(`collab agent was stopped by user: ${current.id}`)
      }
      const state = lifecycle(current)

      const existing = tx
        .select()
        .from(RemoteTaskListenerTable)
        .where(
          and(eq(RemoteTaskListenerTable.task_id, input.taskId), eq(RemoteTaskListenerTable.agent_id, input.agentId)),
        )
        .get()
      const now = Date.now()
      if (existing) {
        const duplicate = existing.run_id === state.run && existing.mode === state.mode
        tx.update(RemoteTaskListenerTable)
          .set({ mode: state.mode, run_id: state.run, time_created: now, time_updated: now })
          .where(
            and(eq(RemoteTaskListenerTable.task_id, input.taskId), eq(RemoteTaskListenerTable.agent_id, input.agentId)),
          )
          .run()
        return { listening: true as const, duplicate, task }
      }

      tx.insert(RemoteTaskListenerTable)
        .values({
          task_id: input.taskId,
          agent_id: input.agentId,
          mode: state.mode,
          run_id: state.run,
          time_created: now,
          time_updated: now,
        })
        .run()
      return { listening: true as const, duplicate: false, task }
    })
  }

  export function has(agentId: string, mode?: "direct" | "collab") {
    return Database.use((db) =>
      db
        .select({ task_id: RemoteTaskListenerTable.task_id })
        .from(RemoteTaskListenerTable)
        .where(
          mode
            ? and(eq(RemoteTaskListenerTable.agent_id, agentId), eq(RemoteTaskListenerTable.mode, mode))
            : eq(RemoteTaskListenerTable.agent_id, agentId),
        )
        .limit(1)
        .get(),
    )
  }

  export function clear(agentIds: string[], mode?: "direct" | "collab") {
    if (!agentIds.length) return
    Database.use((db) =>
      db
        .delete(RemoteTaskListenerTable)
        .where(
          and(
            inArray(RemoteTaskListenerTable.agent_id, agentIds),
            mode ? eq(RemoteTaskListenerTable.mode, mode) : undefined,
          ),
        )
        .run(),
    )
  }

  export function reconcile(agentId: string) {
    const tasks = Database.transaction((tx) => {
      const agent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, agentId)).get()
      if (!agent) return []
      const rows = tx
        .select({ listener: RemoteTaskListenerTable, task: RemoteTaskTable })
        .from(RemoteTaskListenerTable)
        .innerJoin(RemoteTaskTable, eq(RemoteTaskTable.task_id, RemoteTaskListenerTable.task_id))
        .where(eq(RemoteTaskListenerTable.agent_id, agentId))
        .all()
      const now = Date.now()
      const stopped = (agent.spec_json as { metadata?: Record<string, unknown> }).metadata?.stoppedByUser === true
      for (const row of rows) {
        if (stopped && row.listener.mode === "collab") {
          tx.delete(RemoteTaskListenerTable)
            .where(
              and(
                eq(RemoteTaskListenerTable.task_id, row.listener.task_id),
                eq(RemoteTaskListenerTable.agent_id, row.listener.agent_id),
                eq(RemoteTaskListenerTable.mode, "collab"),
              ),
            )
            .run()
          continue
        }
        if (
          row.listener.mode !== "collab" ||
          (active.has(agent.status) && !!row.listener.run_id && row.listener.run_id === agent.run_id)
        )
          continue
        tx.update(RemoteTaskListenerTable)
          .set({ mode: "direct", run_id: null, time_updated: now })
          .where(
            and(
              eq(RemoteTaskListenerTable.task_id, row.listener.task_id),
              eq(RemoteTaskListenerTable.agent_id, row.listener.agent_id),
            ),
          )
          .run()
      }
      return rows.filter((row) => terminal.has(row.task.status)).map((row) => row.task)
    })
    for (const task of tasks) notify(task)
  }

  export function notify(task: Task) {
    if (!terminal.has(task.status)) return
    const listeners = Database.use((db) =>
      db.select().from(RemoteTaskListenerTable).where(eq(RemoteTaskListenerTable.task_id, task.task_id)).all(),
    )
    for (const listener of listeners) {
      Database.transaction((tx) => {
        const claimed = tx
          .delete(RemoteTaskListenerTable)
          .where(
            and(
              eq(RemoteTaskListenerTable.task_id, listener.task_id),
              eq(RemoteTaskListenerTable.agent_id, listener.agent_id),
            ),
          )
          .returning()
          .get()
        if (!claimed) return
        const current = tx.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.task_id, task.task_id)).get()
        if (!current || !terminal.has(current.status)) {
          tx.insert(RemoteTaskListenerTable).values(claimed).run()
          return
        }
        let agent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, claimed.agent_id)).get()
        if (!agent) return
        let metadata = (agent.spec_json as { metadata?: Record<string, unknown> }).metadata
        if (metadata?.stoppedByUser === true && claimed.mode === "collab") return
        if (metadata?.stoppedByUser === true) {
          CollabAgentNode.restoreExperiment(agent.id)
          agent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, claimed.agent_id)).get()
          if (!agent) return
          metadata = (agent.spec_json as { metadata?: Record<string, unknown> }).metadata
          if (metadata?.stoppedByUser !== true) {
            tx.delete(RemoteTaskListenerTable)
              .where(
                and(
                  eq(RemoteTaskListenerTable.agent_id, agent.id),
                  eq(RemoteTaskListenerTable.mode, "collab"),
                ),
              )
              .run()
          }
        }
        if (metadata?.stoppedByUser === true) {
          if (
            claimed.mode === "direct" &&
            agent.subagent_type === "experiment" &&
            typeof metadata.atomId === "string" &&
            typeof metadata.expId === "string"
          ) {
            tx.insert(RemoteTaskListenerTable).values(claimed).run()
          }
          return
        }
        const collab =
          claimed.mode === "collab" && active.has(agent.status) && !!claimed.run_id && claimed.run_id === agent.run_id
        const payload: RemoteTaskTerminalPayload = {
          taskId: current.task_id,
          expId: current.exp_id,
          kind: current.kind,
          title: current.title,
          status: current.status as RemoteTaskTerminalPayload["status"],
          logPath: current.log_path,
          errorMessage: current.error_message,
        }
        const posted =
          CollabMessage.findRemoteTerminal(claimed.agent_id, current.task_id, claimed.time_created)?.id ??
          CollabMessage.post({
            recipientAgentId: claimed.agent_id,
            senderAgentId: null,
            runId: collab ? claimed.run_id : null,
            expectedRunId: agent.run_id,
            kind: collab ? "remote_task_terminal" : "session_remote_task_terminal",
            payload,
          })
        if (!posted) throw new Error(`Failed to post terminal callback for remote task ${current.task_id}`)
      })
    }
  }
}
