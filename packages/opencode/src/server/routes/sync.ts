import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Database, eq } from "@/storage/db"
import { ResearchProjectTable, ExperimentTable } from "@/research/research.sql"
import { Instance } from "@/project/instance"
import { Sync } from "@/research/sync"
import { Bundle } from "@/research/bundle"
import { Manifest } from "@/research/manifest"
import { git } from "@/util/git"
import { Filesystem } from "@/util/filesystem"
import { Project } from "@/project/project"
import { InstanceBootstrap } from "@/project/bootstrap"
import { HTTPException } from "hono/http-exception"

function getResearchProject() {
  const projectId = Instance.project.id
  const rp = Database.use((db) =>
    db.select().from(ResearchProjectTable).where(eq(ResearchProjectTable.project_id, projectId)).get(),
  )
  if (!rp) throw new HTTPException(404, { message: "research project not found" })
  return rp
}

const pushSchema = z.object({
  message: z.string().optional(),
  remote: z.string().default("origin"),
  remoteUrl: z.string().optional(),
  branch: z.string().optional(),
  force: z.boolean().default(false),
  commitMessages: z.record(z.string(), z.string()).optional(),
})

const pullSchema = z.object({
  remote: z.string().default("origin"),
  branch: z.string().optional(),
  commitMessages: z.record(z.string(), z.string()).optional(),
  localCommitMessage: z.string().optional(),
})

const cloneSchema = z.object({
  url: z.string(),
  directory: z.string().optional(),
})

