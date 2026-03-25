import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Tool } from "./tool"
import { Database, eq } from "../storage/db"
import { ArticleTable } from "../research/research.sql"
import { Research } from "../research/research"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { git } from "../util/git"
import { Bus } from "@/bus"
import { File } from "@/file"
import { FileWatcher } from "../file/watcher"

const GITHUB_URL_RE = /^https?:\/\/(www\.)?github\.com\/.+\/.+/

export const ArticleCodeTool = Tool.define("article_code_attach", {
  description:
    "Attach a code repository to an article in the current research project. " +
    "Accepts either a GitHub URL (will be cloned) or a local directory path (will be copied). " +
    "The code will be placed under the project's code/<article_id>/ directory and the article's code_path will be updated.",
  parameters: z.object({
    articleId: z.string().describe("The article ID to attach code to"),
    source: z
      .string()
      .describe("A GitHub repository URL (https://github.com/owner/repo) or an absolute path to a local directory"),
  }),
  async execute(params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "Failed",
        output: "Current session is not associated with any research project.",
        metadata: { codePath: undefined as string | undefined },
      }
    }

    const article = Database.use((db) =>
      db.select().from(ArticleTable).where(eq(ArticleTable.article_id, params.articleId)).get(),
    )
    if (!article) {
      return {
        title: "Failed",
        output: `Article not found: ${params.articleId}`,
        metadata: { codePath: undefined as string | undefined },
      }
    }

    const codeDest = path.join(Instance.directory, "code", params.articleId)

    if (await Filesystem.exists(codeDest)) {
      return {
        title: "Failed",
        output: `Code directory already exists: ${codeDest}. Remove it first if you want to re-attach.`,
        metadata: { codePath: undefined as string | undefined },
      }
    }

    const isGithub = GITHUB_URL_RE.test(params.source)

    if (isGithub) {
      // Clone into a temp directory first, then move contents to codeDest
      // Using git clone directly into codeDest would create a nested folder
      const result = await git(["clone", "--depth", "1", params.source, codeDest], {
        cwd: Instance.directory,
      })
      if (result.exitCode !== 0) {
        const errMsg = result.stderr?.toString().trim() || result.text?.() || "git clone failed"
        return {
          title: "Failed",
          output: `Failed to clone repository: ${errMsg}`,
          metadata: { codePath: undefined as string | undefined },
        }
      }
    } else {
      // Local directory: copy contents
      const srcDir = path.resolve(params.source)
      if (!(await Filesystem.exists(srcDir))) {
        return {
          title: "Failed",
          output: `Local directory not found: ${srcDir}`,
          metadata: { codePath: undefined as string | undefined },
        }
      }

      const stat = await fs.stat(srcDir)
      if (!stat.isDirectory()) {
        return {
          title: "Failed",
          output: `Source is not a directory: ${srcDir}`,
          metadata: { codePath: undefined as string | undefined },
        }
      }

      await fs.mkdir(path.dirname(codeDest), { recursive: true })
      await fs.cp(srcDir, codeDest, { recursive: true })
    }

    // Notify file system watchers
    await Bus.publish(File.Event.Edited, { file: codeDest })
    await Bus.publish(FileWatcher.Event.Updated, { file: codeDest, event: "add" })

    // Update article code_path in database
    const now = Date.now()
    Database.use((db) =>
      db
        .update(ArticleTable)
        .set({ code_path: codeDest, time_updated: now })
        .where(eq(ArticleTable.article_id, params.articleId))
        .run(),
    )

    return {
      title: `Attached code to article`,
      output: [
        `Code attached successfully.`,
        `- Article: ${params.articleId}`,
        `- Source: ${params.source}`,
        `- Code path: ${codeDest}`,
      ].join("\n"),
      metadata: { codePath: codeDest as string | undefined },
    }
  },
})
