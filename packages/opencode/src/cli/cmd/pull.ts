import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Instance } from "../../project/instance"
import { Database, eq } from "../../storage/db"
import { ResearchProjectTable, ExperimentTable } from "../../research/research.sql"
import { Sync } from "../../research/sync"
import { Bundle } from "../../research/bundle"
import { Manifest, type ManifestExperiment } from "../../research/manifest"
import { git } from "../../util/git"
import { Filesystem } from "../../util/filesystem"
import path from "path"

export const PullCommand = cmd({
  command: "pull",
  describe: "pull research project from remote git repository",
  builder: (yargs: Argv) => {
    return yargs
      .option("remote", {
        describe: "git remote name",
        type: "string",
        default: "origin",
      })
      .option("branch", {
        describe: "branch to pull from",
        type: "string",
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      UI.empty()
      prompts.intro("openresearch pull", { output: process.stderr })

      const worktree = Instance.worktree
      const projectId = Instance.project.id
      const remote = (args.remote as string) || "origin"
      const branch = args.branch as string | undefined

      // 1. Check preconditions
      const researchProject = Database.use((db) =>
        db.select().from(ResearchProjectTable).where(eq(ResearchProjectTable.project_id, projectId)).get(),
      )
      if (!researchProject) {
        prompts.log.error("No research project found in this directory", { output: process.stderr })
        prompts.outro("Pull failed", { output: process.stderr })
        process.exit(1)
      }

      const hasGit = await Filesystem.exists(path.join(worktree, ".git"))
      if (!hasGit) {
        prompts.log.error("Not a git repository", { output: process.stderr })
        prompts.outro("Pull failed", { output: process.stderr })
        process.exit(1)
      }

      const spin = prompts.spinner({ output: process.stderr })

      // 2. Save local state first
      spin.start("Saving local state...")
      await Sync.serializeToManifest(researchProject.research_project_id, worktree)
      await Bundle.createBundles(worktree)

      // Commit local changes if any
      await git(["add", "-A"], { cwd: worktree })
      const localDiff = await git(["diff", "--cached", "--quiet"], { cwd: worktree })
      if (localDiff.exitCode !== 0) {
        await git(["commit", "-m", "sync: auto-save local state before pull"], { cwd: worktree })
      }
      spin.stop("Local state saved")

      // 3. Fetch and merge
      spin.start("Fetching from remote...")
      const fetchResult = await git(["fetch", remote], { cwd: worktree })
      if (fetchResult.exitCode !== 0) {
        spin.stop("Fetch failed")
        prompts.log.error(fetchResult.stderr.toString(), { output: process.stderr })
        prompts.outro("Pull failed", { output: process.stderr })
        process.exit(1)
      }

      // Determine merge target
      let mergeRef = branch ? `${remote}/${branch}` : ""
      if (!mergeRef) {
        // Auto-detect: use tracking branch or remote/HEAD
        const trackResult = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
          cwd: worktree,
        })
        if (trackResult.exitCode === 0) {
          mergeRef = trackResult.text().trim()
        } else {
          mergeRef = `${remote}/master`
        }
      }

      const mergeResult = await git(["merge", mergeRef], { cwd: worktree })
      if (mergeResult.exitCode !== 0) {
        const stderr = mergeResult.stderr.toString()
        // Handle bundle binary conflicts
        const bundleConflicts = await handleSyncConflicts(worktree)
        if (bundleConflicts > 0) {
          // Try to continue merge after resolving bundle conflicts
          const continueResult = await git(["merge", "--continue"], { cwd: worktree })
          if (continueResult.exitCode !== 0) {
            spin.stop("Merge has conflicts")
            prompts.log.warn(
              `Resolved ${bundleConflicts} bundle conflict(s), but other conflicts remain.\n` +
                "Please resolve them manually, then run 'git merge --continue'.",
              { output: process.stderr },
            )
            prompts.outro("Pull partially complete - resolve conflicts to finish", { output: process.stderr })
            return
          }
        } else if (stderr.includes("CONFLICT")) {
          spin.stop("Merge has conflicts")
          prompts.log.warn("Please resolve conflicts manually, then run 'opencode pull' again.", {
            output: process.stderr,
          })
          prompts.outro("Pull needs manual conflict resolution", { output: process.stderr })
          return
        } else if (stderr.includes("Already up to date")) {
          spin.stop("Already up to date")
        } else {
          spin.stop("Merge failed")
          prompts.log.error(stderr, { output: process.stderr })
          prompts.outro("Pull failed", { output: process.stderr })
          process.exit(1)
        }
      }
      spin.stop("Merged remote changes")

      // 4. Read manifest and reconcile DB
      spin.start("Reconciling database...")
      const manifest = await Manifest.read(worktree)
      if (!manifest) {
        spin.stop("No manifest found in pulled data")
        prompts.outro("Pull complete (no research data to sync)", { output: process.stderr })
        return
      }

      const reconcileResult = Sync.reconcileFromManifest(
        manifest,
        researchProject.research_project_id,
        projectId,
        worktree,
      )
      spin.stop(`Database reconciled: ${Sync.formatResult(reconcileResult)}`)

      // 5. Restore code repos from bundles
      const bundlesDir = path.join(worktree, ".openresearch/bundles")
      if (await Filesystem.exists(bundlesDir)) {
        spin.start("Restoring code repositories...")
        const { mergeResults, codeNames } = await restoreCodeRepos(worktree, manifest.experiments)

        if (mergeResults.length > 0) {
          spin.stop(`Code repos restored:\n${Bundle.formatMergeResults(mergeResults)}`)

          // 6. Regenerate bundles after merge and commit
          spin.start("Updating bundles...")
          for (const codeName of codeNames) {
            await Bundle.regenerateBundle(worktree, codeName)
          }
          await git(["add", ".openresearch/bundles/"], { cwd: worktree })
          const bundleDiff = await git(["diff", "--cached", "--quiet"], { cwd: worktree })
          if (bundleDiff.exitCode !== 0) {
            await git(["commit", "-m", "sync: update bundles after merge"], { cwd: worktree })
          }
          spin.stop("Bundles updated")
        } else {
          spin.stop("No code repositories to restore")
        }
      }

      prompts.outro("Pull complete!", { output: process.stderr })
    })
  },
})

