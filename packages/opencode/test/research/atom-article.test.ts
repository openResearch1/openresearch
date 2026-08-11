import path from "path"

import { afterEach, beforeEach, expect, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { ProjectTable } from "../../src/project/project.sql"
import { ArticleTable, AtomTable, ResearchProjectTable } from "../../src/research/research.sql"
import { ResearchRoutes } from "../../src/server/routes/research"
import { Database, eq } from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

beforeEach(async () => resetDatabase())
afterEach(async () => resetDatabase())

test("human can update an atom article", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const now = Date.now()
      Database.use((db) => {
        db.insert(ProjectTable)
          .values({ id: "project-2", worktree: path.join(tmp.path, "other"), sandboxes: [] })
          .run()
        db.insert(ResearchProjectTable)
          .values({ research_project_id: "research-1", project_id: Instance.project.id })
          .run()
        db.insert(ResearchProjectTable).values({ research_project_id: "research-2", project_id: "project-2" }).run()
        db.insert(ArticleTable)
          .values([
            { article_id: "article-1", research_project_id: "research-1", path: "/tmp/one.pdf" },
            { article_id: "article-2", research_project_id: "research-1", path: "/tmp/two.pdf" },
            { article_id: "article-other", research_project_id: "research-2", path: "/tmp/other.pdf" },
          ])
          .run()
        db.insert(AtomTable)
          .values({
            atom_id: "atom-1",
            research_project_id: "research-1",
            atom_name: "Editable provenance",
            atom_type: "fact",
            atom_evidence_type: "math",
            atom_evidence_status: "pending",
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      const update = (article_id: string | null) =>
        ResearchRoutes.request("/research/research-1/atom/atom-1", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ article_id }),
        })
      const article = () =>
        Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, "atom-1")).get())?.article_id

      expect((await update("article-1")).status).toBe(200)
      expect(article()).toBe("article-1")
      expect((await update(" article-2 ")).status).toBe(200)
      expect(article()).toBe("article-2")
      expect((await update(null)).status).toBe(200)
      expect(article()).toBeNull()

      expect((await update("article-other")).status).toBe(400)
      expect((await update("article-missing")).status).toBe(400)
      expect(article()).toBeNull()

      const lock = await ResearchRoutes.request("/project/research-1/atom/atom-1/lock", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locked: true }),
      })
      expect(lock.status).toBe(200)
      expect((await update("article-1")).status).toBe(400)
      expect(article()).toBeNull()
    },
  })
})
