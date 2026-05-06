import z from "zod"
import { Tool } from "./tool"
import { ExperimentExecutionWatch } from "../research/experiment-execution-watch"

export const ExperimentExecutionWatchInitTool = Tool.define("experiment_execution_watch_init", {
  description: "Create or get the execution watch for an experiment.",
  parameters: z.object({
    expId: z.string().describe("The experiment ID"),
    title: z.string().describe("Short title for the execution watch"),
  }),
  async execute(params) {
    const watch = ExperimentExecutionWatch.createOrGet(params.expId, params.title)
    return {
      title: `Execution watch: ${watch.title}`,
      output: `Execution watch ready.\n- Watch ID: ${watch.watch_id}\n- Experiment ID: ${watch.exp_id}\n- Stage: ${watch.stage}\n- Status: ${watch.status}`,
      metadata: { watchId: watch.watch_id },
    }
  },
})

export const ExperimentExecutionWatchUpdateTool = Tool.define("experiment_execution_watch_update", {
  description: "Update the execution watch stage or status for an experiment.",
  parameters: z.object({
    expId: z.string().optional().describe("The experiment ID"),
    watchId: z.string().optional().describe("The execution watch ID"),
    status: z.enum(["pending", "running", "finished", "failed", "canceled"]).optional(),
    stage: z
      .enum([
        "planning",
        "coding",
        "deploying_code",
        "setting_up_env",
        "remote_downloading",
        "verifying_resources",
        "running_experiment",
        "watching_wandb",
      ])
      .optional(),
    title: z.string().optional(),
    message: z.string().nullable().optional(),
    wandbEntity: z.string().nullable().optional(),
    wandbProject: z.string().nullable().optional(),
    wandbRunId: z.string().nullable().optional(),
    errorMessage: z.string().nullable().optional(),
  }),
  async execute(params) {
    ExperimentExecutionWatch.update(params)
    return {
      title: "Execution watch updated",
      output: [
        params.expId ? `Experiment ID: ${params.expId}` : null,
        params.watchId ? `Watch ID: ${params.watchId}` : null,
        params.status ? `Status: ${params.status}` : null,
        params.stage ? `Stage: ${params.stage}` : null,
        params.message !== undefined ? `Message: ${params.message ?? ""}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { watchId: params.watchId },
    }
  },
})
