import z from "zod"
import * as path from "path"
import * as fs from "fs"
import { Tool } from "./tool"
import DESCRIPTION from "./convert.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { Filesystem } from "../util/filesystem"

const SUPPORTED_EXTENSIONS = new Set([".pdf"])

export const ConvertTool = Tool.define("convert", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the PDF file to convert"),
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
      throw new Error(`Unsupported file format: ${ext}. Supported formats: ${[...SUPPORTED_EXTENSIONS].join(", ")}`)
    }

    // pdfjs-dist expects these from @napi-rs/canvas which isn't available
    // in compiled binaries. Stub them — only needed for rendering, not text extraction.
    const g = globalThis as any
    if (typeof g.DOMMatrix === "undefined") {
      g.DOMMatrix = class DOMMatrix {
        a = 1
        b = 0
        c = 0
        d = 1
        e = 0
        f = 0
        constructor(_init?: any) {}
        static fromMatrix() {
          return new g.DOMMatrix()
        }
        inverse() {
          return new g.DOMMatrix()
        }
        multiply() {
          return new g.DOMMatrix()
        }
        translate() {
          return new g.DOMMatrix()
        }
        scale() {
          return new g.DOMMatrix()
        }
        transformPoint() {
          return { x: 0, y: 0, z: 0, w: 1 }
        }
      }
    }
    if (typeof g.ImageData === "undefined") {
      g.ImageData = class ImageData {
        data: Uint8ClampedArray
        width: number
        height: number
        constructor(sw: number, sh?: number) {
          this.width = sw
          this.height = sh ?? 0
          this.data = new Uint8ClampedArray(this.width * this.height * 4)
        }
      }
    }
    if (typeof g.Path2D === "undefined") {
      g.Path2D = class Path2D {
        constructor(_path?: any) {}
        addPath() {}
        closePath() {}
        moveTo() {}
        lineTo() {}
        bezierCurveTo() {}
        quadraticCurveTo() {}
        arc() {}
        arcTo() {}
        ellipse() {}
        rect() {}
      }
    }

    const { PDFParse } = await import("pdf-parse")
    const data = fs.readFileSync(filepath)
    const parser = new PDFParse({ data })
    const result = await parser.getText()
    await parser.destroy()

    const markdown = result.text
    if (!markdown) {
      throw new Error(`Failed to convert file: ${filepath}`)
    }

    const output = [
      `<path>${filepath}</path>`,
      `<type>document</type>`,
      `<title>${path.basename(filepath)}</title>`,
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
