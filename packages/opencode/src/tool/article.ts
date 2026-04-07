import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Database, eq } from "../storage/db"
import { ArticleTable, CodeTable } from "../research/research.sql"
import { Research } from "../research/research"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"

type ArticleRow = typeof ArticleTable.$inferSelect
const statuses = ["pending", "parsed", "failed"] as const

function getCodePaths(articleId: string): string[] {
  const codes = Database.use((db) => db.select().from(CodeTable).where(eq(CodeTable.article_id, articleId)).all())
  return codes.map((c) => path.join(Instance.directory, "code", c.code_name))
}

function formatArticle(row: ArticleRow): string {
  const kind = Filesystem.stat(row.path)?.isDirectory() ? "latex_directory" : "pdf"
  const codePaths = getCodePaths(row.article_id)
  return [
    `article_id: ${row.article_id}`,
    row.title ? `title: ${row.title}` : null,
    `status: ${row.status}`,
    `kind: ${kind}`,
    `path: ${row.path}`,
    codePaths.length > 0 ? `code_paths: ${codePaths.join(", ")}` : null,
    row.source_url ? `source_url: ${row.source_url}` : null,
  ]
    .filter(Boolean)
    .join("\n")
}

export const ArticleQueryTool = Tool.define("article_query", {
  description:
    "Query research articles (PDFs or LaTeX source folders) in the current research project. " +
    "IMPORTANT: Always use this tool — not glob, ls, read, or other generic tools — when listing or querying articles/papers in a research project. " +
    "It is the ONLY tool that can query the research project article database. " +
    "When called without an articleId, lists all articles with their metadata (id, title, path, status, etc.). " +
    "When called with an articleId, returns the article metadata including its file path. " +
    "To read the actual article content, use the returned path with the read tool.",
  parameters: z.object({
    articleId: z
      .string()
      .optional()
      .describe("The article ID to query. If omitted, lists all articles in the project."),
    articleIds: z
      .array(z.string())
      .optional()
      .describe("Optional list of article IDs to filter by. Use this when you need a specific subset."),
    status: z
      .enum(statuses)
      .optional()
      .describe("Optional article status filter: pending, parsed, or failed."),
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
      let articles = Database.use((db) =>
        db.select().from(ArticleTable).where(eq(ArticleTable.research_project_id, researchProjectId)).all(),
      )
      if (params.articleIds?.length) {
        const set = new Set(params.articleIds)
        articles = articles.filter((article) => set.has(article.article_id))
      }
      if (params.status) {
        articles = articles.filter((article) => article.status === params.status)
      }
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

export const ArticleStatusUpdateTool = Tool.define("article_status_update", {
  description:
    "Update the parse status of one or more articles in the current research project. " +
    "Use this after article-local parsing succeeds or fails.",
  parameters: z.object({
    articleIds: z.array(z.string()).min(1).describe("The article IDs to update."),
    status: z.enum(statuses).describe("The new article status."),
  }),
  async execute(params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "Failed",
        output: "Current session is not associated with any research project.",
        metadata: { updated: false, count: 0 },
      }
    }

    const items = Database.use((db) =>
      db.select().from(ArticleTable).where(eq(ArticleTable.research_project_id, researchProjectId)).all(),
    ).filter((article) => params.articleIds.includes(article.article_id))

    if (!items.length) {
      return {
        title: "Failed",
        output: "No matching articles found in the current research project.",
        metadata: { updated: false, count: 0 },
      }
    }

    const now = Date.now()
    Database.use((db) => {
      for (const article of items) {
        db
          .update(ArticleTable)
          .set({ status: params.status, time_updated: now })
          .where(eq(ArticleTable.article_id, article.article_id))
          .run()
      }
    })

    return {
      title: `Updated ${items.length} article(s)`,
      output: items.map((article) => `[${article.article_id}] ${article.title ?? "(untitled)"} -> ${params.status}`).join("\n"),
      metadata: { updated: true, count: items.length },
    }
  },
})
