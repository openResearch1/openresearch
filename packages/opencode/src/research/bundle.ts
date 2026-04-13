import path from "path"
import fs from "fs/promises"
import { git } from "../util/git"
import { Filesystem } from "../util/filesystem"
import { ensureGitignore, GIT_ENV } from "../session/experiment-guard"
import { Log } from "../util/log"
import type { ManifestExperiment } from "./manifest"

// ── Types ──

export type MergeAction =
  | "created"
  | "local_only"
  | "up_to_date"
  | "ff"
  | "local_ahead"
  | "merged"
  | "conflict"
  | "missing"
  | "diverged"

export interface BranchMergeResult {
  expId: string
  expName: string
  codeName: string
  action: MergeAction
  message?: string
}

export interface BundleCreateResult {
  codeName: string
  bundlePath: string
  autoSaved: number // number of worktrees that were auto-saved
}

export interface DirtyWorktreeInfo {
  expId: string
  codeName: string
  wtPath: string
}

// ── Bundle Operations ──

export namespace Bundle {
  const BUNDLES_DIR = ".openresearch/bundles"
  const WORKTREES_DIR = ".openresearch_worktrees"

  function bundlesDir(worktree: string) {
    return path.join(worktree, BUNDLES_DIR)
  }

  // ── Dirty worktree detection ──

  export async function getDirtyWorktrees(worktree: string): Promise<DirtyWorktreeInfo[]> {
    const codeDir = path.join(worktree, "code")
    if (!(await Filesystem.exists(codeDir))) return []

    let codeEntries: string[]
    try {
      codeEntries = await fs.readdir(codeDir)
    } catch {
      return []
    }

    const results: DirtyWorktreeInfo[] = []
    for (const codeName of codeEntries) {
      const codePath = path.join(codeDir, codeName)
      if (!(await Filesystem.isDir(codePath))) continue
      if (!(await Filesystem.exists(path.join(codePath, ".git")))) continue

      const wtDir = path.join(codePath, WORKTREES_DIR)
      if (!(await Filesystem.exists(wtDir))) continue

      let entries: string[]
      try {
        entries = await fs.readdir(wtDir)
      } catch {
        continue
      }

      for (const expId of entries) {
        const wtPath = path.join(wtDir, expId)
        if (!(await Filesystem.isDir(wtPath))) continue

        const status = await git(["status", "--porcelain"], { cwd: wtPath })
        if (status.exitCode !== 0 || !status.text().trim()) continue

        results.push({ expId, codeName, wtPath })
      }
    }

    return results
  }

  // ── Auto-save experiment worktrees ──

  export async function autoSaveWorktrees(codePath: string, commitMessages?: Record<string, string>): Promise<number> {
    const wtDir = path.join(codePath, WORKTREES_DIR)
    if (!(await Filesystem.exists(wtDir))) return 0

    let entries: string[]
    try {
      entries = await fs.readdir(wtDir)
    } catch {
      return 0
    }

    let saved = 0
    for (const expId of entries) {
      const wtPath = path.join(wtDir, expId)
      if (!(await Filesystem.isDir(wtPath))) continue

      // Ensure .gitignore has required rules
      await ensureGitignore(codePath)

      // Check for uncommitted changes
      const status = await git(["status", "--porcelain"], { cwd: wtPath })
      if (status.exitCode !== 0 || !status.text().trim()) continue

      // Auto-commit
      const add = await git(["add", "-A"], { cwd: wtPath, env: GIT_ENV })
      if (add.exitCode !== 0) {
        Log.Default.warn("auto-save: failed to git add", { wtPath, error: add.stderr.toString() })
        continue
      }

      const msg = commitMessages?.[expId] || `sync: auto-save experiment ${expId} before push`
      const commit = await git(["commit", "-m", msg], {
        cwd: wtPath,
        env: GIT_ENV,
      })
      if (commit.exitCode !== 0) {
        Log.Default.warn("auto-save: failed to commit", { wtPath, error: commit.stderr.toString() })
        continue
      }

      saved++
    }

    return saved
  }

