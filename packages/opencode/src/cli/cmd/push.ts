import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Instance } from "../../project/instance"
import { Database, eq } from "../../storage/db"
import { ResearchProjectTable } from "../../research/research.sql"
import { Sync } from "../../research/sync"
import { Bundle } from "../../research/bundle"
import { git } from "../../util/git"
import { Filesystem } from "../../util/filesystem"
import path from "path"
import fs from "fs/promises"

const SYNC_GITIGNORE_RULES = [
  "/code/",
  ".openresearch/plans/",
  ".openresearch/successful/",
  ".openresearch/jobs/",
  ".openresearch/bin/",
]

async function ensureSyncGitignore(worktree: string): Promise<boolean> {
  const gitignorePath = path.join(worktree, ".gitignore")
  const existing = await fs.readFile(gitignorePath, "utf-8").catch(() => "")
  const existingLines = new Set(existing.split("\n").map((l) => l.trim()))
  const missing = SYNC_GITIGNORE_RULES.filter((rule) => !existingLines.has(rule))
  if (missing.length === 0) return false
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
  const patch = `${separator}# openresearch sync\n${missing.join("\n")}\n`
  await fs.appendFile(gitignorePath, patch)
  return true
}

export const PushCommand = cmd({
  command: "push",
  describe: "push research project to remote git repository",
  builder: (yargs: Argv) => {
    return yargs
      .option("message", {
        alias: "m",
        describe: "commit message",
        type: "string",
      })
      .option("remote", {
        describe: "git remote name",
        type: "string",
        default: "origin",
      })
      .option("branch", {
        describe: "branch to push to",
        type: "string",
      })
      .option("force", {
        alias: "f",
        describe: "force push",
        type: "boolean",
        default: false,
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      UI.empty()
      prompts.intro("openresearch push", { output: process.stderr })

      const worktree = Instance.worktree
      const projectId = Instance.project.id

      // 1. Check preconditions
      const researchProject = Database.use((db) =>
        db.select().from(ResearchProjectTable).where(eq(ResearchProjectTable.project_id, projectId)).get(),
      )
      if (!researchProject) {
        prompts.log.error("No research project found in this directory", { output: process.stderr })
        prompts.outro("Push failed", { output: process.stderr })
        process.exit(1)
      }

      // Check git initialized
      const hasGit = await Filesystem.exists(path.join(worktree, ".git"))
      if (!hasGit) {
        prompts.log.error("Not a git repository. Run 'git init' first.", { output: process.stderr })
        prompts.outro("Push failed", { output: process.stderr })
        process.exit(1)
      }

      const spin = prompts.spinner({ output: process.stderr })

      // 2. Ensure .gitignore
      await ensureSyncGitignore(worktree)

      // 3. Serialize DB → Manifest
      spin.start("Serializing research project to manifest...")
      const manifest = await Sync.serializeToManifest(researchProject.research_project_id, worktree)
      const atomCount = manifest.atoms.length
      const expCount = manifest.experiments.length
      spin.stop(`Serialized ${atomCount} atoms, ${expCount} experiments`)

      // 4. Create bundles for code repos
      spin.start("Creating code bundles...")
      const bundles = await Bundle.createBundles(worktree)
      const autoSaved = bundles.reduce((sum, b) => sum + b.autoSaved, 0)
      spin.stop(
        bundles.length > 0
          ? `Created ${bundles.length} bundle(s)${autoSaved > 0 ? `, auto-saved ${autoSaved} worktree(s)` : ""}`
          : "No code repositories to bundle",
      )

      // 5. Git add & commit
      spin.start("Staging changes...")
      await git(["add", ".openresearch/manifest/", ".openresearch/bundles/"], { cwd: worktree })
      await git(
        ["add", "atom_list/", "articles/", "exp_results/", "background.md", "goal.md", "macro_table.md", ".gitignore"],
        { cwd: worktree },
      )

      // Check if there are staged changes
      const diffResult = await git(["diff", "--cached", "--quiet"], { cwd: worktree })
      if (diffResult.exitCode === 0) {
        spin.stop("No changes to commit")
        prompts.outro("Everything up to date", { output: process.stderr })
        return
      }

      // Generate commit message
      let commitMsg = args.message as string | undefined
      if (!commitMsg) {
        commitMsg = `sync: update ${atomCount} atoms, ${expCount} experiments`
      }

      const commitResult = await git(["commit", "-m", commitMsg], { cwd: worktree })
      if (commitResult.exitCode !== 0) {
        spin.stop("Commit failed")
        prompts.log.error(commitResult.stderr.toString(), { output: process.stderr })
        prompts.outro("Push failed", { output: process.stderr })
        process.exit(1)
      }
      spin.stop("Changes committed")

      // 6. Push to remote
      const remote = (args.remote as string) || "origin"
      const branch = (args.branch as string) || ""

      // Check if remote exists
      const remoteResult = await git(["remote", "get-url", remote], { cwd: worktree })
      if (remoteResult.exitCode !== 0) {
        // Prompt for remote URL
        const remoteUrl = await prompts.text({
          message: `Remote '${remote}' not found. Enter the remote URL:`,
          placeholder: "git@github.com:user/repo.git",
          output: process.stderr,
        })

        if (prompts.isCancel(remoteUrl)) {
          throw new UI.CancelledError()
        }

        const addResult = await git(["remote", "add", remote, remoteUrl as string], { cwd: worktree })
        if (addResult.exitCode !== 0) {
          prompts.log.error(`Failed to add remote: ${addResult.stderr.toString()}`, { output: process.stderr })
          prompts.outro("Push failed", { output: process.stderr })
          process.exit(1)
        }
      }

      spin.start(`Pushing to ${remote}...`)
      const pushArgs = ["push", "-u", remote]
      if (branch) pushArgs.push(branch)
      if (args.force) pushArgs.push("--force")

      const pushResult = await git(pushArgs, { cwd: worktree })
      if (pushResult.exitCode !== 0) {
        spin.stop("Push failed")
        prompts.log.error(pushResult.stderr.toString(), { output: process.stderr })
        prompts.log.warn("Try pulling first: opencode pull", { output: process.stderr })
        prompts.outro("Push failed", { output: process.stderr })
        process.exit(1)
      }
      spin.stop("Pushed to remote")

      prompts.outro("Push complete!", { output: process.stderr })
    })
  },
})