async function handleSyncConflicts(worktree: string): Promise<number> {
  // Auto-resolve conflicts for files that are safe to accept theirs:
  // - .bundle files (binary, will be regenerated after merge)
  // - project.json (contains synced_at timestamp that changes every serialize)
  const statusResult = await git(["status", "--porcelain"], { cwd: worktree })
  if (statusResult.exitCode !== 0) return 0

  let resolved = 0
  const lines = statusResult.text().trim().split("\n")
  for (const line of lines) {
    if (!line.startsWith("UU ")) continue
    const file = line.slice(3)
    if (file.endsWith(".bundle") || file.endsWith("project.json")) {
      await git(["checkout", "--theirs", file], { cwd: worktree })
      await git(["add", file], { cwd: worktree })
      resolved++
    }
  }
  return resolved
}

async function restoreCodeRepos(
  worktree: string,
  experiments: ManifestExperiment[],
): Promise<{
  mergeResults: ReturnType<typeof Bundle.mergeExperimentBranches> extends Promise<infer T> ? T : never
  codeNames: string[]
}> {
  const bundlesDir = path.join(worktree, ".openresearch/bundles")
  const codeDir = path.join(worktree, "code")

  let bundleFiles: string[]
  try {
    bundleFiles = (await (await import("fs/promises")).readdir(bundlesDir)).filter((f) => f.endsWith(".bundle"))
  } catch {
    return { mergeResults: [], codeNames: [] }
  }

  const codeNames: string[] = []
  let allMergeResults: Awaited<ReturnType<typeof Bundle.mergeExperimentBranches>> = []

  for (const bundleFile of bundleFiles) {
    const codeName = bundleFile.replace(/\.bundle$/, "")
    const bundlePath = path.join(bundlesDir, bundleFile)
    const codePath = path.join(codeDir, codeName)
    codeNames.push(codeName)

    // Fetch or clone from bundle
    const { cloned } = await Bundle.fetchFromBundle(bundlePath, codePath)

    if (!cloned) {
      // Merge experiment branches
      const codeExperiments = experiments.filter((e) => e.code_name === codeName)
      const mergeResults = await Bundle.mergeExperimentBranches(codePath, codeExperiments)

      // Restore worktrees and execute merges
      const finalResults = await Bundle.restoreWorktrees(worktree, codeExperiments, mergeResults)
      allMergeResults = allMergeResults.concat(finalResults)
    } else {
      // For cloned repos, just rebuild worktrees (no merging needed)
      const codeExperiments = experiments.filter((e) => e.code_name === codeName)
      const simpleResults = codeExperiments.map((exp) => ({
        expId: exp.exp_id,
        expName: exp.exp_name,
        codeName,
        action: "created" as const,
      }))
      await Bundle.restoreWorktrees(worktree, codeExperiments, simpleResults)
      allMergeResults = allMergeResults.concat(simpleResults)
    }

    // Update experiment code_path in DB
    const codeExperiments = experiments.filter((e) => e.code_name === codeName)
    for (const exp of codeExperiments) {
      const codePath2 = path.join(worktree, "code", codeName, ".openresearch_worktrees", exp.exp_id)
      Database.use((db) =>
        db.update(ExperimentTable).set({ code_path: codePath2 }).where(eq(ExperimentTable.exp_id, exp.exp_id)).run(),
      )
    }
  }

  // Prune all worktrees
  await Bundle.pruneAllWorktrees(worktree)

  return { mergeResults: allMergeResults, codeNames }
}
