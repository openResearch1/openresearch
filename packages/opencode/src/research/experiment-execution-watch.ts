import { and, Database, eq } from "../storage/db"
import {
  ExperimentExecutionWatchTable,
  ExperimentTable,
  ExperimentWatchTable,
  LocalDownloadWatchTable,
} from "./research.sql"

type ExecutionStatus = typeof ExperimentExecutionWatchTable.$inferSelect.status
type ExecutionStage = typeof ExperimentExecutionWatchTable.$inferSelect.stage

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

export namespace ExperimentExecutionWatch {
  export function createOrGet(expId: string, title: string) {
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
          stage: "planning",
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

  export function syncWatch(expId: string, watch: typeof ExperimentWatchTable.$inferSelect) {
    createOrGet(expId, title(expId))
    update({
      expId,
      status: watch.status === "finished" ? "finished" : watch.status === "running" ? "running" : "failed",
      stage: "watching_wandb",
      wandbEntity: watch.wandb_entity,
      wandbProject: watch.wandb_project,
      wandbRunId: watch.wandb_run_id,
      message:
        watch.status === "finished"
          ? "Experiment finished successfully"
          : watch.status === "running"
            ? "Monitoring W&B run"
            : `Experiment ended with W&B state: ${watch.wandb_state ?? watch.status}`,
      errorMessage: watch.status === "finished" ? null : watch.error_message,
      finishedAt:
        watch.status === "finished" || watch.status === "failed" || watch.status === "crashed" ? Date.now() : null,
    })
  }

  export function syncLocalDownload(expId: string) {
    createOrGet(expId, title(expId))
    const rows = Database.use((db) =>
      db.select().from(LocalDownloadWatchTable).where(eq(LocalDownloadWatchTable.exp_id, expId)).all(),
    )
    if (!rows.length) {
      update({
        expId,
        status: "running",
        stage: "local_downloading",
        message: "Waiting for local download to start",
        errorMessage: null,
      })
      return
    }

    const done = rows.filter((row) => row.status === "finished").length
    const failed = rows.find((row) => row.status === "failed" || row.status === "crashed")
    const running = rows.find((row) => row.status === "running" || row.status === "pending")

    if (failed) {
      update({
        expId,
        status: "failed",
        stage: "local_downloading",
        message: `Local download failed for ${failed.resource_name}`,
        errorMessage: failed.error_message,
        finishedAt: null,
      })
      return
    }

    if (running) {
      update({
        expId,
        status: "running",
        stage: "local_downloading",
        message: `Preparing local resources (${done}/${rows.length} finished)`,
        errorMessage: null,
        finishedAt: null,
      })
      return
    }

    update({
      expId,
      status: "running",
      stage: "local_downloading",
      message: "Local downloads finished, waiting for experiment resume",
      errorMessage: null,
      finishedAt: null,
    })
  }

  export function title(expId: string) {
    const exp = Database.use((db) => db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, expId)).get())
    return exp?.atom_id ? `${exp.exp_id} (${exp.atom_id})` : expId
  }
}
