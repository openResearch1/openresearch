import z from "zod"
import { Tool } from "./tool"
import { ExperimentRemoteTask } from "@/research/experiment-remote-task"
import { forceRefreshRemoteTask } from "@/research/experiment-remote-task-watcher"
import { ExperimentTable, RemoteServerTable } from "@/research/research.sql"
import {
  inspectRemoteTask,
  parseInspectOutput,
  readRemoteTaskLog,
  session,
  startRemoteTask,
} from "@/research/remote-task-runner"
import { normalizeRemoteServerConfig, remoteServerLabel } from "@/research/remote-server"
import { Database, eq } from "@/storage/db"

const kind = z.enum(["resource_download", "experiment_run", "env_setup"])

const blocked = [/\bscreen\s+-d/, /\bnohup\b/, /\bssh(pass)?\b/, /<<['"]?[A-Z_]+['"]?/, /\bbash\s+-s\b/]

function summary(task: ReturnType<typeof ExperimentRemoteTask.listByExp>[number]) {
  return {
    taskId: task.task_id,
    expId: task.exp_id,
    kind: task.kind,
    title: task.title,
    status: task.status,
    resourceKey: task.resource_key,
    targetPath: task.target_path,
    screenName: task.screen_name,
    logPath: task.log_path,
    sourceSelection: task.source_selection,
    method: task.method,
    timeCreated: task.time_created,
    timeUpdated: task.time_updated,
  }
}

export function assertRawRemoteCommand(command: string) {
  const value = command.trim()
  if (!value) throw new Error("command must be a non-empty raw remote command")
  if (!blocked.some((rule) => rule.test(value))) return value
  throw new Error(
    "command must be the raw remote business command only; do not include ssh, sshpass, screen, nohup, heredoc, or other wrapper layers",
  )
}

function server(expId: string) {
  const exp = Database.use((db) => db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, expId)).get())
  if (!exp) throw new Error(`experiment not found: ${expId}`)
  if (!exp.remote_server_id) throw new Error(`experiment has no remote server: ${expId}`)
  const row = Database.use((db) =>
    db.select().from(RemoteServerTable).where(eq(RemoteServerTable.id, exp.remote_server_id!)).get(),
  )
  if (!row) throw new Error(`remote server not found: ${exp.remote_server_id}`)
  return normalizeRemoteServerConfig(JSON.parse(row.config))
}

export const ExperimentRemoteTaskStartTool = Tool.define("experiment_remote_task_start", {
  description:
    "Start a remote long-running experiment task. Pass only the raw remote business command; this tool owns the ssh/heredoc/screen wrapper.",
  parameters: z.object({
    expId: z.string().describe("Experiment ID for the task record."),
    kind,
    title: z.string().describe("Short task title shown in watches."),
    remoteRoot: z.string().describe("Remote root used for remote task logs and control directory."),
    command: z
      .string()
      .describe(
        "Raw remote business command only, such as a modelscope download or training command. Do not include ssh, sshpass, screen, nohup, heredoc, or wrapper scripts.",
      ),
    resourceKey: z.string().optional().describe("Stable resource key for resource download deduplication."),
    targetPath: z.string().nullable().optional().describe("Final remote target path produced by the command."),
    sourceSelection: z
      .string()
      .nullable()
      .optional()
      .describe("Chosen source label such as modelscope or huggingface."),
    method: z.string().nullable().optional().describe("Download or run method label for display."),
  }),
  async execute(params) {
    const command = assertRawRemoteCommand(params.command)
    const cfg = server(params.expId)
    const task = ExperimentRemoteTask.create({
      expId: params.expId,
      kind: params.kind,
      resourceKey: params.resourceKey,
      title: params.title,
      server: JSON.stringify(cfg),
      remoteRoot: params.remoteRoot,
      targetPath: params.targetPath ?? null,
      screenName: session(params.resourceKey ? `${params.expId}-${params.resourceKey}` : params.expId),
      command,
      sourceSelection: params.sourceSelection ?? null,
      method: params.method ?? null,
    })
    const result = await startRemoteTask({
      server: cfg,
      taskId: task.task_id,
      remoteRoot: params.remoteRoot,
      screenName: task.screen_name,
      command,
    })
    if (!result.ok) {
      ExperimentRemoteTask.update({ taskId: task.task_id, status: "failed", errorMessage: result.output || "failed" })
      throw new Error(result.output || "failed to start remote task")
    }
    const updated = ExperimentRemoteTask.update({
      taskId: task.task_id,
      status: "running",
      logPath: result.logPath,
      errorMessage: null,
    })
    return {
      title: `Remote task: ${updated?.title ?? task.title}`,
      output: [
        `Task ID: ${task.task_id}`,
        `Server: ${remoteServerLabel(cfg)}`,
        `Screen: ${task.screen_name}`,
        `Log: ${result.logPath}`,
      ].join("\n"),
      metadata: { taskId: task.task_id, screenName: task.screen_name },
    }
  },
})

