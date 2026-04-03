import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Research } from "../research/research"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { FileTime } from "../file/time"
import { Bus } from "@/bus"
import { File } from "@/file"
import { FileWatcher } from "../file/watcher"
import { createTwoFilesPatch } from "diff"
import { trimDiff, replace } from "./edit"

interface DocFieldConfig {
  field: "background" | "goal" | "macro_table"
  fileName: string
  getPath: (project: NonNullable<ReturnType<typeof Research.getResearchProject>>) => string | null
  updatePath: (researchProjectId: string, filePath: string) => void
}

function defineResearchDocTool(id: string, description: string, config: DocFieldConfig) {
  const label = config.field

  return Tool.define(id, {
    description,
    parameters: z.object({
      oldString: z.string().describe("The text to replace. Empty string means create new file."),
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

      const project = Research.getResearchProject(researchProjectId)
      if (!project) {
        return {
          title: "Failed",
          output: "Research project not found.",
          metadata: { filepath: undefined as string | undefined },
        }
      }

      const docPath = config.getPath(project)

      // Case 1: no file, oldString is empty → create new file
      if (!docPath && params.oldString === "") {
        const filepath = path.join(Instance.directory, config.fileName)

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

        config.updatePath(researchProjectId, filepath)

        return {
          title: `Created ${config.fileName}`,
          output: `${label} file created successfully.`,
          metadata: { filepath },
        }
      }

      // Case 2: no file, oldString is not empty → error
      if (!docPath && params.oldString !== "") {
        return {
          title: "Failed",
          output: `No ${label} file exists yet. Use oldString='' to create one first.`,
          metadata: { filepath: undefined as string | undefined },
        }
      }

      // Case 3: file exists → edit it
      const filepath = docPath!

      if (!(await Filesystem.exists(filepath))) {
        return {
          title: "Failed",
          output: `${label} file not found on disk: ${filepath}`,
          metadata: { filepath: undefined as string | undefined },
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

      return {
        title: path.relative(Instance.worktree, filepath),
        output: `${label} file edited successfully.`,
        metadata: { filepath },
      }
    },
  })
}

export const ResearchBackgroundTool = defineResearchDocTool(
  "research_background_edit",
  "Edit or create the background document of the current research project. " +
    "Use oldString='' to create a new background file. " +
    "Use oldString with content to edit existing background.",
  {
    field: "background",
    fileName: "background.md",
    getPath: (project) => project.background_path,
    updatePath: Research.updateBackgroundPath,
  },
)

export const ResearchGoalTool = defineResearchDocTool(
  "research_goal_edit",
  "Edit or create the goal document of the current research project. " +
    "Use oldString='' to create a new goal file. " +
    "Use oldString with content to edit existing goal.",
  {
    field: "goal",
    fileName: "goal.md",
    getPath: (project) => project.goal_path,
    updatePath: Research.updateGoalPath,
  },
)

export const ResearchMacroTool = defineResearchDocTool(
  "research_macro_edit",
  "Edit or create the macro table document of the current research project. " +
    "Use oldString='' to create a new macro table file. " +
    "Use oldString with content to edit existing macro table.",
  {
    field: "macro_table",
    fileName: "macro_table.md",
    getPath: (project) => project.macro_table_path,
    updatePath: Research.updateMacroTablePath,
  },
)
