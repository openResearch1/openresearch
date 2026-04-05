import { spawn } from "node:child_process"
import path from "node:path"
import z from "zod"
import { Tool } from "./tool"
import { Filesystem } from "../util/filesystem"
import { ExperimentLocalDownloadWatch } from "../research/experiment-local-download-watch"
import { ExperimentExecutionWatch } from "../research/experiment-execution-watch"

const Kind = z.enum(["local_download", "resource_sync"])

function stamp() {
  return Date.now()
}

function safe(input: string) {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-")
}

function control(root: string, expId: string, resourceKey: string) {
  return path.join(root, ".openresearch", "jobs", expId, safe(resourceKey))
}

function script(input: { statusPath: string; logPath: string; command: string }) {
  const status = JSON.stringify(input.statusPath)
  const log = JSON.stringify(input.logPath)
  return [
    "#!/usr/bin/env bash",
    `sts=${status}`,
    `log=${log}`,
    "write() {",
    '  local st="$1"',
    '  local code="$2"',
    '  printf \'{"status":"%s","exit_code":%s,"updated_at":%s}\n\' "$st" "$code" "$(date +%s)" > "$sts"',
    "}",
    "write running 0",
    "bash <<'OPENCODE_JOB' >>\"$log\" 2>&1",
    input.command,
    "OPENCODE_JOB",
    "code=$?",
    'if [ "$code" -eq 0 ]; then',
    '  write finished "$code"',
    "  exit 0",
    "fi",
    'write failed "$code"',
    'exit "$code"',
    "",
  ].join("\n")
}

export const ExperimentResourceJobStartTool = Tool.define("experiment_resource_job_start", {
  description:
    "Start a long-running local resource job with stable pid/log/status files. " +
    "Only for experiment_local_download and experiment_sync_resource. Never use for experiment_run.",
  parameters: z.object({
    expId: z.string().describe("The experiment ID"),
    resourceKey: z.string().describe("Stable key for the resource within this experiment"),
    resourceName: z.string().describe("Human-readable resource name"),
    kind: Kind.describe("Use local_download for local resource fetches, resource_sync for long upload/sync jobs"),
    localPath: z.string().nullable().optional().describe("Resolved local resource path"),
    controlRoot: z.string().describe("Root directory used to store job control files"),
    command: z.string().describe("The real shell command to execute, without nohup wrapping"),
    sourceSelection: z.string().nullable().optional().describe("Chosen resource source, if any"),
    method: z.string().nullable().optional().describe("Download or sync method, if any"),
    resourceType: z.string().nullable().optional().describe("Optional resource type"),
    watchId: z.string().nullable().optional().describe("Existing local download watch ID when kind is local_download"),
  }),
  async execute(params, ctx) {
    if (!["experiment_local_download", "experiment_sync_resource"].includes(ctx.agent)) {
      throw new Error(
        "experiment_resource_job_start is restricted to experiment_local_download and experiment_sync_resource",
      )
    }

    const dir = control(params.controlRoot, params.expId, params.resourceKey)
    const pidPath = path.join(dir, "job.pid")
    const logPath = path.join(dir, "job.log")
    const statusPath = path.join(dir, "job.status.json")
    const metaPath = path.join(dir, "job.meta.json")
    const runPath = path.join(dir, "job.sh")

    await Filesystem.writeJson(metaPath, {
      exp_id: params.expId,
      resource_key: params.resourceKey,
      resource_name: params.resourceName,
      kind: params.kind,
      resource_type: params.resourceType ?? null,
      local_path: params.localPath ?? null,
      source_selection: params.sourceSelection ?? null,
      method: params.method ?? null,
      command: params.command,
      time_created: stamp(),
    })
    await Filesystem.writeJson(statusPath, { status: "pending", updated_at: stamp() })
    await Filesystem.write(runPath, script({ statusPath, logPath, command: params.command }), 0o755)
    await Filesystem.write(logPath, "")

    const child = spawn("nohup", ["bash", runPath], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()
    if (!child.pid) throw new Error("Failed to start background resource job")
    await Filesystem.write(pidPath, `${child.pid}\n`)

    let watchId = params.watchId ?? undefined
    if (params.kind === "local_download") {
      const watch = ExperimentLocalDownloadWatch.update({
        watchId,
        expId: params.expId,
        resourceKey: params.resourceKey,
        resourceName: params.resourceName,
        resourceType: params.resourceType ?? null,
        status: "running",
        localPath: params.localPath ?? null,
        pid: child.pid,
        logPath,
        statusPath,
        sourceSelection: params.sourceSelection ?? null,
        method: params.method ?? null,
        errorMessage: null,
      })
      watchId = watch?.watch_id
      ExperimentExecutionWatch.syncLocalDownload(params.expId)
    }

    return {
      title: `Started resource job: ${params.resourceName}`,
      output: [
        `Kind: ${params.kind}`,
        `Experiment ID: ${params.expId}`,
        `Resource: ${params.resourceName}`,
        `PID: ${child.pid}`,
        `Control dir: ${dir}`,
        `Log path: ${logPath}`,
        `Status path: ${statusPath}`,
      ].join("\n"),
      metadata: {
        watchId,
        pid: child.pid,
        controlDir: dir,
        pidPath,
        logPath,
        statusPath,
        metaPath,
      },
    }
  },
})
