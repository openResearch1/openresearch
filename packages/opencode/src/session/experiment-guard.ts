import path from "path"
import fs from "fs/promises"
import { Research } from "@/research/research"
import { Database, eq, and, ne } from "@/storage/db"
import { ExperimentTable } from "@/research/research.sql"
import { Filesystem } from "@/util/filesystem"
import { git } from "@/util/git"

const REQUIRED_IGNORE_RULES = [
  "__pycache__/",
  "*.pyc",
  "*.pyo",
  ".ipynb_checkpoints/",
  "*.egg-info/",
  "dist/",
  "build/",
  ".eggs/",
  "node_modules/",
  ".env",
  ".venv/",
  "venv/",
]

async function ensureGitignore(codePath: string): Promise<boolean> {
  const gitignorePath = path.join(codePath, ".gitignore")
  const existing = await fs.readFile(gitignorePath, "utf-8").catch(() => "")
  const existingLines = new Set(existing.split("\n").map((l) => l.trim()))
  const missing = REQUIRED_IGNORE_RULES.filter((rule) => !existingLines.has(rule))
  if (missing.length === 0) return false
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
  const patch = `${separator}# opencode experiment defaults\n${missing.join("\n")}\n`
  await fs.appendFile(gitignorePath, patch)
  return true
}

export class ExperimentConflictError extends Error {
  constructor(
    public readonly expId: string,
    public readonly conflictingExpId: string,
    public readonly codePath: string,
  ) {
    super(
      `Cannot start experiment ${expId}: experiment ${conflictingExpId} is already running on code path ${codePath}`,
    )
  }
}

export class ExperimentBranchError extends Error {
  constructor(
    public readonly expId: string,
    message: string,
  ) {
    super(`Experiment ${expId}: ${message}`)
  }
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "OpenCode",
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "opencode@local",
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "OpenCode",
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "opencode@local",
}

function gitErr(result: { stderr?: Buffer; text?: () => string }, fallback: string) {
  return result.stderr?.toString().trim() || result.text?.() || fallback
}

/**
 * Archive uncommitted changes on the current branch by creating a structured commit.
 * Used to salvage work from a previous experiment before switching branches.
 */
async function archiveDirtyWorkTree(codePath: string, branch: string): Promise<void> {
  // Stage everything including untracked files
  const add = await git(["add", "."], { cwd: codePath })
  if (add.exitCode !== 0) return

  // Check if there's anything staged after add
  const diffCached = await git(["diff", "--cached", "--stat"], { cwd: codePath })
  const statOutput = diffCached.text().trim()
  if (!statOutput) return

  // Parse stats from the last line: " N files changed, M insertions(+), K deletions(-)"
  const lines = statOutput.split("\n")
  const summaryLine = lines[lines.length - 1]?.trim() ?? ""
  const filesChanged = lines
    .slice(0, -1)
    .map((l) => l.trim().split("|")[0]?.trim())
    .filter(Boolean)

  // Build structured commit message
  const commitMsg = [
    `[Experiment] Auto-archive uncommitted changes on branch ${branch}`,
    "",
    "Changes:",
    ...filesChanged.map((f) => `- ${f}`),
    "",
    `Stats:`,
    `  ${summaryLine}`,
  ].join("\n")

  await git(["commit", "-m", commitMsg], { cwd: codePath, env: GIT_ENV })
}

export async function setExperimentStatus(
  sessionID: string,
  status: "pending" | "running" | "done" | "idle" | "failed",
): Promise<void> {
  const parentSessionId = (await Research.getParentSessionId(sessionID)) ?? sessionID
  const experiment = Database.use((db) =>
    db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_session_id, parentSessionId)).get(),
  )
  if (!experiment) return
  Database.use((db) =>
    db.update(ExperimentTable).set({ status }).where(eq(ExperimentTable.exp_id, experiment.exp_id)).run(),
  )
}

export type ExperimentReadyResult =
  | { ready: true }
  | { ready: false; reason: "not_found"; message: string }
  | {
      ready: false
      reason: "conflict"
      message: string
      conflicts: { exp_id: string; exp_session_id: string | null }[]
    }
  | { ready: false; reason: "git_error"; message: string }

type ExperimentRow = typeof ExperimentTable.$inferSelect

/**
 * Core logic shared by both the session-based guard and the expId-based HTTP endpoint.
 * Resolves code_path, checks conflicts, initialises git, and switches to the experiment branch.
 */