  /**
   * Get the HEAD commit hash for a worktree.
   */
  async function getWorktreeHead(wtPath: string): Promise<string | null> {
    const result = await git(["rev-parse", "HEAD"], { cwd: wtPath })
    if (result.exitCode !== 0) return null
    return result.text().trim() || null
  }

  // ── Create bundles ──

  /**
   * Create git bundles for all code repos in the project.
   * Auto-saves experiment worktrees before bundling.
   */
  export async function createBundles(
    worktree: string,
    commitMessages?: Record<string, string>,
  ): Promise<BundleCreateResult[]> {
    const codeDir = path.join(worktree, "code")
    if (!(await Filesystem.exists(codeDir))) return []

    const bDir = bundlesDir(worktree)
    await fs.mkdir(bDir, { recursive: true })

    let entries: string[]
    try {
      entries = await fs.readdir(codeDir)
    } catch {
      return []
    }

    const results: BundleCreateResult[] = []

    for (const codeName of entries) {
      const codePath = path.join(codeDir, codeName)
      if (!(await Filesystem.isDir(codePath))) continue

      // Check if it's a git repo
      const hasGit = await Filesystem.exists(path.join(codePath, ".git"))
      if (!hasGit) continue

      // Auto-save experiment worktrees
      const autoSaved = await autoSaveWorktrees(codePath, commitMessages)

      // Unshallow if needed — shallow repos produce incomplete bundles
      const isShallow = await git(["rev-parse", "--is-shallow-repository"], { cwd: codePath })
      if (isShallow.exitCode === 0 && isShallow.text().trim() === "true") {
        // Try default remote first
        let unshallowed = false
        const unshallow = await git(["fetch", "--unshallow"], { cwd: codePath })
        if (unshallow.exitCode === 0) {
          unshallowed = true
        } else {
          // Try each configured remote explicitly
          const remotes = await git(["remote"], { cwd: codePath })
          if (remotes.exitCode === 0) {
            for (const remote of remotes.text().trim().split("\n").filter(Boolean)) {
              const tryRemote = await git(["fetch", "--unshallow", remote], { cwd: codePath })
              if (tryRemote.exitCode === 0) {
                unshallowed = true
                break
              }
            }
          }
        }
        if (!unshallowed) {
          Log.Default.warn("failed to unshallow repo, bundle may be incomplete", { codeName })
          // Remove shallow markers so bundle at least includes what we have without broken refs
          const shallowFile = path.join(codePath, ".git", "shallow")
          await fs.unlink(shallowFile).catch(() => {})
        }
      }

      // Create bundle
      const bundlePath = path.join(bDir, `${codeName}.bundle`)
      const result = await git(["bundle", "create", bundlePath, "--all"], { cwd: codePath })

      if (result.exitCode !== 0) {
        Log.Default.warn("failed to create bundle", { codeName, error: result.stderr.toString() })
        continue
      }

      results.push({ codeName, bundlePath, autoSaved })
    }

    // Remove stale bundles for repos that no longer exist
    try {
      const bundleFiles = await fs.readdir(bDir)
      const validNames = new Set(results.map((r) => `${r.codeName}.bundle`))
      for (const file of bundleFiles) {
        if (file.endsWith(".bundle") && !validNames.has(file)) {
          await fs.unlink(path.join(bDir, file)).catch(() => {})
        }
      }
    } catch {
      // ok
    }

    return results
  }

  // ── Fetch from bundle ──

