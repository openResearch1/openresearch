import { afterEach, beforeEach, expect, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { ArticleTable, AtomTable, ResearchProjectTable } from "../../src/research/research.sql"
import { Session } from "../../src/session"
import { Database } from "../../src/storage/db"
import type { Tool } from "../../src/tool/tool"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

beforeEach(async () => resetDatabase())
afterEach(async () => resetDatabase())

test("atom creation normalizes blank article IDs", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "atoms" })
      Database.use((db) =>
        db
          .insert(ResearchProjectTable)
          .values({ research_project_id: "research-1", project_id: Instance.project.id })
          .run(),
      )
      Database.use((db) =>
        db
          .insert(ArticleTable)
          .values({ article_id: "article-1", research_project_id: "research-1", path: "/tmp/article.pdf" })
          .run(),
      )

      const ctx = {
        sessionID: session.id,
        messageID: "message-1",
        callID: "call-1",
        agent: "research",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => {},
        ask: async () => {},
      } satisfies Tool.Context
      const create = await import("../../src/tool/atom").then((mod) => mod.AtomCreateTool.init())
      const batch = await import("../../src/tool/atom").then((mod) => mod.AtomBatchCreateTool.init())
      const input = {
        type: "fact" as const,
        evidenceType: "math" as const,
        claim: "### Claim\nA test claim.",
        evidence: "### Evidence\nA test source.",
      }

      const blank = await create.execute({ ...input, name: "blank", articleId: "" }, ctx)
      expect(blank.output).toContain("Source: user created")

      await batch.execute(
        {
          atoms: [{ ...input, name: "whitespace", articleId: "   " }],
        },
        ctx,
      )
      await create.execute({ ...input, name: "article", articleId: " article-1 " }, ctx)

      expect(
        Database.use((db) => db.select({ name: AtomTable.atom_name, article: AtomTable.article_id }).from(AtomTable).all()),
      ).toEqual(
        expect.arrayContaining([
          { name: "blank", article: null },
          { name: "whitespace", article: null },
          { name: "article", article: "article-1" },
        ]),
      )

      await expect(
        create.execute({ ...input, name: "missing", articleId: "article-missing" }, ctx),
      ).rejects.toThrow("FOREIGN KEY constraint failed")
    },
  })
})
