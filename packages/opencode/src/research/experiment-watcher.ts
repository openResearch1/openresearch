import { Scheduler } from "../scheduler"
import { Database, eq, and, ne } from "../storage/db"
import { ExperimentTable, ExperimentWatchTable } from "./research.sql"
import { Log } from "../util/log"
import { Filesystem } from "../util/filesystem"
import path from "path"

const log = Log.create({ service: "experiment-watcher" })

const POLL_INTERVAL = 3 * 60 * 1000 // 3 minutes
const WANDB_GRAPHQL = "https://api.wandb.ai/graphql"
const TERMINAL_STATES = ["finished", "failed", "crashed"]

interface WandbRunResult {
  state: string
  summaryMetrics: string | null
  config: string | null
}

async function fetchWandbRun(
  apiKey: string,
  entity: string,
  project: string,
  runName: string,
): Promise<WandbRunResult | null> {
  try {
    const resp = await fetch(WANDB_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query: `query ($entity: String!, $project: String!, $runName: String!) {
          project(name: $project, entityName: $entity) {
            runs(filters: $runName) {
              edges { node { name state summaryMetrics config } }
            }
          }
        }`,
        variables: {
          entity,
          project,
          runName: JSON.stringify({ name: runName }),
        },
      }),
    })
    if (!resp.ok) {
      log.error("wandb api error", { status: resp.status })
      return null
    }
    const data = (await resp.json()) as any
    const edges = data?.data?.project?.runs?.edges
    if (!edges || edges.length === 0) return null
    const node = edges[0].node
    return {
      state: node.state,
      summaryMetrics: node.summaryMetrics ?? null,
      config: node.config ?? null,
    }
  } catch (err: any) {
    log.error("wandb fetch failed", { error: err?.message })
    return null
  }
}

async function pollAll() {
  const watches = Database.use((db) =>
    db
      .select()
      .from(ExperimentWatchTable)
      .where(
        and(
          ne(ExperimentWatchTable.status, "finished"),
          ne(ExperimentWatchTable.status, "failed"),
          ne(ExperimentWatchTable.status, "crashed"),
        ),
      )
      .all(),
  )

  if (watches.length === 0) return

  log.info("polling experiments", { count: watches.length })

  for (const watch of watches) {
    const now = Date.now()

    const run = await fetchWandbRun(watch.wandb_api_key, watch.wandb_entity, watch.wandb_project, watch.wandb_run_id)

    if (!run) {
      // Could not reach wandb or run not found, update polled time and skip
      Database.use((db) =>
        db
          .update(ExperimentWatchTable)
          .set({ last_polled_at: now, time_updated: now })
          .where(eq(ExperimentWatchTable.watch_id, watch.watch_id))
          .run(),
      )
      continue
    }

    const isTerminal = TERMINAL_STATES.includes(run.state)
    const newStatus = isTerminal ? (run.state as "finished" | "failed" | "crashed") : "running"

    // Update watch record
    Database.use((db) =>
      db
        .update(ExperimentWatchTable)
        .set({
          status: newStatus,
          wandb_state: run.state,
          last_polled_at: now,
          time_updated: now,
        })
        .where(eq(ExperimentWatchTable.watch_id, watch.watch_id))
        .run(),
    )

    // If terminal, pull results and update experiment
    if (isTerminal) {
      log.info("experiment finished", { watchId: watch.watch_id, expId: watch.exp_id, state: run.state })

      // Get experiment to find exp_result_path
      const experiment = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, watch.exp_id)).get(),
      )

      if (experiment?.exp_result_path) {
        const resultDir = path.join(experiment.exp_result_path, watch.wandb_run_id)

        // Save summary.json
        if (run.summaryMetrics) {
          try {
            const parsed = JSON.parse(run.summaryMetrics)
            await Filesystem.write(path.join(resultDir, "summary.json"), JSON.stringify(parsed, null, 2))
          } catch {
            await Filesystem.write(path.join(resultDir, "summary.json"), run.summaryMetrics)
          }
        }

        // Save config.json
        if (run.config) {
          try {
            const parsed = JSON.parse(run.config)
            await Filesystem.write(path.join(resultDir, "config.json"), JSON.stringify(parsed, null, 2))
          } catch {
            await Filesystem.write(path.join(resultDir, "config.json"), run.config)
          }
        }
      }

      // Update experiment status
      const expStatus = run.state === "finished" ? "done" : "failed"
      Database.use((db) =>
        db
          .update(ExperimentTable)
          .set({
            status: expStatus as any,
            finished_at: now,
            time_updated: now,
          })
          .where(eq(ExperimentTable.exp_id, watch.exp_id))
          .run(),
      )
    }
  }
}

export async function forceRefreshWatch(watchId: string): Promise<{ success: boolean; message: string }> {
  const watch = Database.use((db) =>
    db.select().from(ExperimentWatchTable).where(eq(ExperimentWatchTable.watch_id, watchId)).get(),
  )
  if (!watch) {
    return { success: false, message: `watch not found: ${watchId}` }
  }

  const run = await fetchWandbRun(watch.wandb_api_key, watch.wandb_entity, watch.wandb_project, watch.wandb_run_id)
  if (!run) {
    return { success: false, message: "failed to fetch wandb run data" }
  }

  const now = Date.now()
  const isTerminal = TERMINAL_STATES.includes(run.state)
  const newStatus = isTerminal ? (run.state as "finished" | "failed" | "crashed") : "running"

  // Update watch record
  Database.use((db) =>
    db
      .update(ExperimentWatchTable)
      .set({
        status: newStatus,
        wandb_state: run.state,
        last_polled_at: now,
        time_updated: now,
      })
      .where(eq(ExperimentWatchTable.watch_id, watch.watch_id))
      .run(),
  )

  // Always overwrite summary and config if available
  const experiment = Database.use((db) =>
    db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, watch.exp_id)).get(),
  )

  if (experiment?.exp_result_path) {
    const resultDir = path.join(experiment.exp_result_path, watch.wandb_run_id)

    if (run.summaryMetrics) {
      try {
        const parsed = JSON.parse(run.summaryMetrics)
        await Filesystem.write(path.join(resultDir, "summary.json"), JSON.stringify(parsed, null, 2))
      } catch {
        await Filesystem.write(path.join(resultDir, "summary.json"), run.summaryMetrics)
      }
    }

    if (run.config) {
      try {
        const parsed = JSON.parse(run.config)
        await Filesystem.write(path.join(resultDir, "config.json"), JSON.stringify(parsed, null, 2))
      } catch {
        await Filesystem.write(path.join(resultDir, "config.json"), run.config)
      }
    }
  }

  // If terminal, also update experiment status
  if (isTerminal) {
    const expStatus = run.state === "finished" ? "done" : "failed"
    Database.use((db) =>
      db
        .update(ExperimentTable)
        .set({
          status: expStatus as any,
          finished_at: now,
          time_updated: now,
        })
        .where(eq(ExperimentTable.exp_id, watch.exp_id))
        .run(),
    )
  }

  return { success: true, message: `refreshed, wandb state: ${run.state}` }
}

export namespace ExperimentWatcher {
  export function init() {
    Scheduler.register({
      id: "experiment.watcher",
      interval: POLL_INTERVAL,
      run: pollAll,
      scope: "instance",
    })
  }
}