  /**
   * Fetch branches from a bundle into an existing code repo using isolated namespace.
   * If the repo doesn't exist, clones from the bundle.
   * Returns true if the repo was newly cloned (vs fetched into existing).
   */
  export async function fetchFromBundle(bundlePath: string, codePath: string): Promise<{ cloned: boolean }> {
    if (!(await Filesystem.exists(codePath))) {
      // Initialize new repo and fetch from bundle via temp namespace to avoid "refusing to fetch into current branch"
      await fs.mkdir(codePath, { recursive: true })
      const init = await git(["init"], { cwd: codePath })
      if (init.exitCode !== 0) {
        throw new Error(`failed to init repo: ${init.stderr.toString()}`)
      }

      // Fetch to temporary remote namespace first
      const fetch = await git(["fetch", bundlePath, "refs/heads/*:refs/remotes/bundle/*"], { cwd: codePath })
      if (fetch.exitCode !== 0) {
        throw new Error(`failed to fetch from bundle: ${fetch.stderr.toString()}`)
      }

      // List remote branches and create local branches from them
      const remoteBranches = await git(["branch", "-r"], { cwd: codePath })
      const branchList = remoteBranches
        .text()
        .trim()
        .split("\n")
        .map((b) => b.trim())
        .filter((b) => b && !b.includes("->"))

      // Create local branches from remote refs
      for (const rb of branchList) {
        const localName = rb.replace(/^bundle\//, "")
        if (!localName) continue
        await git(["branch", localName, rb], { cwd: codePath })
      }

      // Checkout default branch (prefer master/main)
      const localBranches = await git(["branch"], { cwd: codePath })
      const localList = localBranches
        .text()
        .trim()
        .split("\n")
        .map((b) => b.trim().replace(/^\*\s*/, ""))
        .filter(Boolean)

      const defaultBranch = localList.find((b) => b === "master") || localList.find((b) => b === "main") || localList[0]
      if (defaultBranch) {
        await git(["checkout", defaultBranch], { cwd: codePath })
      }

      await ensureGitignore(codePath)
      return { cloned: true }
    }

    // Fetch to isolated namespace (refs/remotes/sync/*)
    const result = await git(["fetch", bundlePath, "+refs/heads/*:refs/remotes/sync/*"], { cwd: codePath })
    if (result.exitCode !== 0) {
      throw new Error(`failed to fetch from bundle: ${result.stderr.toString()}`)
    }

    return { cloned: false }
  }

  // ── Merge experiment branches ──

  /**
   * Smart merge of experiment branches after fetching from bundle.
   * Compares local branches with sync/* remote refs and handles:
   * - Created: remote-only → create local branch
   * - Fast-forward: local behind → merge --ff-only
   * - Local ahead: keep local, remote will catch up on next push
   * - Diverged: attempt merge, mark conflict if it fails
   */
  export async function mergeExperimentBranches(
    codePath: string,
    experiments: ManifestExperiment[],
  ): Promise<BranchMergeResult[]> {
    const results: BranchMergeResult[] = []

    for (const exp of experiments) {
      const branch = exp.exp_branch_name || exp.exp_id
      const codeName = exp.code_name || ""

      // Check if local branch exists
      const localCheck = await git(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: codePath })
      const localExists = localCheck.exitCode === 0

      // Check if remote (sync/) branch exists
      const remoteCheck = await git(["rev-parse", "--verify", `refs/remotes/sync/${branch}`], { cwd: codePath })
      const remoteExists = remoteCheck.exitCode === 0

      if (!localExists && !remoteExists) {
        results.push({ expId: exp.exp_id, expName: exp.exp_name, codeName, action: "missing" })
        continue
      }

      if (!localExists && remoteExists) {
        // Create local branch from remote
        const create = await git(["branch", branch, `sync/${branch}`], { cwd: codePath })
        if (create.exitCode !== 0) {
          results.push({
            expId: exp.exp_id,
            expName: exp.exp_name,
            codeName,
            action: "missing",
            message: `failed to create branch: ${create.stderr.toString()}`,
          })
          continue
        }
        results.push({ expId: exp.exp_id, expName: exp.exp_name, codeName, action: "created" })
        continue
      }

      if (localExists && !remoteExists) {
        results.push({ expId: exp.exp_id, expName: exp.exp_name, codeName, action: "local_only" })
        continue
      }

      // Both exist — compare
      const localHead = (await git(["rev-parse", `refs/heads/${branch}`], { cwd: codePath })).text().trim()
      const remoteHead = (await git(["rev-parse", `refs/remotes/sync/${branch}`], { cwd: codePath })).text().trim()

      if (localHead === remoteHead) {
        results.push({ expId: exp.exp_id, expName: exp.exp_name, codeName, action: "up_to_date" })
        continue
      }

      // Check ancestor relationship
      const mergeBase = await git(["merge-base", localHead, remoteHead], { cwd: codePath })
      if (mergeBase.exitCode !== 0) {
        // No common ancestor — treat as diverged
        results.push({
          expId: exp.exp_id,
          expName: exp.exp_name,
          codeName,
          action: "conflict",
          message: "no common ancestor between local and remote branches",
        })
        continue
      }

      const base = mergeBase.text().trim()

      if (base === localHead) {
        // Local is behind, fast-forward possible
        results.push({ expId: exp.exp_id, expName: exp.exp_name, codeName, action: "ff" })
        continue
      }

      if (base === remoteHead) {
        // Local is ahead
        results.push({ expId: exp.exp_id, expName: exp.exp_name, codeName, action: "local_ahead" })
        continue
      }

      // Diverged
      results.push({ expId: exp.exp_id, expName: exp.exp_name, codeName, action: "diverged" })
    }

    return results
  }

