import { Scheduler } from "@/scheduler"
import { Log } from "@/util/log"
import { ExperimentRemoteTask } from "./experiment-remote-task"
import { control, exitCodeFromTail, inspectRemoteTask, parseInspectOutput } from "./remote-task-runner"
import { normalizeRemoteServerConfig } from "./remote-server"

const log = Log.create({ service: "experiment-remote-task-watcher" })
const POLL_INTERVAL = 30 * 1000
const START_GRACE = 3 * 60 * 1000
const STOP_GRACE = 10 * 1000

const alive = new Set(["running", "attached", "detached"])

export type RemoteTaskInspection = {
  taskId: string
  result: Awaited<ReturnType<typeof inspectRemoteTask>>
  meta: ReturnType<typeof parseInspectOutput>
}

async function refresh(task: ReturnType<typeof ExperimentRemoteTask.listByExp>[number], preserveStage = false) {
  const now = Date.now()
  const server = normalizeRemoteServerConfig(JSON.parse(task.server))
  const logPath = task.log_path
  if (!logPath) {
    if (ExperimentRemoteTask.isTerminal(task.status)) return
    if (task.status === "pending" && task.time_created + START_GRACE > now) return
    ExperimentRemoteTask.update(
      {
        taskId: task.task_id,
        status: "failed",
        errorMessage: "remote task log path missing",
      },
      { preserveStage },
    )
    return
  }

  const paths = control(task.remote_root, task.task_id, task.screen_name)
  const result = await inspectRemoteTask({
    server,
    logPath,
    screenName: task.screen_name,
    exitPath: paths.exitPath,
    pendingPath: paths.pendingPath,
    targetPath: task.target_path,
  })
  const meta = parseInspectOutput(result.output)
  const code = meta.code ?? (meta.managed ? undefined : exitCodeFromTail(meta.tail))
  let next: typeof task.status = "running"
  let err: string | null = null
  let stoppedAt: number | null = null

  if (!result.ok) {
    next = "running"
    err = `remote task inspect failed: ${result.output || "unknown error"}`
  } else if (code === 0 && (task.kind === "experiment_run" || meta.target === "present" || !task.target_path))
    next = "finished"
  else if (code !== undefined && code !== 0) {
    next = "failed"
    err = meta.tail || `remote task exited with code ${code}`
  } else if (alive.has(meta.screen)) next = "running"
  else if (code !== undefined) {
    next = "failed"
    err = meta.tail || `remote task exited with code ${code}`
  } else if (meta.screen === "dead") {
    const lines = meta.tail
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
    const note = lines.filter((item) => !item.startsWith("START ") && item !== "START").at(-1)
    next = "failed"
    err = note
      ? `remote task screen is dead before writing completion marker: ${note}`
      : "remote task screen is dead before writing completion marker"
  } else {
    stoppedAt = task.stopped_at ?? now
    if (stoppedAt + STOP_GRACE > now) {
      next = "running"
      err = null
    } else {
      const lines = meta.tail
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
      const note = lines.filter((item) => !item.startsWith("START ") && item !== "START").at(-1)
      next = "failed"
      err = note
        ? `remote task stopped before writing completion marker: ${note}`
        : "remote task stopped before writing completion marker"
    }
  }

  if (ExperimentRemoteTask.isTerminal(task.status) && !ExperimentRemoteTask.isTerminal(next)) {
    return { taskId: task.task_id, result, meta } satisfies RemoteTaskInspection
  }

  ExperimentRemoteTask.update(
    {
      taskId: task.task_id,
      status: next,
      errorMessage: err,
      lastPolledAt: now,
      stoppedAt,
    },
    { preserveStage },
  )
  return { taskId: task.task_id, result, meta } satisfies RemoteTaskInspection
}

async function pollAll() {
  const tasks = ExperimentRemoteTask.listActive()
  if (!tasks.length) return
  log.info("polling remote tasks", { count: tasks.length })
  for (const task of tasks) {
    await refresh(task, true).catch((err) => {
      log.error("remote task poll failed", { taskId: task.task_id, error: String(err) })
    })
  }
}

export async function forceRefreshRemoteTask(expId: string, opts?: { preserveStage?: boolean; taskId?: string }) {
  const tasks = ExperimentRemoteTask.listByExp(expId)
  if (!tasks.length) return { success: true, message: "no remote tasks found", inspections: [] }
  if (opts?.taskId) {
    const task = ExperimentRemoteTask.get(opts.taskId)
    if (!task || task.exp_id !== expId)
      return { success: false, message: `remote task not found: ${opts.taskId}`, inspections: [] }
    const inspection = await refresh(task, opts.preserveStage)
    return {
      success: true,
      message: "remote task refresh complete",
      inspections: inspection ? [inspection] : [],
    }
  }
  const active = tasks.filter((item) => !["finished", "failed", "crashed", "canceled"].includes(item.status))
  const rows = active.length ? active : [tasks.sort((a, b) => b.time_updated - a.time_updated)[0]]
  const inspections: RemoteTaskInspection[] = []
  for (const task of rows) {
    const inspection = await refresh(task, opts?.preserveStage)
    if (inspection) inspections.push(inspection)
  }
  return { success: true, message: "remote task refresh complete", inspections }
}

export namespace ExperimentRemoteTaskWatcher {
  export function init() {
    Scheduler.register({
      id: "experiment.remote-task-watcher",
      interval: POLL_INTERVAL,
      run: pollAll,
      scope: "instance",
    })
  }
}
