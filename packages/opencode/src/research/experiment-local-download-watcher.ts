import { Scheduler } from "../scheduler"
import { Database, eq, ne, and } from "../storage/db"
import { LocalDownloadWatchTable } from "./research.sql"
import { Log } from "../util/log"
import { Filesystem } from "../util/filesystem"
import { ExperimentExecutionWatch } from "./experiment-execution-watch"

const log = Log.create({ service: "experiment-local-download-watcher" })

const POLL_INTERVAL = 30 * 1000

function alive(pid?: number | null) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function state(path?: string | null) {
  if (!path || !(await Filesystem.exists(path))) return
  const text = (await Filesystem.readText(path)).trim()
  if (!text) return
  if (text.startsWith("{")) {
    try {
      const json = JSON.parse(text) as { status?: string; error?: string; exit_code?: number }
      if (json.status) return json
    } catch {}
  }
  return { status: text }
}

async function refresh(watch: typeof LocalDownloadWatchTable.$inferSelect) {
  const now = Date.now()
  const mark = await state(watch.status_path)
  if (mark?.status === "finished") {
    Database.use((db) =>
      db
        .update(LocalDownloadWatchTable)
        .set({ status: "finished", error_message: null, last_polled_at: now, time_updated: now })
        .where(eq(LocalDownloadWatchTable.watch_id, watch.watch_id))
        .run(),
    )
    ExperimentExecutionWatch.syncLocalDownload(watch.exp_id)
    return "finished"
  }
  if (mark?.status === "failed") {
    Database.use((db) =>
      db
        .update(LocalDownloadWatchTable)
        .set({
          status: "failed",
          error_message:
            mark.error ?? `Background download failed${watch.status_path ? ` (${watch.status_path})` : ""}`,
          last_polled_at: now,
          time_updated: now,
        })
        .where(eq(LocalDownloadWatchTable.watch_id, watch.watch_id))
        .run(),
    )
    ExperimentExecutionWatch.syncLocalDownload(watch.exp_id)
    return "failed"
  }
  if (alive(watch.pid)) {
    Database.use((db) =>
      db
        .update(LocalDownloadWatchTable)
        .set({ status: "running", last_polled_at: now, time_updated: now })
        .where(eq(LocalDownloadWatchTable.watch_id, watch.watch_id))
        .run(),
    )
    ExperimentExecutionWatch.syncLocalDownload(watch.exp_id)
    return "running"
  }
  Database.use((db) =>
    db
      .update(LocalDownloadWatchTable)
      .set({
        status: "failed",
        error_message: watch.error_message ?? "Background download stopped without a finished marker",
        last_polled_at: now,
        time_updated: now,
      })
      .where(eq(LocalDownloadWatchTable.watch_id, watch.watch_id))
      .run(),
  )
  ExperimentExecutionWatch.syncLocalDownload(watch.exp_id)
  return "failed"
}

async function pollAll() {
  const watches = Database.use((db) =>
    db
      .select()
      .from(LocalDownloadWatchTable)
      .where(
        and(
          ne(LocalDownloadWatchTable.status, "finished"),
          ne(LocalDownloadWatchTable.status, "failed"),
          ne(LocalDownloadWatchTable.status, "crashed"),
        ),
      )
      .all(),
  )
  if (!watches.length) return
  log.info("polling local downloads", { count: watches.length })
  for (const watch of watches) {
    await refresh(watch)
  }
}

export async function forceRefreshLocalDownload(expId: string) {
  const watches = Database.use((db) =>
    db.select().from(LocalDownloadWatchTable).where(eq(LocalDownloadWatchTable.exp_id, expId)).all(),
  )
  if (!watches.length) {
    ExperimentExecutionWatch.syncLocalDownload(expId)
    return { success: true, message: "no local download watches found" }
  }
  const states = await Promise.all(watches.map(refresh))
  return { success: true, message: `local download refresh: ${states.join(", ")}` }
}

export namespace ExperimentLocalDownloadWatcher {
  export function init() {
    Scheduler.register({
      id: "experiment.local-download-watcher",
      interval: POLL_INTERVAL,
      run: pollAll,
      scope: "instance",
    })
  }
}