  // ── Restore worktrees and execute merges ──

  /**
   * Rebuild experiment worktrees and execute any pending merges.
   * This handles the actual git worktree add + merge operations in worktree context.
   */
  export async function restoreWorktrees(
    worktree: string,
    experiments: ManifestExperiment[],
    mergeResults: BranchMergeResult[],
  ): Promise<BranchMergeResult[]> {
    const mergeMap = new Map(mergeResults.map((r) => [r.expId, r]))
    const finalResults: BranchMergeResult[] = [...mergeResults]

    // Group experiments by code_name
    const byCode = new Map<string, ManifestExperiment[]>()
    for (const exp of experiments) {
      if (!exp.code_name) continue
      const list = byCode.get(exp.code_name) || []
      list.push(exp)
      byCode.set(exp.code_name, list)
    }

    for (const [codeName, exps] of byCode) {
      const codePath = path.join(worktree, "code", codeName)
      if (!(await Filesystem.exists(codePath))) continue

      for (const exp of exps) {
        const branch = exp.exp_branch_name || exp.exp_id
        const wtPath = path.join(codePath, WORKTREES_DIR, exp.exp_id)
        const mr = mergeMap.get(exp.exp_id)

        if (!mr || mr.action === "missing") continue

        // Ensure worktree exists
        const wtExists = await Filesystem.exists(wtPath)
        if (!wtExists) {
          // Check if the branch exists before creating worktree
          const branchCheck = await git(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: codePath })
          if (branchCheck.exitCode !== 0) {
            Log.Default.warn("branch does not exist, skipping worktree", { expId: exp.exp_id, branch })
            continue
          }

          const addResult = await git(["worktree", "add", wtPath, branch], { cwd: codePath, env: GIT_ENV })
          if (addResult.exitCode !== 0) {
            Log.Default.warn("failed to add worktree", {
              expId: exp.exp_id,
              error: addResult.stderr.toString(),
            })
            continue
          }
        } else {
          // Verify the worktree is on the correct branch
          const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wtPath })
          if (currentBranch.exitCode === 0 && currentBranch.text().trim() !== branch) {
            // Wrong branch — remove and recreate
            await git(["worktree", "remove", "--force", wtPath], { cwd: codePath })
            await git(["worktree", "add", wtPath, branch], { cwd: codePath, env: GIT_ENV })
          }
        }

        // Execute merge in worktree if needed
        if (mr.action === "ff") {
          const mergeResult = await git(["merge", "--ff-only", `sync/${branch}`], { cwd: wtPath, env: GIT_ENV })
          if (mergeResult.exitCode !== 0) {
            // ff failed, try regular merge
            const regularMerge = await git(
              ["merge", `sync/${branch}`, "-m", `sync: merge remote changes for experiment ${exp.exp_id}`],
              { cwd: wtPath, env: GIT_ENV },
            )
            if (regularMerge.exitCode !== 0) {
              updateMergeResult(finalResults, exp.exp_id, "conflict", `merge failed: ${regularMerge.stderr.toString()}`)
            } else {
              updateMergeResult(finalResults, exp.exp_id, "merged")
            }
          }
        } else if (mr.action === "diverged") {
          const mergeResult = await git(
            ["merge", `sync/${branch}`, "-m", `sync: merge remote changes for experiment ${exp.exp_id}`],
            { cwd: wtPath, env: GIT_ENV },
          )
          if (mergeResult.exitCode !== 0) {
            updateMergeResult(
              finalResults,
              exp.exp_id,
              "conflict",
              `conflict in worktree ${wtPath}. Please resolve manually:\n  cd ${wtPath}\n  # edit conflicted files\n  git add <resolved files>\n  git commit`,
            )
          } else {
            updateMergeResult(finalResults, exp.exp_id, "merged")
          }
        }