async function prepareExperiment(experiment: ExperimentRow): Promise<ExperimentReadyResult> {
  const codePath = experiment.code_path

  // Conflict check — find other running experiments on the same code_path
  const conflicts = Database.use((db) =>
    db
      .select({ exp_id: ExperimentTable.exp_id, exp_session_id: ExperimentTable.exp_session_id })
      .from(ExperimentTable)
      .where(
        and(
          eq(ExperimentTable.status, "running"),
          eq(ExperimentTable.code_path, codePath),
          ne(ExperimentTable.exp_id, experiment.exp_id),
        ),
      )
      .all(),
  )

  if (conflicts.length > 0) {
    return {
      ready: false,
      reason: "conflict",
      message: `conflict: ${conflicts.length} experiment(s) already running on this article`,
      conflicts: conflicts.map((r) => ({ exp_id: r.exp_id, exp_session_id: r.exp_session_id })),
    }
  }

  // Git init if code_path is not a git repository
  const hasGit = await Filesystem.exists(path.join(codePath, ".git"))
  if (!hasGit) {
    const init = await git(["init", "--quiet"], { cwd: codePath })
    if (init.exitCode !== 0) {
      return { ready: false, reason: "git_error", message: `failed to git init: ${gitErr(init, "unknown error")}` }
    }

    await ensureGitignore(codePath)

    const add = await git(["add", "."], { cwd: codePath })
    if (add.exitCode !== 0) {
      return { ready: false, reason: "git_error", message: `failed to git add: ${gitErr(add, "unknown error")}` }
    }

    const commit = await git(["commit", "-m", "init", "--allow-empty"], {
      cwd: codePath,
      env: GIT_ENV,
    })
    if (commit.exitCode !== 0) {
      return { ready: false, reason: "git_error", message: `failed to git commit: ${gitErr(commit, "unknown error")}` }
    }
  }

  // Ensure .gitignore has required rules even for pre-existing repos
  const gitignoreChanged = await ensureGitignore(codePath)
  if (gitignoreChanged) {
    await git(["add", ".gitignore"], { cwd: codePath })
    await git(["commit", "-m", "update .gitignore"], { cwd: codePath, env: GIT_ENV })
  }

  // Branch switch
  const expBranch = experiment.exp_branch_name
  const baselineBranch = experiment.baseline_branch_name

  if (!expBranch) {
    return { ready: false, reason: "git_error", message: "experiment has no exp_branch_name" }
  }

  // Get current branch
  const currentBranchResult = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: codePath })
  if (currentBranchResult.exitCode !== 0) {
    return { ready: false, reason: "git_error", message: `failed to determine current branch at ${codePath}` }
  }
  const currentBranch = currentBranchResult.text().trim()

  // Already on the right branch
  if (currentBranch === expBranch) return { ready: true }

  // If working tree is dirty, archive changes on the current branch before switching
  const statusResult = await git(["status", "--porcelain"], { cwd: codePath })
  if (statusResult.exitCode !== 0) {
    return { ready: false, reason: "git_error", message: `failed to check git status at ${codePath}` }
  }
  if (statusResult.text().trim().length > 0) {
    await archiveDirtyWorkTree(codePath, currentBranch)
  }

  // Check if experiment branch already exists
  const branchExists = await git(["rev-parse", "--verify", expBranch], { cwd: codePath })
  if (branchExists.exitCode === 0) {
    const checkout = await git(["checkout", expBranch], { cwd: codePath })
    if (checkout.exitCode !== 0) {
      return {
        ready: false,
        reason: "git_error",
        message: `failed to checkout branch ${expBranch}: ${gitErr(checkout, "unknown error")}`,
      }
    }
    return { ready: true }
  }

  // Create experiment branch from baseline
  if (!baselineBranch) {
    return {
      ready: false,
      reason: "git_error",
      message: "experiment branch does not exist and no baseline_branch_name is configured",
    }
  }

  const baselineExists = await git(["rev-parse", "--verify", baselineBranch], { cwd: codePath })
  if (baselineExists.exitCode !== 0) {
    return {
      ready: false,
      reason: "git_error",
      message: `baseline branch "${baselineBranch}" not found at ${codePath}`,
    }
  }

  const createBranch = await git(["checkout", "-b", expBranch, baselineBranch], { cwd: codePath })
  if (createBranch.exitCode !== 0) {
    return {
      ready: false,
      reason: "git_error",
      message: `failed to create branch ${expBranch} from ${baselineBranch}: ${gitErr(createBranch, "unknown error")}`,
    }
  }

  return { ready: true }
}

/**
 * Check experiment readiness by experiment ID. Used by the HTTP endpoint.
 */
export async function checkExperimentReadyByExpId(expId: string): Promise<ExperimentReadyResult> {
  const experiment = Database.use((db) =>
    db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, expId)).get(),
  )
  if (!experiment) {
    return { ready: false, reason: "not_found", message: `experiment not found: ${expId}` }
  }
  return prepareExperiment(experiment)
}

/**
 * Assert that an experiment session is ready. Throws on failure (used by the session guard).
 */
export async function assertExperimentReady(sessionID: string): Promise<void> {
  const parentSessionId = (await Research.getParentSessionId(sessionID)) ?? sessionID
  const experiment = Database.use((db) =>
    db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_session_id, parentSessionId)).get(),
  )
  if (!experiment) return

  const result = await prepareExperiment(experiment)
  if (result.ready) return

  if (result.reason === "conflict") {
    throw new ExperimentConflictError(experiment.exp_id, result.conflicts[0].exp_id, "")
  }
  throw new ExperimentBranchError(experiment.exp_id, result.message)
}
