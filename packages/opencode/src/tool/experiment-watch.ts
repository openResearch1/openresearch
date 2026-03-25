import z from "zod"
import { Tool } from "./tool"
import { Database, eq, and } from "../storage/db"
import { ExperimentTable, ExperimentWatchTable } from "../research/research.sql"
import { Log } from "../util/log"

const log = Log.create({ service: "experiment-watch" })

const WANDB_GRAPHQL = "https://api.wandb.ai/graphql"

async function queryWandbViewer(apiKey: string): Promise<{ entity: string | null; error?: string }> {
  try {
    const resp = await fetch(WANDB_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: "query { viewer { entity } }" }),
    })
    if (!resp.ok) return { entity: null, error: `W&B API returned ${resp.status}` }
    const data = (await resp.json()) as any
    return { entity: data?.data?.viewer?.entity ?? null }
  } catch (err: any) {
    return { entity: null, error: err?.message ?? "Failed to connect to W&B API" }
  }
}

export async function queryWandbRun(
  apiKey: string,
  entity: string,
  project: string,
  runName: string,
): Promise<{ exists: boolean; state?: string; error?: string }> {
  try {
    const resp = await fetch(WANDB_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query: `query ($entity: String!, $project: String!, $runName: String!) {
          project(name: $project, entityName: $entity) {
            runs(filters: $runName) {
              edges { node { id name state } }
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
    if (!resp.ok) return { exists: false, error: `W&B API returned ${resp.status}` }
    const data = (await resp.json()) as any
    const edges = data?.data?.project?.runs?.edges
    if (!edges || edges.length === 0) return { exists: false, error: "Run not found in W&B" }
    return { exists: true, state: edges[0].node.state }
  } catch (err: any) {
    return { exists: false, error: err?.message ?? "Failed to connect to W&B API" }
  }
}

export const ExperimentWatchTool = Tool.define("experiment_watch", {
  description:
    "Register an experiment for W&B run monitoring. " +
    "After an experiment is deployed and running on a remote server, call this tool to start watching its W&B run. " +
    "The system will poll W&B every 3 minutes and pull results when the run finishes.",
  parameters: z.object({
    expId: z.string().describe("The experiment ID to watch"),
    wandbProject: z.string().describe("The W&B project name"),
    wandbApiKey: z.string().describe("The W&B API key"),
    wandbRunId: z.string().describe("The W&B run ID (format: <exp_id>_<timestamp>)"),
  }),
  async execute(params) {
    const experiment = Database.use((db) =>
      db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, params.expId)).get(),
    )
    if (!experiment) {
      return {
        title: "Failed",
        output: `Experiment not found: ${params.expId}`,
        metadata: { watchId: undefined as string | undefined },
      }
    }

    // Check if already watching this run (dedup by run_id + api_key + project)
    const existing = Database.use((db) =>
      db
        .select()
        .from(ExperimentWatchTable)
        .where(
          and(
            eq(ExperimentWatchTable.wandb_run_id, params.wandbRunId),
            eq(ExperimentWatchTable.wandb_api_key, params.wandbApiKey),
            eq(ExperimentWatchTable.wandb_project, params.wandbProject),
          ),
        )
        .get(),
    )
    if (existing) {
      return {
        title: "Already watching",
        output: `W&B run ${params.wandbRunId} is already being monitored (status: ${existing.status}).`,
        metadata: { watchId: existing.watch_id as string | undefined },
      }
    }

    // Resolve entity from API key
    const viewer = await queryWandbViewer(params.wandbApiKey)
    if (!viewer.entity) {
      return {
        title: "Failed",
        output: `Failed to resolve W&B entity from API key. ${viewer.error ?? ""}`,
        metadata: { watchId: undefined as string | undefined },
      }
    }

    // Verify the run exists on W&B
    const check = await queryWandbRun(params.wandbApiKey, viewer.entity, params.wandbProject, params.wandbRunId)
    if (!check.exists) {
      return {
        title: "Run not found",
        output: `W&B run "${params.wandbRunId}" not found in project "${viewer.entity}/${params.wandbProject}". ${check.error ?? ""}\nPlease verify the run ID and ensure the experiment has started logging to W&B.`,
        metadata: { watchId: undefined as string | undefined },
      }
    }

    const watchId = crypto.randomUUID()
    const now = Date.now()

    Database.use((db) =>
      db
        .insert(ExperimentWatchTable)
        .values({
          watch_id: watchId,
          exp_id: params.expId,
          wandb_entity: viewer.entity!,
          wandb_project: params.wandbProject,
          wandb_api_key: params.wandbApiKey,
          wandb_run_id: params.wandbRunId,
          status: check.state === "running" ? "running" : "pending",
          wandb_state: check.state ?? null,
          time_created: now,
          time_updated: now,
        })
        .run(),
    )

    // Update experiment status to running
    Database.use((db) =>
      db
        .update(ExperimentTable)
        .set({ status: "running", started_at: now, time_updated: now })
        .where(eq(ExperimentTable.exp_id, params.expId))
        .run(),
    )

    log.info("experiment watch registered", {
      watchId,
      expId: params.expId,
      wandbEntity: viewer.entity,
      wandbProject: params.wandbProject,
      wandbRunId: params.wandbRunId,
      wandbState: check.state,
    })

    return {
      title: `Watching: ${params.wandbRunId}`,
      output: [
        `Experiment watch registered successfully.`,
        `- Watch ID: ${watchId}`,
        `- Experiment ID: ${params.expId}`,
        `- W&B Entity: ${viewer.entity}`,
        `- W&B Project: ${params.wandbProject}`,
        `- W&B Run ID: ${params.wandbRunId}`,
        `- W&B State: ${check.state}`,
        ``,
        `The system will poll W&B every 3 minutes and pull results when the run finishes.`,
      ].join("\n"),
      metadata: { watchId },
    }
  },
})
