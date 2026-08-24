import z from "zod"
import { Collab } from "@/collab"
import { Tool } from "./tool"
import { ExperimentRemoteTask } from "@/research/experiment-remote-task"
import { ExperimentRemoteTaskListener } from "@/research/experiment-remote-task-listener"
import { forceRefreshRemoteTask } from "@/research/experiment-remote-task-watcher"
import { ExperimentTable, RemoteServerTable } from "@/research/research.sql"
import {
  control,
  inspectRemoteTask,
  parseInspectOutput,
  session,
  startRemoteTask,
} from "@/research/remote-task-runner"
import { normalizeRemoteServerConfig, remoteServerLabel } from "@/research/remote-server"
import { Database, eq } from "@/storage/db"

const kind = z.enum(["resource_download", "experiment_run", "env_setup"])

const blocked = [/\bscreen\s+-d/, /\bnohup\b/, /\bssh(pass)?\b/]

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
  if (!command.trim()) throw new Error("command must be a non-empty remote command or multiline shell script")
  if (!blocked.some((rule) => rule.test(command))) return command
  throw new Error(
    "command must be an unwrapped remote business command or multiline shell script; do not include ssh, sshpass, screen, nohup, or other task-management wrappers",
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
    "Start a remote long-running experiment task from an unattended business command or multiline shell script. The tool owns SSH transport, screen detachment, PTY logging, and completion tracking.",
  parameters: z.object({
    expId: z.string().describe("Experiment ID for the task record."),
    kind,
    title: z.string().describe("Short task title shown in watches."),
    remoteRoot: z.string().describe("Remote root used for remote task logs and control directory."),
    command: z
      .string()
      .describe(
        "Unattended remote business command or multiline shell script. Normal shell syntax, business-level heredocs, and application-owned tee or redirection are allowed. Do not add ssh/sshpass, screen/nohup, polling, or tee/redirection solely for the managed task log.",
      ),
    resourceKey: z.string().optional().describe("Stable resource key associated with the remote task."),
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
    }).catch((err) => {
      ExperimentRemoteTask.update({
        taskId: task.task_id,
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      throw err
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
      .describe("For active tasks, wait until the remote task reaches a terminal status before returning."),
    waitTimeoutMs: z
      .number()
      .positive()
      .optional()
      .describe(
        "Optional maximum time for waitForTerminal in milliseconds. Ignored when using listenForTerminal.",
      ),
    listenForTerminal: z
      .boolean()
      .optional()
      .describe(
        "Register a durable one-shot listener for the exact taskId and return immediately. The session is automatically resumed when the task reaches a terminal status.",
      ),
  }),
  async execute(params, ctx) {
    if (params.listenForTerminal && params.waitForTerminal) {
      throw new Error("listenForTerminal and waitForTerminal cannot both be enabled")
    }
    if (params.listenForTerminal && !params.taskId) {
      throw new Error("taskId is required when listenForTerminal is enabled")
    }
    if (params.taskId) {
      const existing = ExperimentRemoteTask.get(params.taskId)
      if (!existing) throw new Error(`remote task not found: ${params.taskId}`)
      if (existing.exp_id !== params.expId)
        throw new Error(`remote task does not belong to experiment: ${params.taskId}`)
    }
    const refreshed = await forceRefreshRemoteTask(params.expId, { taskId: params.taskId })
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
    let listening = false
    let duplicate = false
    let recipient: string | undefined
    if (params.listenForTerminal && !ExperimentRemoteTask.isTerminal(task.status)) {
      const node = await Collab.ensureRootFromSession(ctx.sessionID, {
        name: "root",
        subagentType: ctx.agent,
        spec: { initialPrompt: "" },
      })
      const registered = ExperimentRemoteTaskListener.register({
        taskId: task.task_id,
        agentId: node.id,
      })
      task = registered.task
      listening = registered.listening
      duplicate = registered.duplicate
      recipient = node.id
      if (listening) {
        await ctx.metadata({
          title: `Listening: ${task.title}`,
          metadata: {
            phase: "listening_terminal",
            message: "The session will resume when the remote task reaches a terminal status",
            taskId: task.task_id,
            expId: params.expId,
            kind: task.kind,
            title: task.title,
            status: task.status,
            listening,
            duplicate,
          },
        })
      }
    }
    let waited = false
    if (params.waitForTerminal && (task.status === "pending" || task.status === "running")) {
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
    let inspection = refreshed.inspections.find((item) => item.taskId === task.task_id)
    if (waited && task.log_path) {
      const paths = control(task.remote_root, task.task_id, task.screen_name)
      const result = await inspectRemoteTask({
        server,
        logPath: task.log_path,
        screenName: task.screen_name,
        exitPath: paths.exitPath,
        pendingPath: paths.pendingPath,
        targetPath: task.target_path,
      })
      inspection = { taskId: task.task_id, result, meta: parseInspectOutput(result.output) }
    }
    const inspectError = inspection && !inspection.result.ok ? inspection.result.output || "unknown error" : null
    const state = inspection?.meta.screen
    const screen = inspectError
      ? "inspect_failed"
      : state === "stopped" && inspection?.meta.managed && inspection.meta.code === undefined && task.status === "running"
        ? "starting"
        : state || (task.status === "pending" ? "starting" : task.status === "running" ? "unknown" : "stopped")
    const tail = inspection?.result.ok ? inspection.meta.tail.split("\n").slice(-20).join("\n") : ""
    const error = task.status === "failed" || task.status === "crashed" ? task.error_message : null

    return {
      title: listening ? `Listening: ${task.title}` : `Remote task: ${task.title}`,
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
        inspectError && !task.error_message ? `Screen inspect error: ${inspectError}` : null,
        listening ? "" : null,
        listening
          ? duplicate
            ? "A terminal-status listener for this task is already active in this session."
            : "A durable terminal-status listener is now active for this task."
          : null,
        listening ? "YOU MUST END YOUR TURN NOW. Do not poll, sleep, or wait for this task." : null,
        listening ? "The framework will automatically resume this session when the task reaches a terminal status." : null,
        "",
        "Last 20 log lines:",
        tail || "(log unavailable)",
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
        listening,
        duplicate,
        recipientAgentId: recipient,
        terminal: ExperimentRemoteTask.isTerminal(task.status),
        phase: listening ? "listening_terminal" : waited ? "terminal" : "inspected",
        screen,
        screenLine: inspection?.meta.screenLine ?? "",
        screenInspectError: inspectError,
        logPath: task.log_path,
        errorMessage: error,
        tail,
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
    if (ExperimentRemoteTask.listActiveByExp(params.expId).length) await forceRefreshRemoteTask(params.expId)
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
