import z from "zod"
import { Tool } from "./tool"
import { ExperimentLocalDownloadWatch } from "../research/experiment-local-download-watch"
import { ExperimentExecutionWatch } from "../research/experiment-execution-watch"
import { forceRefreshLocalDownload } from "../research/experiment-local-download-watcher"

const Status = z.enum(["pending", "running", "finished", "failed", "crashed"])

export const ExperimentLocalDownloadWatchInitTool = Tool.define("experiment_local_download_watch_init", {
  description: "Create or get a resumable local download watch for a resource.",
  parameters: z.object({
    expId: z.string().describe("The experiment ID"),
    resourceKey: z.string().describe("Stable key for the resource within this experiment"),
    resourceName: z.string().describe("Human-readable resource name"),
    resourceType: z.string().nullable().optional().describe("Optional resource type"),
    localResourceRoot: z.string().nullable().optional().describe("Local resource root"),
  }),
  async execute(params) {
    const watch = ExperimentLocalDownloadWatch.createOrGet(params)
    ExperimentExecutionWatch.syncLocalDownload(params.expId)
    return {
      title: `Local download watch: ${watch.resource_name}`,
      output: [
        "Local download watch ready.",
        `- Watch ID: ${watch.watch_id}`,
        `- Experiment ID: ${watch.exp_id}`,
        `- Resource: ${watch.resource_name}`,
        `- Status: ${watch.status}`,
      ].join("\n"),
      metadata: { watchId: watch.watch_id },
    }
  },
})

export const ExperimentLocalDownloadWatchUpdateTool = Tool.define("experiment_local_download_watch_update", {
  description: "Update the resumable local download watch for a resource.",
  parameters: z.object({
    watchId: z.string().optional().describe("The local download watch ID"),
    expId: z.string().optional().describe("The experiment ID"),
    resourceKey: z.string().optional().describe("Stable key for the resource within this experiment"),
    resourceName: z.string().optional().describe("Human-readable resource name"),
    resourceType: z.string().nullable().optional().describe("Optional resource type"),
    status: Status.optional(),
    localResourceRoot: z.string().nullable().optional(),
    localPath: z.string().nullable().optional(),
    pid: z.number().int().nullable().optional(),
    logPath: z.string().nullable().optional(),
    statusPath: z.string().nullable().optional(),
    sourceSelection: z.string().nullable().optional(),
    method: z.string().nullable().optional(),
    errorMessage: z.string().nullable().optional(),
  }),
  async execute(params) {
    const watch = ExperimentLocalDownloadWatch.update(params)
    const expId = watch?.exp_id ?? params.expId
    if (expId) ExperimentExecutionWatch.syncLocalDownload(expId)
    return {
      title: "Local download watch updated",
      output: [
        watch?.watch_id ? `Watch ID: ${watch.watch_id}` : null,
        expId ? `Experiment ID: ${expId}` : null,
        watch?.resource_name ? `Resource: ${watch.resource_name}` : null,
        params.status ? `Status: ${params.status}` : null,
        params.localPath !== undefined ? `Local path: ${params.localPath ?? ""}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { watchId: watch?.watch_id },
    }
  },
})

export const ExperimentLocalDownloadWatchRefreshTool = Tool.define("experiment_local_download_watch_refresh", {
  description: "Refresh all local download watches for an experiment.",
  parameters: z.object({
    expId: z.string().describe("The experiment ID"),
  }),
  async execute(params) {
    const result = await forceRefreshLocalDownload(params.expId)
    return {
      title: "Local download watch refreshed",
      output: result.message,
      metadata: {},
    }
  },
})
