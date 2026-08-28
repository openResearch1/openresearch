import { and, asc, Database, eq, inArray, lte } from "@/storage/db"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { CollabAgentNode } from "@/collab/agent-node"
import { CollabAgentTable } from "@/collab/collab.sql"
import { CollabMessage } from "@/collab/message"
import type { ScheduledTaskDuePayload } from "@/collab/types"

import { Scheduler } from "."
import { ScheduledTaskTable, scheduledTaskStatuses } from "./scheduled-task.sql"

const active = new Set(["pending", "running", "blocked_on_children", "waiting_interaction"])
const INTERVAL = 1000
const log = Log.create({ service: "scheduled-task" })

export namespace ScheduledTask {
  export type Status = (typeof scheduledTaskStatuses)[number]

  function lifecycle(agent: typeof CollabAgentTable.$inferSelect) {
    const mode = active.has(agent.status) && agent.run_id ? ("collab" as const) : ("direct" as const)
    return { mode, run: mode === "collab" ? agent.run_id : null }
  }

  export function create(input: { agentId: string; dueAt: number; prompt: string }) {
    return Database.transaction((tx) => {
      const agent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.agentId)).get()
      if (!agent) throw new Error(`collab agent not found: ${input.agentId}`)
      const state = lifecycle(agent)
      const now = Date.now()
      if (input.dueAt <= now) throw new Error("scheduled task due time must be in the future")
      const id = crypto.randomUUID()
      tx.insert(ScheduledTaskTable)
        .values({
          id,
          agent_id: input.agentId,
          status: "pending",
          mode: state.mode,
          run_id: state.run,
          due_at: input.dueAt,
          prompt: input.prompt,
          time_created: now,
          time_updated: now,
        })
        .run()
      return tx.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get()!
    })
  }

  export function get(id: string) {
    return Database.use((db) => db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get())
  }

  export function list(agentId: string, status?: Status) {
    return Database.use((db) =>
      db
        .select()
        .from(ScheduledTaskTable)
        .where(
          and(eq(ScheduledTaskTable.agent_id, agentId), status ? eq(ScheduledTaskTable.status, status) : undefined),
        )
        .orderBy(asc(ScheduledTaskTable.due_at))
        .all(),
    )
  }

  export function cancel(input: { id: string; agentId: string }) {
    return Database.transaction((tx) => {
      const task = tx
        .select()
        .from(ScheduledTaskTable)
        .where(and(eq(ScheduledTaskTable.id, input.id), eq(ScheduledTaskTable.agent_id, input.agentId)))
        .get()
      if (!task) throw new Error(`scheduled task not found: ${input.id}`)
      if (task.status === "fired") throw new Error(`scheduled task has already fired: ${input.id}`)
      if (task.status === "canceled") return task
      const now = Date.now()
      return tx
        .update(ScheduledTaskTable)
        .set({ status: "canceled", canceled_at: now, time_updated: now })
        .where(and(eq(ScheduledTaskTable.id, input.id), eq(ScheduledTaskTable.status, "pending")))
        .returning()
        .get()
    })
  }

  export function has(agentId: string, mode?: "direct" | "collab") {
    return Database.use((db) =>
      db
        .select({ id: ScheduledTaskTable.id })
        .from(ScheduledTaskTable)
        .where(
          and(
            eq(ScheduledTaskTable.agent_id, agentId),
            eq(ScheduledTaskTable.status, "pending"),
            mode ? eq(ScheduledTaskTable.mode, mode) : undefined,
          ),
        )
        .limit(1)
        .get(),
    )
  }

  export function clear(agentIds: string[], mode?: "direct" | "collab") {
    if (!agentIds.length) return
    const now = Date.now()
    Database.use((db) =>
      db
        .update(ScheduledTaskTable)
        .set({ status: "canceled", canceled_at: now, time_updated: now })
        .where(
          and(
            inArray(ScheduledTaskTable.agent_id, agentIds),
            eq(ScheduledTaskTable.status, "pending"),
            mode ? eq(ScheduledTaskTable.mode, mode) : undefined,
          ),
        )
        .run(),
    )
  }

  export function reconcile(agentId: string) {
    Database.transaction((tx) => {
      const agent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, agentId)).get()
      if (!agent) return
      const rows = tx
        .select()
        .from(ScheduledTaskTable)
        .where(and(eq(ScheduledTaskTable.agent_id, agentId), eq(ScheduledTaskTable.status, "pending")))
        .all()
      const now = Date.now()
      const stopped = (agent.spec_json as { metadata?: Record<string, unknown> }).metadata?.stoppedByUser === true
      for (const task of rows) {
        if (stopped && task.mode === "collab") {
          tx.update(ScheduledTaskTable)
            .set({ status: "canceled", canceled_at: now, time_updated: now })
            .where(eq(ScheduledTaskTable.id, task.id))
            .run()
          continue
        }
        if (task.mode !== "collab" || (active.has(agent.status) && task.run_id && task.run_id === agent.run_id))
          continue
        tx.update(ScheduledTaskTable)
          .set({ mode: "direct", run_id: null, time_updated: now })
          .where(eq(ScheduledTaskTable.id, task.id))
          .run()
      }
    })
  }

  function fire(id: string, now: number) {
    return Database.transaction((tx) => {
      const task = tx
        .select()
        .from(ScheduledTaskTable)
        .where(
          and(
            eq(ScheduledTaskTable.id, id),
            eq(ScheduledTaskTable.status, "pending"),
            lte(ScheduledTaskTable.due_at, now),
          ),
        )
        .get()
      if (!task) return
      let agent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, task.agent_id)).get()
      if (!agent) return
      const metadata = (agent.spec_json as { metadata?: Record<string, unknown> }).metadata
      if (metadata?.stoppedByUser === true && task.mode === "collab") {
        tx.update(ScheduledTaskTable)
          .set({ status: "canceled", canceled_at: now, time_updated: now })
          .where(eq(ScheduledTaskTable.id, task.id))
          .run()
        return
      }
      if (metadata?.stoppedByUser === true && CollabAgentNode.isExperiment(CollabAgentNode.load(agent.id))) {
        CollabAgentNode.restoreExperiment(agent.id)
        agent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, task.agent_id)).get()
        if (!agent) return
      }
      if ((agent.spec_json as { metadata?: Record<string, unknown> }).metadata?.stoppedByUser === true) return
      const collab = task.mode === "collab" && active.has(agent.status) && !!task.run_id && task.run_id === agent.run_id
      const payload: ScheduledTaskDuePayload = {
        scheduledTaskId: task.id,
        dueAt: task.due_at,
        prompt: task.prompt,
      }
      const message = CollabMessage.post({
        recipientAgentId: task.agent_id,
        senderAgentId: null,
        runId: collab ? task.run_id : null,
        expectedRunId: agent.run_id,
        kind: collab ? "scheduled_task_due" : "session_scheduled_task_due",
        payload,
      })
      if (!message) throw new Error(`failed to post callback for scheduled task ${task.id}`)
      tx.update(ScheduledTaskTable)
        .set({
          status: "fired",
          mode: collab ? "collab" : "direct",
          run_id: collab ? task.run_id : null,
          callback_message_id: message,
          fired_at: now,
          time_updated: now,
        })
        .where(and(eq(ScheduledTaskTable.id, task.id), eq(ScheduledTaskTable.status, "pending")))
        .run()
      return message
    })
  }

  export async function fireDue(now = Date.now()) {
    const rows = Database.use((db) =>
      db
        .select({ id: ScheduledTaskTable.id })
        .from(ScheduledTaskTable)
        .innerJoin(CollabAgentTable, eq(CollabAgentTable.id, ScheduledTaskTable.agent_id))
        .where(
          and(
            eq(CollabAgentTable.project_id, Instance.project.id),
            eq(ScheduledTaskTable.status, "pending"),
            lte(ScheduledTaskTable.due_at, now),
          ),
        )
        .all(),
    )
    const results = await Promise.allSettled(rows.map((task) => Promise.resolve().then(() => fire(task.id, now))))
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return
      log.error("failed to fire scheduled task", { id: rows[index]?.id, error: String(result.reason) })
    })
  }

  export function init() {
    Scheduler.register({
      id: "scheduled-task",
      interval: INTERVAL,
      run: () => fireDue(),
      scope: "instance",
    })
  }
}
