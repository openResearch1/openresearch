import { and, Database, eq, inArray, isNull } from "@/storage/db"
import { CollabAgentTable } from "@/collab/collab.sql"
import { CollabMessage } from "@/collab/message"
import type { RemoteTaskTerminalPayload } from "@/collab/types"
import { RemoteTaskListenerTable } from "./remote-task-listener.sql"
import { RemoteTaskTable } from "./research.sql"

type Task = typeof RemoteTaskTable.$inferSelect

const terminal = new Set<Task["status"]>(["finished", "failed", "crashed", "canceled"])

export namespace ExperimentRemoteTaskListener {
  export function register(input: { taskId: string; agentId: string; mode: "direct" | "collab" }) {
    return Database.transaction((tx) => {
      const task = tx.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.task_id, input.taskId)).get()
      if (!task) throw new Error(`remote task not found: ${input.taskId}`)
      if (terminal.has(task.status)) return { listening: false as const, duplicate: false, task }
      const agent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.agentId)).get()
      if (!agent) throw new Error(`collab agent not found: ${input.agentId}`)

      const existing = tx
        .select()
        .from(RemoteTaskListenerTable)
        .where(
          and(eq(RemoteTaskListenerTable.task_id, input.taskId), eq(RemoteTaskListenerTable.agent_id, input.agentId)),
        )
        .get()
      const now = Date.now()
      if (existing) {
        if (existing.run_id === agent.run_id && existing.mode === input.mode) {
          return { listening: true as const, duplicate: true, task }
        }
        tx.update(RemoteTaskListenerTable)
          .set({ mode: input.mode, run_id: agent.run_id, time_updated: now })
          .where(
            and(eq(RemoteTaskListenerTable.task_id, input.taskId), eq(RemoteTaskListenerTable.agent_id, input.agentId)),
          )
          .run()
        return { listening: true as const, duplicate: false, task }
      }

      tx.insert(RemoteTaskListenerTable)
        .values({
          task_id: input.taskId,
          agent_id: input.agentId,
          mode: input.mode,
          run_id: agent.run_id,
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

  export function clear(agentIds: string[]) {
    if (!agentIds.length) return
    Database.use((db) =>
      db.delete(RemoteTaskListenerTable).where(inArray(RemoteTaskListenerTable.agent_id, agentIds)).run(),
    )
  }

  export function notify(task: Task) {
    if (!terminal.has(task.status)) return
    const listeners = Database.use((db) =>
      db.select().from(RemoteTaskListenerTable).where(eq(RemoteTaskListenerTable.task_id, task.task_id)).all(),
    )
    const payload: RemoteTaskTerminalPayload = {
      taskId: task.task_id,
      expId: task.exp_id,
      kind: task.kind,
      title: task.title,
      status: task.status as RemoteTaskTerminalPayload["status"],
      logPath: task.log_path,
      errorMessage: task.error_message,
    }
    for (const listener of listeners) {
      CollabMessage.post({
        recipientAgentId: listener.agent_id,
        senderAgentId: null,
        runId: listener.run_id,
        expectedRunId: listener.run_id,
        kind: listener.mode === "direct" ? "session_remote_task_terminal" : "remote_task_terminal",
        payload,
      })
      Database.use((db) =>
        db
          .delete(RemoteTaskListenerTable)
          .where(
            and(
              eq(RemoteTaskListenerTable.task_id, listener.task_id),
              eq(RemoteTaskListenerTable.agent_id, listener.agent_id),
              listener.run_id
                ? eq(RemoteTaskListenerTable.run_id, listener.run_id)
                : isNull(RemoteTaskListenerTable.run_id),
            ),
          )
          .run(),
      )
    }
  }
}
