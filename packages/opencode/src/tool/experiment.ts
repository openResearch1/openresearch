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
import { Bus } from "@/bus"
import { CodeBranch } from "@/research/code-branch"

const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "expectedHeadSha must be a full Git commit SHA")

export const ExperimentCreateTool = Tool.define("experiment_create", {
  description:
    "Create a new experiment for a given atom in the current research project. " +
    "Requires a local branch and exact HEAD SHA from research_code_branch_query, then creates a dedicated worktree pinned to that commit.",
  parameters: z.object({
    atomId: z.string().describe("The atom ID to create an experiment for"),
    expName: z.string().describe("A human-readable name for the experiment"),
    baselineBranch: z.string().describe("The local baseline branch returned by research_code_branch_query"),
    expectedHeadSha: sha.describe("The exact branch HEAD SHA returned by research_code_branch_query"),
    remoteServerId: z.string().optional().describe("Optional remote server ID to run the experiment on"),
    codePath: z.string().describe("The local code directory path for the experiment."),
  }),
  async execute(params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "Failed",
        output: "Current session is not associated with any research project.",
        metadata: { expId: undefined as string | undefined, agentId: undefined as string | undefined },
      }
    }

    const atom = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, params.atomId)).get())
    if (!atom) {
      return {
        title: "Failed",
        output: `Atom not found: ${params.atomId}`,
        metadata: { expId: undefined as string | undefined, agentId: undefined as string | undefined },
      }
    }
    if (atom.research_project_id !== researchProjectId) {
      return {
        title: "Failed",
        output: `Atom does not belong to the current research project: ${params.atomId}`,
        metadata: { expId: undefined as string | undefined, agentId: undefined as string | undefined },
      }
    }

    // Ensure repo is initialised and create worktree for the experiment
    const initResult = await ensureRepoInitialized(params.codePath)
    if (!initResult.ok) {
      return {
        title: "Failed",
        output: `Failed to initialise repo at ${params.codePath}: ${initResult.message}`,
        metadata: { expId: undefined as string | undefined, agentId: undefined as string | undefined },
      }
    }

    const baseline = await CodeBranch.resolve(params.codePath, params.baselineBranch).catch(() => undefined)
    if (!baseline) {
      return {
        title: "Failed",
        output: `Baseline branch "${params.baselineBranch}" not found at ${params.codePath}`,
        metadata: { expId: undefined as string | undefined, agentId: undefined as string | undefined },
      }
    }
    if (baseline !== params.expectedHeadSha) {
      return {
        title: "Failed",
        output: `Baseline branch "${params.baselineBranch}" moved from ${params.expectedHeadSha} to ${baseline}. Query branches again before creating the experiment.`,
        metadata: { expId: undefined as string | undefined, agentId: undefined as string | undefined },
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

    const worktreePath = path.join(params.codePath, ".openresearch_worktrees", expId)
    const createWorktree = await git(["worktree", "add", "-b", expId, worktreePath, baseline], {
      cwd: params.codePath,
      env: GIT_ENV,
    })
    if (createWorktree.exitCode !== 0) {
      return {
        title: "Failed",
        output: `Failed to create worktree for ${expId}: ${createWorktree.stderr?.toString().trim() || "unknown error"}`,
        metadata: { expId: undefined as string | undefined, agentId: undefined as string | undefined },
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
          baseline_commit_sha: baseline,
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
    const attached = await import("@/research/experiment-agent").then((mod) => mod.ExperimentAgent.attach(expId))
    Bus.publish(Research.Event.AtomsUpdated, { researchProjectId })

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
        attached.agentId ? `- Agent ID: ${attached.agentId}` : null,
        `- Baseline branch: ${params.baselineBranch}`,
        `- Baseline commit: ${baseline}`,
        `- Experiment branch: ${expId}`,
        `- Result path: ${expResultPath}`,
        `- Summary path: ${expResultSummaryPath}`,
        remoteServerConfig ? `- Remote server config: ${remoteServerConfig}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { expId: expId as string | undefined, agentId: attached.agentId },
    }
  },
})
