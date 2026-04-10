import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Database, eq } from "../storage/db"
import { AtomTable, ExperimentTable, RemoteServerTable } from "../research/research.sql"
import { Research } from "../research/research"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { git } from "../util/git"
import { ensureRepoInitialized, GIT_ENV } from "../session/experiment-guard"
import { ExperimentExecutionWatch } from "../research/experiment-execution-watch"
import { Session } from "@/session"

export const ExperimentCreateTool = Tool.define("experiment_create", {
  description:
    "Create a new experiment for a given atom in the current research project. " +
    "This will create a dedicated session, set up result paths, and link the experiment to the atom.",
  parameters: z.object({
    atomId: z.string().describe("The atom ID to create an experiment for"),
    expName: z.string().describe("A human-readable name for the experiment"),
    baselineBranch: z
      .string()
      .optional()
      .default("master")
      .describe("The baseline branch name to base the experiment on (default: master)"),
    remoteServerId: z.string().optional().describe("Optional remote server ID to run the experiment on"),
    codePath: z.string().describe("The local code directory path for the experiment."),
  }),
  async execute(params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "Failed",
        output: "Current session is not associated with any research project.",
        metadata: { expId: undefined as string | undefined },
      }
    }

    const atom = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, params.atomId)).get())
    if (!atom) {
      return {
        title: "Failed",
        output: `Atom not found: ${params.atomId}`,
        metadata: { expId: undefined as string | undefined },
      }
    }

    const expId = crypto.randomUUID()
    const session = await Session.create({ title: `Exp: ${params.expName}` })

    const expDir = path.join(Instance.directory, "exp_results", expId)
    const expResultPath = path.join(expDir, "result.wandb")
    const expResultSummaryPath = path.join(expDir, "summary.md")
    const expPlanPath = path.join(expDir, "plan.md")

    await Filesystem.write(path.join(expDir, ".keep"), "")
    await Filesystem.write(expPlanPath, "")

    // Ensure repo is initialised and create worktree for the experiment
    const initResult = await ensureRepoInitialized(params.codePath)
    if (!initResult.ok) {
      return {
        title: "Failed",
        output: `Failed to initialise repo at ${params.codePath}: ${initResult.message}`,
        metadata: { expId: undefined as string | undefined },
      }
    }

    const baselineExists = await git(["rev-parse", "--verify", params.baselineBranch], { cwd: params.codePath })
    if (baselineExists.exitCode !== 0) {
      return {
        title: "Failed",
        output: `Baseline branch "${params.baselineBranch}" not found at ${params.codePath}`,
        metadata: { expId: undefined as string | undefined },
      }
    }

    const worktreePath = path.join(params.codePath, ".openresearch_worktrees", expId)
    const createWorktree = await git(["worktree", "add", worktreePath, params.baselineBranch, "-b", expId], {
      cwd: params.codePath,
      env: GIT_ENV,
    })
    if (createWorktree.exitCode !== 0) {
      return {
        title: "Failed",
        output: `Failed to create worktree for ${expId}: ${createWorktree.stderr?.toString().trim() || "unknown error"}`,
        metadata: { expId: undefined as string | undefined },
      }
    }

    const now = Date.now()
    Database.use((db) =>
      db
        .insert(ExperimentTable)
        .values({
          exp_id: expId,
          research_project_id: researchProjectId,
          exp_name: params.expName,
          atom_id: params.atomId,
          exp_session_id: session.id,
          baseline_branch_name: params.baselineBranch,
          exp_branch_name: expId,
          exp_result_path: expResultPath,
          exp_result_summary_path: expResultSummaryPath,
          exp_plan_path: expPlanPath,
          code_path: worktreePath,
          remote_server_id: params.remoteServerId ?? null,
          status: "pending",
          time_created: now,
          time_updated: now,
        })
        .run(),
    )

    ExperimentExecutionWatch.createOrGet(expId, `${params.expName} for ${atom.atom_name}`, "pending")

    let remoteServerConfig: string | null = null
    if (params.remoteServerId) {
      const server = Database.use((db) =>
        db.select().from(RemoteServerTable).where(eq(RemoteServerTable.id, params.remoteServerId!)).get(),
      )
      remoteServerConfig = server?.config ?? null
    }

    return {
      title: `Created experiment for: ${atom.atom_name}`,
      output: [
        `Experiment created successfully.`,
        `- Experiment ID: ${expId}`,
        `- Atom: ${atom.atom_name} (${atom.atom_id})`,
        `- Session ID: ${session.id}`,
        `- Baseline branch: ${params.baselineBranch}`,
        `- Experiment branch: ${expId}`,
        `- Result path: ${expResultPath}`,
        `- Summary path: ${expResultSummaryPath}`,
        remoteServerConfig ? `- Remote server config: ${remoteServerConfig}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { expId: expId as string | undefined },
    }
  },
})
