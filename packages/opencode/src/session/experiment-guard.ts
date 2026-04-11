import path from "path"
import fs from "fs/promises"
import { Research } from "@/research/research"
import { Database, eq } from "@/storage/db"
import { ExperimentTable } from "@/research/research.sql"
import { Filesystem } from "@/util/filesystem"
import { git } from "@/util/git"

export const REQUIRED_IGNORE_RULES = [
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
  ".openresearch_worktrees/",
]

export async function ensureGitignore(codePath: string): Promise<boolean> {
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

export class ExperimentBranchError extends Error {
  constructor(
    public readonly expId: string,
    message: string,
  ) {
    super(`Experiment ${expId}: ${message}`)
  }
}

export const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "OpenCode",
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "opencode@local",
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "OpenCode",
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "opencode@local",
}

export function gitErr(result: { stderr?: Buffer; text?: () => string }, fallback: string) {
  return result.stderr?.toString().trim() || result.text?.() || fallback
}

/**
 * Ensure the code path is a usable git repository.
 * If not initialised, runs git init, ensures .gitignore, and creates an initial commit.
 * If already initialised, ensures .gitignore has required rules.
 */
export async function ensureRepoInitialized(codePath: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const hasGit = await Filesystem.exists(path.join(codePath, ".git"))
  if (!hasGit) {
    const init = await git(["init", "--quiet"], { cwd: codePath })
    if (init.exitCode !== 0) {
      return { ok: false, message: `failed to git init: ${gitErr(init, "unknown error")}` }
    }

    await ensureGitignore(codePath)

    const add = await git(["add", "."], { cwd: codePath })
    if (add.exitCode !== 0) {
      return { ok: false, message: `failed to git add: ${gitErr(add, "unknown error")}` }
    }

    const commit = await git(["commit", "-m", "init", "--allow-empty"], {
      cwd: codePath,
      env: GIT_ENV,
    })
    if (commit.exitCode !== 0) {
      return { ok: false, message: `failed to git commit: ${gitErr(commit, "unknown error")}` }
    }
  } else {
    const gitignoreChanged = await ensureGitignore(codePath)
    if (gitignoreChanged) {
      await git(["add", ".gitignore"], { cwd: codePath })
      await git(["commit", "-m", "update .gitignore"], { cwd: codePath, env: GIT_ENV })
    }
  }

  return { ok: true }
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
  | { ready: false; reason: "git_error"; message: string }

/**
 * Check experiment readiness by experiment ID.
 * With worktree-based experiments, this simply checks that the worktree directory exists.
 */
export async function checkExperimentReadyByExpId(expId: string): Promise<ExperimentReadyResult> {
  const experiment = Database.use((db) =>
    db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, expId)).get(),
  )
  if (!experiment) {
    return { ready: false, reason: "not_found", message: `experiment not found: ${expId}` }
  }
  const exists = await Filesystem.exists(experiment.code_path)
  if (!exists) {
    return {
      ready: false,
      reason: "git_error",
      message: `worktree directory does not exist: ${experiment.code_path}`,
    }
  }
  return { ready: true }
}

/**
 * Assert that an experiment session is ready. Throws on failure (used by the session guard).
 * With worktree-based experiments, this simply checks that the worktree directory exists.
 */
export async function assertExperimentReady(sessionID: string): Promise<void> {
  const parentSessionId = (await Research.getParentSessionId(sessionID)) ?? sessionID
  const experiment = Database.use((db) =>
    db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_session_id, parentSessionId)).get(),
  )
  if (!experiment) return

  const exists = await Filesystem.exists(experiment.code_path)
  if (!exists) {
    throw new ExperimentBranchError(experiment.exp_id, `worktree directory does not exist: ${experiment.code_path}`)
  }
}