export const ExperimentRemoteTaskGetTool = Tool.define("experiment_remote_task_get", {
  description:
    "Get a remote task for an experiment. Pass taskId to inspect a specific task; otherwise returns the current active task when present, then the latest task.",
  parameters: z.object({
    expId: z.string().describe("Experiment ID to inspect."),
    taskId: z
      .string()
      .optional()
      .describe("Optional remote task ID to inspect exactly. If omitted, uses legacy current-task behavior."),
    waitForTerminal: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "For running env_setup/resource_download tasks, wait until the remote task reaches a terminal status before returning.",
      ),
    waitTimeoutMs: z
      .number()
      .positive()
      .optional()
      .describe("Optional maximum time to wait for terminal status in milliseconds."),
  }),
  async execute(params, ctx) {
    if (params.taskId) {
      const existing = ExperimentRemoteTask.get(params.taskId)
      if (!existing) throw new Error(`remote task not found: ${params.taskId}`)
      if (existing.exp_id !== params.expId)
        throw new Error(`remote task does not belong to experiment: ${params.taskId}`)
    }
    await forceRefreshRemoteTask(params.expId, { taskId: params.taskId })
    let task = params.taskId ? ExperimentRemoteTask.get(params.taskId) : ExperimentRemoteTask.current(params.expId)
    if (!task) {
      throw new Error(
        params.taskId
          ? `remote task not found: ${params.taskId}`
          : `no remote task found for experiment: ${params.expId}`,
      )
    }
    if (task.exp_id !== params.expId) {
      throw new Error(`remote task does not belong to experiment: ${params.taskId}`)
    }
    let waited = false
    if (
      params.waitForTerminal &&
      task.status === "running" &&
      (task.kind === "env_setup" || task.kind === "resource_download")
    ) {
      waited = true
      await ctx.metadata({
        title: `Waiting: ${task.title}`,
        metadata: {
          phase: "waiting_terminal",
          message: "Waiting for remote task to finish",
          taskId: task.task_id,
          expId: params.expId,
          kind: task.kind,
          title: task.title,
          status: task.status,
        },
      })
      task = await ExperimentRemoteTask.waitTerminal({
        taskId: task.task_id,
        signal: ctx.abort,
        timeoutMs: params.waitTimeoutMs,
      })
    }
    const server = normalizeRemoteServerConfig(JSON.parse(task.server))
    const live = task.log_path
      ? await inspectRemoteTask({
          server,
          logPath: task.log_path,
          screenName: task.screen_name,
          targetPath: task.target_path,
        })
      : null
    const tail = task.log_path ? await readRemoteTaskLog({ server, logPath: task.log_path, lines: 20 }) : null
    const screen = live
      ? parseInspectOutput(live.output).screen || "unknown"
      : task.status === "running"
        ? "unknown"
        : "stopped"
    const error = task.status === "failed" || task.status === "crashed" ? task.error_message : null

    return {
      title: `Remote task: ${task.title}`,
      output: [
        `Task ID: ${task.task_id}`,
        `Kind: ${task.kind}`,
        `Title: ${task.title}`,
        `Status: ${task.status}`,
        waited ? `Waited: terminal` : null,
        `Screen: ${screen}`,
        `Server: ${remoteServerLabel(server)}`,
        `Log: ${task.log_path ?? "-"}`,
        task.error_message ? `Error: ${task.error_message}` : null,
        "",
        "Last 20 log lines:",
        tail?.output || "(log unavailable)",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        taskId: task.task_id,
        expId: params.expId,
        kind: task.kind,
        title: task.title,
        status: task.status,
        waited,
        terminal: ExperimentRemoteTask.isTerminal(task.status),
        phase: waited ? "terminal" : "inspected",
        screen,
        logPath: task.log_path,
        errorMessage: error,
        tail: tail?.output || "",
      },
    }
  },
})

export const ExperimentRemoteTaskListTool = Tool.define("experiment_remote_task_list", {
  description:
    "List all active remote tasks for an experiment ID so a caller can choose a taskId for exact inspection.",
  parameters: z.object({
    expId: z.string().describe("Experiment ID whose active remote tasks should be listed."),
  }),
  async execute(params) {
    await forceRefreshRemoteTask(params.expId)
    const tasks = ExperimentRemoteTask.listActiveByExp(params.expId)
    return {
      title: `${tasks.length} active remote task(s)`,
      output: tasks.length
        ? tasks
            .map((task) => {
              const item = summary(task)
              return [
                `Task ID: ${item.taskId}`,
                `Kind: ${item.kind}`,
                `Title: ${item.title}`,
                `Status: ${item.status}`,
                item.resourceKey ? `Resource: ${item.resourceKey}` : null,
                item.targetPath ? `Target: ${item.targetPath}` : null,
                item.logPath ? `Log: ${item.logPath}` : null,
              ]
                .filter(Boolean)
                .join("\n")
            })
            .join("\n\n")
        : "No active remote tasks.",
      metadata: { tasks: tasks.map(summary) },
    }
  },
})
