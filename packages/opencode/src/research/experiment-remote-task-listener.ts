import { and, Database, eq } from "@/storage/db"
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

      const existing = tx
        .select()
        .from(RemoteTaskListenerTable)
        .where(
          and(
            eq(RemoteTaskListenerTable.task_id, input.taskId),
            eq(RemoteTaskListenerTable.agent_id, input.agentId),
          ),
        )
        .get()
      if (existing) return { listening: true as const, duplicate: true, task }

      const now = Date.now()
      tx.insert(RemoteTaskListenerTable)
        .values({
          task_id: input.taskId,
          agent_id: input.agentId,
          mode: input.mode,
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
            ),
          )
          .run(),
      )
    }
  }
}