        // Ensure .gitignore in the code repo root
        await ensureGitignore(codePath)
      }

      // Prune stale worktree references
      await git(["worktree", "prune"], { cwd: codePath })
    }

    return finalResults
  }

  function updateMergeResult(results: BranchMergeResult[], expId: string, action: MergeAction, message?: string) {
    const idx = results.findIndex((r) => r.expId === expId)
    if (idx >= 0) {
      results[idx] = { ...results[idx]!, action, message }
    }
  }

  // ── Regenerate bundle after merge ──

  /**
   * Recreate a bundle for a code repo after merges have been applied.
   */
  export async function regenerateBundle(worktree: string, codeName: string): Promise<string | null> {
    const codePath = path.join(worktree, "code", codeName)
    if (!(await Filesystem.exists(codePath))) return null

    const bDir = bundlesDir(worktree)
    await fs.mkdir(bDir, { recursive: true })

    const bundlePath = path.join(bDir, `${codeName}.bundle`)
    const result = await git(["bundle", "create", bundlePath, "--all"], { cwd: codePath })
    if (result.exitCode !== 0) {
      Log.Default.warn("failed to regenerate bundle", { codeName, error: result.stderr.toString() })
      return null
    }

    return bundlePath
  }

  // ── Prune worktrees ──

  /**
   * Prune stale worktree references for all code repos.
   */
  export async function pruneAllWorktrees(worktree: string): Promise<void> {
    const codeDir = path.join(worktree, "code")
    if (!(await Filesystem.exists(codeDir))) return

    let entries: string[]
    try {
      entries = await fs.readdir(codeDir)
    } catch {
      return
    }

    for (const codeName of entries) {
      const codePath = path.join(codeDir, codeName)
      if (!(await Filesystem.isDir(codePath))) continue
      if (!(await Filesystem.exists(path.join(codePath, ".git")))) continue
      await git(["worktree", "prune"], { cwd: codePath })
    }
  }

  // ── Format merge results for CLI display ──

  export function formatMergeResults(results: BranchMergeResult[]): string {
    if (results.length === 0) return "no experiment branches to merge"

    const parts: string[] = []
    const counts: Record<MergeAction, number> = {
      created: 0,
      local_only: 0,
      up_to_date: 0,
      ff: 0,
      local_ahead: 0,
      merged: 0,
      conflict: 0,
      missing: 0,
      diverged: 0,
    }
    const conflicts: BranchMergeResult[] = []

    for (const r of results) {
      counts[r.action]++
      if (r.action === "conflict") conflicts.push(r)
    }

    if (counts.created) parts.push(`${counts.created} new branches`)
    if (counts.ff) parts.push(`${counts.ff} fast-forwarded`)
    if (counts.merged) parts.push(`${counts.merged} auto-merged`)
    if (counts.up_to_date) parts.push(`${counts.up_to_date} up-to-date`)
    if (counts.local_ahead) parts.push(`${counts.local_ahead} local-ahead`)
    if (counts.local_only) parts.push(`${counts.local_only} local-only`)

    let output = parts.join(", ")

    if (conflicts.length > 0) {
      output += `\n\nConflicts (${conflicts.length}):\n`
      for (const c of conflicts) {
        output += `  - ${c.expName} (${c.expId})`
        if (c.message) output += `\n    ${c.message}`
        output += "\n"
      }
    }

    return output
  }
}
