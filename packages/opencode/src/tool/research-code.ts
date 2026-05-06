import fs from "node:fs/promises"
import path from "node:path"

import z from "zod"

import { Instance } from "@/project/instance"
import { ArticleTable, CodeTable } from "@/research/research.sql"
import { Research } from "@/research/research"
import { Database, eq } from "@/storage/db"
import { Filesystem } from "@/util/filesystem"
import { Glob } from "@/util/glob"

import { Tool } from "./tool"

const deps = [
  "requirements.txt",
  "requirements/*.txt",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "environment.yml",
  "environment.yaml",
  "conda.yml",
  "conda.yaml",
]

function envKey(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "code"
  )
}

async function dirs(root: string) {
  return fs
    .readdir(root, { withFileTypes: true })
    .then((items) => items.filter((item) => item.isDirectory()).map((item) => item.name))
    .catch(() => [] as string[])
}

async function inspect(dir: string) {
  const files = await Glob.scan(`{${deps.join(",")}}`, { cwd: dir, absolute: false, include: "file" }).catch(
    () => [] as string[],
  )
  return {
    exists: !!Filesystem.stat(dir)?.isDirectory(),
    is_git_repo: !!Filesystem.stat(path.join(dir, ".git")),
    detected_files: files.sort((a, b) => a.localeCompare(b)),
  }
}

export const ResearchCodeQueryTool = Tool.define("research_code_query", {
  description:
    "Query code directories available in the current research project. Use this to choose a codePath before project-level environment setup or experiment creation.",
  parameters: z.object({
    codeId: z.string().optional().describe("Specific code record ID to query."),
    codeName: z.string().optional().describe("Specific code directory/name to query."),
  }),
  async execute(params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "No project",
        output: "Current session is not associated with any research project.",
        metadata: { count: 0, rows: [] },
      }
    }

    const rows = Database.use((db) =>
      db.select().from(CodeTable).where(eq(CodeTable.research_project_id, researchProjectId)).all(),
    )
    const byName = new Map(rows.map((row) => [row.code_name, row]))
    const names = new Set([...(await dirs(path.join(Instance.directory, "code"))), ...rows.map((row) => row.code_name)])
    const articles = new Map(
      Database.use((db) =>
        db.select().from(ArticleTable).where(eq(ArticleTable.research_project_id, researchProjectId)).all(),
      ).map((row) => [row.article_id, row]),
    )

    let result = await Promise.all(
      [...names]
        .sort((a, b) => a.localeCompare(b))
        .map(async (name) => {
          const row = byName.get(name)
          const codePath = path.join(Instance.directory, "code", name)
          const info = await inspect(codePath)
          return {
            code_id: row?.code_id ?? null,
            code_name: name,
            code_path: codePath,
            article_id: row?.article_id ?? null,
            article_title: row?.article_id ? (articles.get(row.article_id)?.title ?? null) : null,
            registered: !!row,
            suggested_env_key: envKey(name),
            ...info,
          }
        }),
    )

    if (params.codeId) result = result.filter((row) => row.code_id === params.codeId)
    if (params.codeName) result = result.filter((row) => row.code_name === params.codeName)

    if (!result.length) {
      return {
        title: "No code",
        output: "No matching code directories found in this research project.",
        metadata: { count: 0, rows: [] },
      }
    }

    return {
      title: `${result.length} code path(s)`,
      output: result
        .map((row, idx) =>
          [
            `--- Code ${idx + 1} ---`,
            row.code_id ? `code_id: ${row.code_id}` : null,
            `code_name: ${row.code_name}`,
            `code_path: ${row.code_path}`,
            `registered: ${row.registered}`,
            `exists: ${row.exists}`,
            `is_git_repo: ${row.is_git_repo}`,
            row.article_id ? `article_id: ${row.article_id}` : null,
            row.article_title ? `article_title: ${row.article_title}` : null,
            `suggested_env_key: ${row.suggested_env_key}`,
            row.detected_files.length ? `detected_files: ${row.detected_files.join(", ")}` : `detected_files: (none)`,
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n"),
      metadata: { count: result.length, rows: result },
    }
  },
})
