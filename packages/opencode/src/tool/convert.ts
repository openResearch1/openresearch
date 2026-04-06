import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./convert.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { Filesystem } from "../util/filesystem"

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".doc",
  ".xlsx",
  ".xls",
  ".pptx",
  ".ppt",
  ".odt",
  ".ods",
  ".odp",
  ".html",
  ".htm",
  ".csv",
  ".tsv",
  ".rtf",
  ".epub",
  ".xml",
  ".rss",
  ".atom",
])

export const ConvertTool = Tool.define("convert", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the document file to convert"),
  }),
  async execute(params, ctx) {
    let filepath = params.filePath
    if (!path.isAbsolute(filepath)) {
      filepath = path.resolve(Instance.directory, filepath)
    }
    const title = path.relative(Instance.worktree, filepath)

    const stat = Filesystem.stat(filepath)

    await assertExternalDirectory(ctx, filepath, {
      bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
      kind: "file",
    })

    await ctx.ask({
      permission: "read",
      patterns: [filepath],
      always: ["*"],
      metadata: {},
    })

    if (!stat) {
      throw new Error(`File not found: ${filepath}`)
    }

    if (stat.isDirectory()) {
      throw new Error(`Cannot convert a directory: ${filepath}`)
    }

    const ext = path.extname(filepath).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new Error(
        `Unsupported file format: ${ext}. Supported formats: ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
      )
    }

    const { MarkItDown } = await import("markitdown-ts")
    const converter = new MarkItDown()
    const result = await converter.convert(filepath)

    if (!result || !result.markdown) {
      throw new Error(`Failed to convert file: ${filepath}`)
    }

    const markdown = result.markdown
    const output = [
      `<path>${filepath}</path>`,
      `<type>document</type>`,
      `<title>${result.title ?? path.basename(filepath)}</title>`,
      `<content>`,
      markdown,
      `</content>`,
    ].join("\n")

    return {
      title,
      output,
      metadata: {
        preview: markdown.slice(0, 500),
        truncated: false,
      },
    }
  },
})
