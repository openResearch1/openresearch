import type { Argv } from "yargs"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Instance } from "../../project/instance"
import { Database, eq } from "../../storage/db"
import { ResearchProjectTable } from "../../research/research.sql"
import { ExperimentTable } from "../../research/research.sql"
import { Sync } from "../../research/sync"
import { Bundle } from "../../research/bundle"
import { Manifest } from "../../research/manifest"
import { git } from "../../util/git"
import { Filesystem } from "../../util/filesystem"
import { Project } from "../../project/project"
import { InstanceBootstrap } from "../../project/bootstrap"
import path from "path"
import fs from "fs/promises"

export const CloneProjectCommand = cmd({
  command: "clone <url> [directory]",
  describe: "clone a research project from a remote git repository",
  builder: (yargs: Argv) => {
    return yargs
      .positional("url", {
        describe: "git repository URL",
        type: "string",
        demandOption: true,
      })
      .positional("directory", {
        describe: "target directory (default: derived from URL)",
        type: "string",
      })
  },
  handler: async (args) => {
    const url = args.url as string
    let targetDir = args.directory as string | undefined

    // Derive directory name from URL if not provided
    if (!targetDir) {
      const urlPath = url.replace(/\.git$/, "")
      targetDir = path.basename(urlPath)
    }

    const absoluteDir = path.resolve(process.cwd(), targetDir)

    UI.empty()
    prompts.intro("openresearch clone", { output: process.stderr })

    // 1. Git clone
    const spin = prompts.spinner({ output: process.stderr })
    spin.start(`Cloning ${url}...`)

    if (await Filesystem.exists(absoluteDir)) {
      spin.stop("Clone failed")
      prompts.log.error(`Directory already exists: ${absoluteDir}`, { output: process.stderr })
      prompts.outro("Clone failed", { output: process.stderr })
      process.exit(1)
    }

    const cloneResult = await git(["clone", url, absoluteDir], { cwd: process.cwd() })
    if (cloneResult.exitCode !== 0) {
      spin.stop("Clone failed")
      prompts.log.error(cloneResult.stderr.toString(), { output: process.stderr })
      prompts.outro("Clone failed", { output: process.stderr })
      process.exit(1)
    }
    spin.stop(`Cloned to ${absoluteDir}`)

    // 2. Initialize local project
    spin.start("Initializing project...")
    const { project, sandbox } = await Project.fromDirectory(absoluteDir)

    await Instance.reload({
      directory: absoluteDir,
      init: InstanceBootstrap,
      project,
      worktree: sandbox,
    })

    // 3. Read manifest
    const manifest = await Manifest.read(absoluteDir)
    if (!manifest) {
      spin.stop("No research manifest found in repository")
      prompts.outro("Clone complete (no research project data)", { output: process.stderr })
      return
    }

    // 4. Reconcile DB
    const reconcileResult = Sync.reconcileFromManifest(
      manifest,
      manifest.project.research_project_id,
      project.id,
      absoluteDir,
    )
    spin.stop(`Database initialized: ${Sync.formatResult(reconcileResult)}`)

    // 5. Restore code repos from bundles
    const bundlesDir = path.join(absoluteDir, ".openresearch/bundles")
    if (await Filesystem.exists(bundlesDir)) {
      spin.start("Restoring code repositories...")

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

        await Bundle.fetchFromBundle(bundlePath, codePath)

        // Rebuild worktrees for this code repo's experiments
        const codeExperiments = manifest.experiments.filter((e) => e.code_name === codeName)
        const simpleResults = codeExperiments.map((exp) => ({
          expId: exp.exp_id,
          expName: exp.exp_name,
          codeName,
          action: "created" as const,
        }))
        await Bundle.restoreWorktrees(absoluteDir, codeExperiments, simpleResults)

        // Update experiment code_path in DB
        for (const exp of codeExperiments) {
          const wtPath = path.join(absoluteDir, "code", codeName, ".openresearch_worktrees", exp.exp_id)
          Database.use((db) =>
            db.update(ExperimentTable).set({ code_path: wtPath }).where(eq(ExperimentTable.exp_id, exp.exp_id)).run(),
          )
        }
      }

      await Bundle.pruneAllWorktrees(absoluteDir)
      spin.stop(`Restored ${bundleFiles.length} code repository(s)`)
    }

    prompts.outro("Clone complete!", { output: process.stderr })
    prompts.log.info(`Research project: ${manifest.project.research_project_id}`, { output: process.stderr })
    prompts.log.info(`  Atoms: ${manifest.atoms.length}`, { output: process.stderr })
    prompts.log.info(`  Experiments: ${manifest.experiments.length}`, { output: process.stderr })
    prompts.log.info(`  Articles: ${manifest.articles.length}`, { output: process.stderr })
  },
})
