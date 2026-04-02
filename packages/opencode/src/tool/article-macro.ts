import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Database, eq } from "../storage/db"
import { ArticleTable } from "../research/research.sql"
import { Research } from "../research/research"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { FileTime } from "../file/time"
import { Bus } from "@/bus"
import { File } from "@/file"
import { FileWatcher } from "../file/watcher"
import { createTwoFilesPatch } from "diff"
import { trimDiff, replace } from "./edit"

export const ArticleMacroEditTool = Tool.define("article_macro_edit", {
  description:
    "Edit or create the macro table document for a LaTeX article in the current research project. " +
    "Use oldString='' to create a new macro table file. " +
    "Use oldString with content to edit an existing macro table.",
  parameters: z.object({
    articleId: z.string().describe("The article ID whose macro table should be edited."),
    oldString: z.string().describe("The text to replace. Empty string means create a new file."),
    newString: z.string().describe("The replacement text or new file content."),
  }),
  async execute(params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "Failed",
        output: "Current session is not associated with any research project.",
        metadata: { filepath: undefined as string | undefined },
      }
    }

    const article = Database.use((db) => db.select().from(ArticleTable).where(eq(ArticleTable.article_id, params.articleId)).get())
    if (!article || article.research_project_id !== researchProjectId) {
      return {
        title: "Failed",
        output: `Article not found in current research project: ${params.articleId}`,
        metadata: { filepath: undefined as string | undefined },
      }
    }

    const filepath = article.macro_table_path ?? path.join(Instance.directory, "article_artifacts", params.articleId, "macro_table.md")

    if (!article.macro_table_path && params.oldString === "") {
      const diff = trimDiff(createTwoFilesPatch(filepath, filepath, "", params.newString))
      await ctx.ask({
        permission: "research_doc_edit",
        patterns: [path.relative(Instance.worktree, filepath)],
        always: ["*"],
        metadata: { filepath, diff },
      })

      await Filesystem.write(filepath, params.newString)
      await Bus.publish(File.Event.Edited, { file: filepath })
      await Bus.publish(FileWatcher.Event.Updated, { file: filepath, event: "add" })
      FileTime.read(ctx.sessionID, filepath)
      Research.updateArticleMacroTablePath(params.articleId, filepath)

      return {
        title: "Created macro_table.md",
        output: "macro table file created successfully.",
        metadata: { filepath },
      }
    }

    if (!(await Filesystem.exists(filepath))) {
      if (params.oldString !== "") {
        return {
          title: "Failed",
          output: `Macro table file not found on disk: ${filepath}`,
          metadata: { filepath: undefined as string | undefined },
        }
      }

      const diff = trimDiff(createTwoFilesPatch(filepath, filepath, "", params.newString))
      await ctx.ask({
        permission: "research_doc_edit",
        patterns: [path.relative(Instance.worktree, filepath)],
        always: ["*"],
        metadata: { filepath, diff },
      })

      await Filesystem.write(filepath, params.newString)
      await Bus.publish(File.Event.Edited, { file: filepath })
      await Bus.publish(FileWatcher.Event.Updated, { file: filepath, event: "add" })
      FileTime.read(ctx.sessionID, filepath)
      Research.updateArticleMacroTablePath(params.articleId, filepath)

      return {
        title: "Created macro_table.md",
        output: "macro table file created successfully.",
        metadata: { filepath },
      }
    }

    if (params.oldString === "") {
      const contentOld = await Filesystem.readText(filepath)
      const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.newString))
      await ctx.ask({
        permission: "research_doc_edit",
        patterns: [path.relative(Instance.worktree, filepath)],
        always: ["*"],
        metadata: { filepath, diff },
      })
      await Filesystem.write(filepath, params.newString)
    } else {
      await FileTime.assert(ctx.sessionID, filepath)
      const contentOld = await Filesystem.readText(filepath)
      const contentNew = replace(contentOld, params.oldString, params.newString)
      const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
      await ctx.ask({
        permission: "research_doc_edit",
        patterns: [path.relative(Instance.worktree, filepath)],
        always: ["*"],
        metadata: { filepath, diff },
      })
      await Filesystem.write(filepath, contentNew)
    }

    await Bus.publish(File.Event.Edited, { file: filepath })
    await Bus.publish(FileWatcher.Event.Updated, { file: filepath, event: "change" })
    FileTime.read(ctx.sessionID, filepath)
    Research.updateArticleMacroTablePath(params.articleId, filepath)

    return {
      title: path.relative(Instance.worktree, filepath),
      output: "macro table file edited successfully.",
      metadata: { filepath },
    }
  },
})
