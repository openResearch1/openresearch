import { and, Database, eq } from "../storage/db"
import { ExperimentExecutionWatchTable, ExperimentTable, ExperimentWatchTable, RemoteTaskTable } from "./research.sql"

type ExecutionStatus = typeof ExperimentExecutionWatchTable.$inferSelect.status
type ExecutionStage = typeof ExperimentExecutionWatchTable.$inferSelect.stage
type Task = typeof RemoteTaskTable.$inferSelect

interface UpdateInput {
  expId?: string
  watchId?: string
  status?: ExecutionStatus
  stage?: ExecutionStage
  title?: string
  message?: string | null
  wandbEntity?: string | null
  wandbProject?: string | null
  wandbRunId?: string | null
  errorMessage?: string | null
  startedAt?: number | null
  finishedAt?: number | null
}

interface SyncOptions {
  preserveStage?: boolean
}

function row(input: { expId?: string; watchId?: string }) {
  if (input.watchId) {
    return Database.use((db) =>
      db
        .select()
        .from(ExperimentExecutionWatchTable)
        .where(eq(ExperimentExecutionWatchTable.watch_id, input.watchId!))
        .get(),
    )
  }
  if (!input.expId) return
  return Database.use((db) =>
    db.select().from(ExperimentExecutionWatchTable).where(eq(ExperimentExecutionWatchTable.exp_id, input.expId!)).get(),
  )
}

function tasks(expId: string) {
  return Database.use((db) => db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, expId)).all()).sort(
    (a, b) => b.time_updated - a.time_updated,
  )
}

function active(task: Task) {
  return task.status === "pending" || task.status === "running"
}

function status(task: Task): ExecutionStatus {
  if (task.status === "finished") return "finished"
  if (task.status === "failed" || task.status === "crashed") return "failed"
  if (task.status === "canceled") return "canceled"
  return "running"
}

function stage(task: Task): ExecutionStage {
  if (task.kind === "env_setup") return "setting_up_env"
  if (task.kind === "resource_download") return "remote_downloading"
  return "running_experiment"
}

function message(task: Task) {
  if (task.status === "finished") return `${task.title} finished`
  if (task.status === "failed" || task.status === "crashed") return task.error_message ?? `${task.title} failed`
  return task.title
}

function finished(task: Task) {
  return (
    task.status === "finished" || task.status === "failed" || task.status === "crashed" || task.status === "canceled"
  )
}

export namespace ExperimentExecutionWatch {
  export function createOrGet(expId: string, title: string, stage: ExecutionStage = "planning") {
    const existing = row({ expId })
    if (existing) return existing
    const now = Date.now()
    const watchId = crypto.randomUUID()
    Database.use((db) =>
      db
        .insert(ExperimentExecutionWatchTable)
        .values({
          watch_id: watchId,
          exp_id: expId,
          status: "pending",
          stage,
          title,
          started_at: now,
          time_created: now,
          time_updated: now,
        })
        .run(),
    )
    return row({ watchId })!
  }

  export function update(input: UpdateInput) {
    const existing = row(input)
    if (!existing) return
    const now = Date.now()
    Database.use((db) =>
      db
        .update(ExperimentExecutionWatchTable)
        .set({
          status: input.status ?? existing.status,
          stage: input.stage ?? existing.stage,
          title: input.title ?? existing.title,
          message: input.message === undefined ? existing.message : input.message,
          wandb_entity: input.wandbEntity === undefined ? existing.wandb_entity : input.wandbEntity,
          wandb_project: input.wandbProject === undefined ? existing.wandb_project : input.wandbProject,
          wandb_run_id: input.wandbRunId === undefined ? existing.wandb_run_id : input.wandbRunId,
          error_message: input.errorMessage === undefined ? existing.error_message : input.errorMessage,
          started_at: input.startedAt === undefined ? existing.started_at : input.startedAt,
          finished_at: input.finishedAt === undefined ? existing.finished_at : input.finishedAt,
          time_updated: now,
        })
        .where(eq(ExperimentExecutionWatchTable.watch_id, existing.watch_id))
        .run(),
    )
  }

  export function deleteByExp(expId: string) {
    Database.use((db) =>
      db.delete(ExperimentExecutionWatchTable).where(eq(ExperimentExecutionWatchTable.exp_id, expId)).run(),
    )
  }

  export function findInternal(expId: string, runId: string) {
    return Database.use((db) =>
      db
        .select()
        .from(ExperimentWatchTable)
        .where(and(eq(ExperimentWatchTable.exp_id, expId), eq(ExperimentWatchTable.wandb_run_id, runId)))
        .get(),
    )
  }

  export function syncWatch(expId: string, watch: typeof ExperimentWatchTable.$inferSelect, _opts?: SyncOptions) {
    createOrGet(expId, title(expId))
    update({
      expId,
      status: watch.status === "finished" ? "finished" : watch.status === "running" ? "running" : "failed",
      stage: undefined,
      wandbEntity: watch.wandb_entity,
      wandbProject: watch.wandb_project,
      wandbRunId: watch.wandb_run_id,
      message: undefined,
      errorMessage: watch.status === "finished" ? null : watch.error_message,
      finishedAt:
        watch.status === "finished" || watch.status === "failed" || watch.status === "crashed" ? Date.now() : null,
    })
  }

  export function syncRemoteTask(expId: string, _opts?: SyncOptions) {
    createOrGet(expId, title(expId))
    const exp = Database.use((db) => db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, expId)).get())
    if (exp?.kind !== "project_runtime") return
    const rows = tasks(expId)
    const current = rows.filter(active)
    const head = current[0] ?? rows[0]
    if (!head) return
    update({
      expId,
      status: current.length ? "running" : status(head),
      stage: current.some((item) => item.kind === "env_setup")
        ? "setting_up_env"
        : current.some((item) => item.kind === "resource_download")
          ? "remote_downloading"
          : stage(head),
      message: current.length > 1 ? `${current.length} remote tasks running` : message(head),
      errorMessage: current.length
        ? null
        : head.status === "failed" || head.status === "crashed"
          ? head.error_message
          : null,
      finishedAt: current.length ? null : finished(head) ? head.time_updated : null,
    })
  }

  export function title(expId: string) {
    const exp = Database.use((db) => db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, expId)).get())
    return exp?.atom_id ? `${exp.exp_id} (${exp.atom_id})` : expId
  }
}
