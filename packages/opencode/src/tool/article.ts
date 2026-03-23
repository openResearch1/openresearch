import z from "zod"
import { Tool } from "./tool"
import { Database, eq } from "../storage/db"
import { ArticleTable } from "../research/research.sql"
import { Research } from "../research/research"
import { Filesystem } from "../util/filesystem"
import { extractText } from "unpdf"

type ArticleRow = typeof ArticleTable.$inferSelect

function formatArticle(row: ArticleRow): string {
  return [
    `article_id: ${row.article_id}`,
    row.title ? `title: ${row.title}` : null,
    `path: ${row.path}`,
    row.code_path ? `code_path: ${row.code_path}` : null,
    row.source_url ? `source_url: ${row.source_url}` : null,
  ]
    .filter(Boolean)
    .join("\n")
}

export const ArticleReadTool = Tool.define("article_read", {
  description:
    "List or read research articles (papers/PDFs) in the current research project. " +
    "IMPORTANT: Always use this tool — not glob, ls, read, or other generic tools — when listing, querying, or reading articles/papers in a research project. " +
    "It is the ONLY tool that can query the research project article database. " +
    "When called without an articleId, lists all articles with their metadata (id, title, path, etc.). " +
    "When called with an articleId, retrieves the PDF. " +
    "If your model can read PDFs directly (e.g., Claude 3.5+, GPT-4+), set useBase64 to true to get the raw PDF as base64 instead of extracted text for better analysis.",
  parameters: z.object({
    articleId: z.string().optional().describe("The article ID to read. If omitted, lists all articles in the project."),
    useBase64: z
      .boolean()
      .optional()
      .describe(
        "Whether to return the PDF as base64 format. Set to true if your model supports PDF reading (e.g., Claude 3.5+, GPT-4+).",
      ),
  }),
  async execute(params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "Failed",
        output: "Current session is not associated with any research project.",
        metadata: { count: 0 },
      }
    }

    // List mode
    if (!params.articleId) {
      const articles = Database.use((db) =>
        db.select().from(ArticleTable).where(eq(ArticleTable.research_project_id, researchProjectId)).all(),
      )
      if (articles.length === 0) {
        return {
          title: "No articles",
          output: "No articles found in this research project.",
          metadata: { count: 0 },
        }
      }
      const output = articles.map((a, i) => `--- Article ${i + 1} ---\n${formatArticle(a)}`).join("\n\n")
      return {
        title: `${articles.length} article(s)`,
        output,
        metadata: { count: articles.length },
      }
    }

    // Read mode
    const article = Database.use((db) =>
      db.select().from(ArticleTable).where(eq(ArticleTable.article_id, params.articleId!)).get(),
    )
    if (!article) {
      return {
        title: "Not found",
        output: `Article not found: ${params.articleId}`,
        metadata: { count: 0 },
      }
    }

    if (!(await Filesystem.exists(article.path))) {
      return {
        title: "File missing",
        output: `Article file not found on disk: ${article.path}`,
        metadata: { count: 0 },
      }
    }

    const bytes = await Filesystem.readBytes(article.path)

    // If useBase64 is true, return the PDF as base64 format
    if (params.useBase64) {
      const base64Data = bytes.toString("base64")
      return {
        title: article.title ?? article.article_id,
        output: `Article read successfully as base64`,
        metadata: { count: 1 },
        attachments: [
          {
            type: "file",
            mime: "application/pdf",
            url: `data:application/pdf;base64,${base64Data}`,
          },
        ],
      }
    }

    // Default behavior: extract text from PDF
    const { totalPages, text } = await extractText(new Uint8Array(bytes), { mergePages: true })

    return {
      title: article.title ?? article.article_id,
      output: [formatArticle(article), `total_pages: ${totalPages}`, "", "--- Content ---", text].join("\n"),
      metadata: { count: 1 },
    }
  },
})