export const SyncRoutes = new Hono()
  // ── Push ──
  .post(
    "/push",
    describeRoute({
      operationId: "sync.push",
      description: "Push research project to remote git repository",
      responses: {
        200: {
          description: "Push result",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  ok: z.boolean(),
                  message: z.string().optional(),
                  needsRemoteUrl: z.boolean().optional(),
                  needsMessage: z.boolean().optional(),
                  defaultMessage: z.string().optional(),
                  needsCommitMessages: z.boolean().optional(),
                  dirtyExperiments: z
                    .array(z.object({ expId: z.string(), expName: z.string(), codeName: z.string() }))
                    .optional(),
                }),
              ),
            },
          },
        },
      },
    }),
    validator("json", pushSchema),
    async (c) => {
      const body = c.req.valid("json")
      const worktree = Instance.worktree
      const rp = getResearchProject()

      // Ensure .gitignore
      const gitignorePath = path.join(worktree, ".gitignore")
      const existing = await fs.readFile(gitignorePath, "utf-8").catch(() => "")
      const rules = [
        "/code/",
        ".openresearch/plans/",
        ".openresearch/successful/",
        ".openresearch/jobs/",
        ".openresearch/bin/",
      ]
      const existingLines = new Set(existing.split("\n").map((l) => l.trim()))
      const missing = rules.filter((r) => !existingLines.has(r))
      if (missing.length > 0) {
        const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
        await fs.appendFile(gitignorePath, `${sep}# openresearch sync\n${missing.join("\n")}\n`)
      }

      // Check if remote exists (before doing any work)
      const remoteCheck = await git(["remote", "get-url", body.remote], { cwd: worktree })
      if (remoteCheck.exitCode !== 0) {
        if (body.remoteUrl) {
          const addResult = await git(["remote", "add", body.remote, body.remoteUrl], { cwd: worktree })
          if (addResult.exitCode !== 0) {
            return c.json({ ok: false, message: `failed to add remote: ${addResult.stderr.toString()}` }, 500)
          }
        } else {
          return c.json({ ok: false, message: "remote_not_found", needsRemoteUrl: true })
        }
      }

      // Pre-check: if no message provided, return default message and dirty worktree info
      if (!body.message) {
        const manifest = await Sync.serializeToManifest(rp.research_project_id, worktree)
        const defaultMessage = `sync: update ${manifest.atoms.length} atoms, ${manifest.experiments.length} experiments`

        const dirtyWorktrees = await Bundle.getDirtyWorktrees(worktree)
        const dirtyExperiments =
          dirtyWorktrees.length > 0
            ? dirtyWorktrees.map((dw) => {
                const exp = Database.use((db) =>
                  db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, dw.expId)).get(),
                )
                return { expId: dw.expId, expName: exp?.exp_name || dw.expId, codeName: dw.codeName }
              })
            : undefined

        return c.json({
          ok: false,
          needsMessage: true,
          defaultMessage,
          needsCommitMessages: dirtyWorktrees.length > 0 ? true : undefined,
          dirtyExperiments,
        })
      }

      // Serialize
      const manifest = await Sync.serializeToManifest(rp.research_project_id, worktree)

      // Create bundles
      const bundles = await Bundle.createBundles(worktree, body.commitMessages)

      // Git add & commit — only add paths that exist to avoid git add errors
      const addPaths = [
        ".openresearch/manifest/",
        ".openresearch/bundles/",
        "atom_list/",
        "articles/",
        "exp_results/",
        "background.md",
        "goal.md",
        "macro_table.md",
        ".gitignore",
      ]
      const existingPaths: string[] = []
      for (const p of addPaths) {
        if (await Filesystem.exists(path.join(worktree, p))) {
          existingPaths.push(p)
        }
      }
      if (existingPaths.length > 0) {
        await git(["add", ...existingPaths], { cwd: worktree })
      }

      const diff = await git(["diff", "--cached", "--quiet"], { cwd: worktree })
      if (diff.exitCode === 0) {
        return c.json({ ok: true, message: "no changes to push" })
      }

      const msg =
        body.message || `sync: update ${manifest.atoms.length} atoms, ${manifest.experiments.length} experiments`
      const commitResult = await git(["commit", "-m", msg], { cwd: worktree })
      if (commitResult.exitCode !== 0) {
        return c.json({ ok: false, message: `commit failed: ${commitResult.stderr.toString()}` }, 500)
      }

      // Push — always specify branch to avoid "no upstream" error
      let branch = body.branch
      if (!branch) {
        const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree })
        branch = head.text().trim() || "master"
      }
      const pushArgs = ["push", "-u", body.remote, branch]
      if (body.force) pushArgs.push("--force")

      const pushResult = await git(pushArgs, { cwd: worktree })
      if (pushResult.exitCode !== 0) {
        return c.json({ ok: false, message: `push failed: ${pushResult.stderr.toString()}` }, 500)
      }

      return c.json({
        ok: true,
        message: `pushed ${manifest.atoms.length} atoms, ${manifest.experiments.length} experiments, ${bundles.length} code bundle(s)`,
      })
    },
  )
  // ── Pull ──
  .post(
    "/pull",
    describeRoute({
      operationId: "sync.pull",
      description: "Pull research project from remote git repository",
      responses: {
        200: {
          description: "Pull result",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  ok: z.boolean(),
                  message: z.string().optional(),
                  reconciled: z.string().optional(),
                  mergeResults: z.string().optional(),
                  needsCommitMessages: z.boolean().optional(),
                  dirtyExperiments: z
                    .array(z.object({ expId: z.string(), expName: z.string(), codeName: z.string() }))
                    .optional(),
                  needsLocalCommitMessage: z.boolean().optional(),
                }),
              ),
            },
          },
        },
      },
    }),
    validator("json", pullSchema),
    async (c) => {
      const body = c.req.valid("json")
      const worktree = Instance.worktree
      const projectId = Instance.project.id
      const rp = getResearchProject()

      // Check for dirty state before saving
      const needsMessages = !body.commitMessages || !body.localCommitMessage
      if (needsMessages) {
        const dirtyWorktrees = !body.commitMessages ? await Bundle.getDirtyWorktrees(worktree) : []

        // Check if main repo has uncommitted changes
        let mainRepoDirty = false
        if (!body.localCommitMessage) {
          await Sync.serializeToManifest(rp.research_project_id, worktree)
          const preStatus = await git(["status", "--porcelain"], { cwd: worktree })
          mainRepoDirty = preStatus.exitCode === 0 && !!preStatus.text().trim()
        }

        if (dirtyWorktrees.length > 0 || mainRepoDirty) {
          const dirtyExperiments = dirtyWorktrees.map((dw) => {
            const exp = Database.use((db) =>
              db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, dw.expId)).get(),
            )
            return { expId: dw.expId, expName: exp?.exp_name || dw.expId, codeName: dw.codeName }
          })
          return c.json({
            ok: false,
            needsCommitMessages: dirtyWorktrees.length > 0 ? true : undefined,
            dirtyExperiments: dirtyWorktrees.length > 0 ? dirtyExperiments : undefined,
            needsLocalCommitMessage: mainRepoDirty ? true : undefined,
          })
        }
      }

      // Save local state
      await Sync.serializeToManifest(rp.research_project_id, worktree)
      await Bundle.createBundles(worktree, body.commitMessages)
      await git(["add", "-A"], { cwd: worktree })
      const localDiff = await git(["diff", "--cached", "--quiet"], { cwd: worktree })
      if (localDiff.exitCode !== 0) {
        const localMsg = body.localCommitMessage || "sync: auto-save before pull"
        await git(["commit", "-m", localMsg], { cwd: worktree })
      }

      // Fetch
      const fetchResult = await git(["fetch", body.remote], { cwd: worktree })
      if (fetchResult.exitCode !== 0) {
        return c.json({ ok: false, message: `fetch failed: ${fetchResult.stderr.toString()}` }, 500)
      }

      // Merge
      let mergeRef = body.branch ? `${body.remote}/${body.branch}` : ""
      if (!mergeRef) {
        const track = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: worktree })
        mergeRef = track.exitCode === 0 ? track.text().trim() : `${body.remote}/master`
      }

      const mergeResult = await git(["merge", mergeRef], { cwd: worktree })
      const mergeOutput = mergeResult.text() + mergeResult.stderr.toString()
      if (mergeResult.exitCode !== 0 && !mergeOutput.includes("Already up to date")) {
        // Auto-resolve safe conflicts (.bundle, project.json)
        const statusResult = await git(["status", "--porcelain"], { cwd: worktree })
        let autoResolved = 0
        if (statusResult.exitCode === 0) {
          for (const line of statusResult.text().trim().split("\n")) {
            if (!line.startsWith("UU ")) continue
            const file = line.slice(3)
            if (file.endsWith(".bundle") || file.endsWith("project.json")) {
              await git(["checkout", "--theirs", file], { cwd: worktree })
              await git(["add", file], { cwd: worktree })
              autoResolved++
            }
          }
        }
        if (autoResolved > 0) {
          const continueResult = await git(["merge", "--continue"], { cwd: worktree })
          if (continueResult.exitCode !== 0) {
            return c.json({ ok: false, message: `merge conflict. Resolve manually then retry.\n${mergeOutput}` }, 409)
          }
        } else {
          return c.json({ ok: false, message: `merge conflict. Resolve manually then retry.\n${mergeOutput}` }, 409)
        }
      }

      // Reconcile
      const manifest = await Manifest.read(worktree)
      if (!manifest) {
        return c.json({ ok: true, message: "no manifest found" })
      }

      const reconcileResult = Sync.reconcileFromManifest(manifest, rp.research_project_id, projectId, worktree)

      // Restore code repos
      const bundlesDir = path.join(worktree, ".openresearch/bundles")
      let mergeResultsStr = ""
      if (await Filesystem.exists(bundlesDir)) {
        let bundleFiles: string[]
        try {
          bundleFiles = (await fs.readdir(bundlesDir)).filter((f) => f.endsWith(".bundle"))
        } catch {
          bundleFiles = []
        }

        const allMergeResults: Awaited<ReturnType<typeof Bundle.mergeExperimentBranches>> = []
        for (const bundleFile of bundleFiles) {
          const codeName = bundleFile.replace(/\.bundle$/, "")
          const bundlePath = path.join(bundlesDir, bundleFile)
          const codePath = path.join(worktree, "code", codeName)

          const { cloned } = await Bundle.fetchFromBundle(bundlePath, codePath)
          const codeExps = manifest.experiments.filter((e) => e.code_name === codeName)

          if (!cloned) {
            const mr = await Bundle.mergeExperimentBranches(codePath, codeExps)
            const final = await Bundle.restoreWorktrees(worktree, codeExps, mr)
            allMergeResults.push(...final)
          } else {
            const simple = codeExps.map((e) => ({
              expId: e.exp_id,
              expName: e.exp_name,
              codeName,
              action: "created" as const,
            }))
            await Bundle.restoreWorktrees(worktree, codeExps, simple)
            allMergeResults.push(...simple)
          }

          // Update code_path in DB
          for (const exp of codeExps) {
            const wtPath = path.join(worktree, "code", codeName, ".openresearch_worktrees", exp.exp_id)
            Database.use((db) =>
              db.update(ExperimentTable).set({ code_path: wtPath }).where(eq(ExperimentTable.exp_id, exp.exp_id)).run(),
            )
          }

          await Bundle.regenerateBundle(worktree, codeName)
        }

        mergeResultsStr = Bundle.formatMergeResults(allMergeResults)

        // Commit updated bundles
        await git(["add", ".openresearch/bundles/"], { cwd: worktree })
        const bundleDiff = await git(["diff", "--cached", "--quiet"], { cwd: worktree })
        if (bundleDiff.exitCode !== 0) {
          await git(["commit", "-m", "sync: update bundles after pull"], { cwd: worktree })
        }

        await Bundle.pruneAllWorktrees(worktree)
      }

      return c.json({
        ok: true,
        message: "pull complete",
        reconciled: Sync.formatResult(reconcileResult),
        mergeResults: mergeResultsStr || undefined,
      })
    },
  )
  // ── Clone ──
  .post(
    "/clone",
    describeRoute({
      operationId: "sync.clone",
      description: "Clone a research project from a remote git repository",
      responses: {
        200: {
          description: "Clone result",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  ok: z.boolean(),
                  message: z.string(),
                  directory: z.string().optional(),
                  reconciled: z.string().optional(),
                }),
              ),
            },
          },
        },
      },
    }),
    validator("json", cloneSchema),
    async (c) => {
      const body = c.req.valid("json")
      let targetDir = body.directory
      if (!targetDir) {
        targetDir = path.basename(body.url.replace(/\.git$/, ""))
      }
      const absoluteDir = path.resolve(Instance.worktree, targetDir)

      if (await Filesystem.exists(absoluteDir)) {
        return c.json({ ok: false, message: `directory already exists: ${absoluteDir}` }, 400)
      }

      // Clone
      const cloneResult = await git(["clone", body.url, absoluteDir], { cwd: Instance.worktree })
      if (cloneResult.exitCode !== 0) {
        return c.json({ ok: false, message: `clone failed: ${cloneResult.stderr.toString()}` }, 500)
      }

      // Initialize project
      const { project, sandbox } = await Project.fromDirectory(absoluteDir)
      await Instance.reload({
        directory: absoluteDir,
        init: InstanceBootstrap,
        project,
        worktree: sandbox,
      })

      // Read manifest
      const manifest = await Manifest.read(absoluteDir)
      if (!manifest) {
        return c.json({ ok: true, message: "cloned (no research data)", directory: absoluteDir })
      }

      // Reconcile
      const reconcileResult = Sync.reconcileFromManifest(
        manifest,
        manifest.project.research_project_id,
        project.id,
        absoluteDir,
      )

      // Restore code repos
      const bundlesDir = path.join(absoluteDir, ".openresearch/bundles")
      if (await Filesystem.exists(bundlesDir)) {
        let bundleFiles: string[]
        try {
          bundleFiles = (await fs.readdir(bundlesDir)).filter((f) => f.endsWith(".bundle"))
        } catch {
          bundleFiles = []
        }

        for (const bundleFile of bundleFiles) {
          const codeName = bundleFile.replace(/\.bundle$/, "")
          const bundlePath = path.join(bundlesDir, bundleFile)
          const codePath = path.join(absoluteDir, "code", codeName)

          try {
            await Bundle.fetchFromBundle(bundlePath, codePath)
          } catch {
            continue
          }

          const codeExps = manifest.experiments.filter((e) => e.code_name === codeName)

          const simple = codeExps.map((e) => ({
            expId: e.exp_id,
            expName: e.exp_name,
            codeName,
            action: "created" as const,
          }))
          await Bundle.restoreWorktrees(absoluteDir, codeExps, simple)

          for (const exp of codeExps) {
            const wtPath = path.join(absoluteDir, "code", codeName, ".openresearch_worktrees", exp.exp_id)
            Database.use((db) =>
              db.update(ExperimentTable).set({ code_path: wtPath }).where(eq(ExperimentTable.exp_id, exp.exp_id)).run(),
            )
          }
        }

        await Bundle.pruneAllWorktrees(absoluteDir)
      }

      return c.json({
        ok: true,
        message: "clone complete",
        directory: absoluteDir,
        reconciled: Sync.formatResult(reconcileResult),
      })
    },
  )
