import z from "zod"
import fs from "fs"
import path from "path"
import { Tool } from "./tool"
import { Database, eq } from "../storage/db"
import { AtomTable, ExperimentTable, RemoteServerTable } from "../research/research.sql"
import { Research } from "../research/research"
import { normalizeRemoteServerConfig } from "../research/remote-server"

type ExpRow = typeof ExperimentTable.$inferSelect

interface RunInfo {
  name: string
  files: string[]
}

interface ExpResult {
  exp: ExpRow
  atom_id: string | null
  code_path: string
  exp_plan_path: string | null
  remote_server_config: string | null
  runs: RunInfo[]
}

function scanResultRuns(resultPath: string | null): RunInfo[] {
  if (!resultPath || !fs.existsSync(resultPath)) return []
  try {
    const entries = fs.readdirSync(resultPath, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const runPath = path.join(resultPath, e.name)
        const files = fs.readdirSync(runPath).filter((f) => fs.statSync(path.join(runPath, f)).isFile())
        return { name: e.name, files }
      })
  } catch {
    return []
  }
}

function queryExpWithJoins(expId: string): ExpResult | undefined {
  const exp = Database.use((db) => db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, expId)).get())
  if (!exp) return undefined

  let atom: typeof AtomTable.$inferSelect | undefined
  if (exp.atom_id) {
    atom = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, exp.atom_id!)).get())
  }

  let remoteServerConfig: string | null = null
  if (exp.remote_server_id) {
    const server = Database.use((db) =>
      db.select().from(RemoteServerTable).where(eq(RemoteServerTable.id, exp.remote_server_id!)).get(),
    )
    remoteServerConfig = server ? JSON.stringify(normalizeRemoteServerConfig(JSON.parse(server.config))) : null
  }

  const runs = scanResultRuns(exp.exp_result_path)

  return {
    exp,
    atom_id: exp.atom_id,
    code_path: exp.code_path,
    exp_plan_path: exp.exp_plan_path ?? null,
    remote_server_config: remoteServerConfig,
    runs,
  }
}

function formatExpResult(r: ExpResult): string {
  const e = r.exp
  return [
    `exp_id: ${e.exp_id}`,
    `exp_name: ${e.exp_name}`,
    `research_project_id: ${e.research_project_id}`,
    r.atom_id ? `atom_id: ${r.atom_id}` : `atom_id: (not linked)`,
    e.exp_session_id ? `exp_session_id: ${e.exp_session_id}` : null,
    e.baseline_branch_name ? `baseline_branch_name: ${e.baseline_branch_name}` : null,
    e.exp_branch_name ? `exp_branch_name: ${e.exp_branch_name}` : null,
    e.exp_result_path ? `exp_result_path: ${e.exp_result_path}` : null,
    e.exp_result_summary_path ? `exp_result_summary_path: ${e.exp_result_summary_path}` : null,
    r.remote_server_config ? `remote_server_config: ${r.remote_server_config}` : null,
    `status: ${e.status}`,
    e.started_at ? `started_at: ${e.started_at}` : null,
    e.finished_at ? `finished_at: ${e.finished_at}` : null,
    `time_created: ${e.time_created}`,
    `time_updated: ${e.time_updated}`,
    r.code_path ? `code_path: ${r.code_path}` : `code_path: (not set)`,
    r.exp_plan_path ? `exp_plan_path: ${r.exp_plan_path}` : `exp_plan_path: (not set)`,
    r.runs.length > 0 ? `runs:\n${r.runs.map((run) => `  - ${run.name} [${run.files.join(", ")}]`).join("\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n")
}

export const ExperimentQueryTool = Tool.define("experiment_query", {
  description:
    "Query experiments in the current research project. " +
    "Supports three query modes: " +
    "(1) by atomId — find the experiment linked to a specific atom; " +
    "(2) by expId — look up an experiment directly; " +
    "(3) by current session — resolve to the parent session and find its linked experiment. " +
    "Returns experiment details along with the associated code_path and experiment plan path.",
  parameters: z.object({
    atomId: z.string().optional().describe("Query the experiment linked to this atom ID"),
    expId: z.string().optional().describe("Query an experiment directly by its ID"),
  }),
  async execute(params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "Failed",
        output: "Current session is not associated with any research project.",
        metadata: { count: 0 },
      }
    }

    // Mode 1: query by expId
    if (params.expId) {
      const result = queryExpWithJoins(params.expId)
      if (!result) {
        return {
          title: "Not found",
          output: `Experiment not found: ${params.expId}`,
          metadata: { count: 0 },
        }
      }
      return {
        title: `Experiment: ${result.exp.exp_id}`,
        output: formatExpResult(result),
        metadata: { count: 1 },
      }
    }

    // Mode 2: query by atomId
    if (params.atomId) {
      const exps = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.atom_id, params.atomId!)).all(),
      )
      if (exps.length === 0) {
        return {
          title: "No experiment",
          output: `No experiments found for atom ${params.atomId}.`,
          metadata: { count: 0 },
        }
      }
      const results = exps.map((e) => queryExpWithJoins(e.exp_id)).filter((r): r is ExpResult => r !== undefined)
      const output = results.map((r, i) => `--- Experiment ${i + 1} ---\n${formatExpResult(r)}`).join("\n\n")
      return {
        title: `${results.length} experiment(s)`,
        output,
        metadata: { count: results.length },
      }
    }

    // Mode 3: query by current session
    const parentSessionId = (await Research.getParentSessionId(ctx.sessionID)) ?? ctx.sessionID
    const exp = Database.use((db) =>
      db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_session_id, parentSessionId)).get(),
    )
    if (!exp) {
      return {
        title: "No experiment",
        output: "No experiment is linked to the current session.",
        metadata: { count: 0 },
      }
    }
    const result = queryExpWithJoins(exp.exp_id)
    if (!result) {
      return {
        title: "Not found",
        output: `Experiment ${exp.exp_id} not found in database.`,
        metadata: { count: 0 },
      }
    }
    return {
      title: `Experiment: ${result.exp.exp_id}`,
      output: formatExpResult(result),
      metadata: { count: 1 },
    }
  },
})
