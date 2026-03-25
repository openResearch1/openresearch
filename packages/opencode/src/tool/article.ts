import z from "zod"
import { Tool } from "./tool"
import { Database, eq } from "../storage/db"
import { ArticleTable } from "../research/research.sql"
import { Research } from "../research/research"

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

export const ArticleQueryTool = Tool.define("article_query", {
  description:
    "Query research articles (papers/PDFs) in the current research project. " +
    "IMPORTANT: Always use this tool — not glob, ls, read, or other generic tools — when listing or querying articles/papers in a research project. " +
    "It is the ONLY tool that can query the research project article database. " +
    "When called without an articleId, lists all articles with their metadata (id, title, path, etc.). " +
    "When called with an articleId, returns the article metadata including its file path. " +
    "To read the actual PDF content, use the returned path with the appropriate file reading tool.",
  parameters: z.object({
    articleId: z
      .string()
      .optional()
      .describe("The article ID to query. If omitted, lists all articles in the project."),
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

    // Query mode
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

    return {
      title: article.title ?? article.article_id,
      output: formatArticle(article),
      metadata: { count: 1 },
    }
  },
})
