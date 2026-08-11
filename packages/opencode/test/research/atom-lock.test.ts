import path from "path"

import { describe, expect, test } from "bun:test"

import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { AtomTable, ResearchProjectTable } from "../../src/research/research.sql"
import { ResearchRoutes } from "../../src/server/routes/research"
import { Session } from "../../src/session"
import { Database, eq } from "../../src/storage/db"
import { AtomDeleteTool, AtomStatusUpdateTool } from "../../src/tool/atom"
import { WriteTool } from "../../src/tool/write"
import { tmpdir } from "../fixture/fixture"

const context = (sessionID: string) => ({
  sessionID,
  messageID: "test-message",
  callID: "test-call",
  agent: "research",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
})

async function seed(dir: string) {
  const research = crypto.randomUUID()
  const atom = crypto.randomUUID()
  const root = path.join(dir, "atom_list", atom)
  const claim = path.join(root, "claim.md")
  const evidence = path.join(root, "evidence.md")
  const assessment = path.join(root, "evidence_assessment.md")
  await Bun.write(claim, "# Claim\nOriginal")
  await Bun.write(evidence, "# Evidence\nOriginal")
  await Bun.write(assessment, "# Evidence Assessment\nOriginal")
  const now = Date.now()
  Database.use((db) => {
    db.insert(ResearchProjectTable)
      .values({
        research_project_id: research,
        project_id: Instance.project.id,
        time_created: now,
        time_updated: now,
      })
      .run()
    db.insert(AtomTable)
      .values({
        atom_id: atom,
        research_project_id: research,
        atom_name: "Lock test",
        atom_type: "fact",
        atom_claim_path: claim,
        atom_evidence_type: "math",
        atom_evidence_status: "pending",
        atom_evidence_path: evidence,
        atom_evidence_assessment_path: assessment,
        time_created: now,
        time_updated: now,
      })
      .run()
  })
  return { research, atom, claim }
}

describe("research.atom-lock", () => {
  test("human lock blocks agent mutations until unlocked", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed(tmp.path)
        const session = await Session.create({ title: "research" })
        const lock = await ResearchRoutes.request(`/project/${item.research}/atom/${item.atom}/lock`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ locked: true }),
        })
        expect(lock.status).toBe(200)
        expect((await lock.json()).locked).toBe(true)

        const status = await AtomStatusUpdateTool.init()
        await expect(
          status.execute({ atomId: item.atom, evidenceStatus: "proven" }, context(session.id)),
        ).rejects.toThrow("Atom is locked")
        expect(
          Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, item.atom)).get())
            ?.atom_evidence_status,
        ).toBe("pending")

        await expect(File.write(path.relative(tmp.path, item.claim), "# Claim\nChanged")).rejects.toThrow(
          "Atom is locked",
        )
        const write = await WriteTool.init()
        await expect(
          write.execute({ filePath: item.claim, content: "# Claim\nChanged" }, context(session.id)),
        ).rejects.toThrow("Atom is locked")
        expect(await Bun.file(item.claim).text()).toBe("# Claim\nOriginal")

        const deleted = await ResearchRoutes.request(`/project/${item.research}/atom/${item.atom}`, {
          method: "DELETE",
        })
        expect(deleted.status).toBe(400)
        const remove = await AtomDeleteTool.init()
        await expect(remove.execute({ atomIds: [item.atom] }, context(session.id))).rejects.toThrow("Atom is locked")
        expect(Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, item.atom)).get())).toBeDefined()

        const unlock = await ResearchRoutes.request(`/project/${item.research}/atom/${item.atom}/lock`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ locked: false }),
        })
        expect(unlock.status).toBe(200)
        expect((await unlock.json()).locked).toBe(false)

        await File.write(path.relative(tmp.path, item.claim), "# Claim\nChanged")
        await status.execute({ atomId: item.atom, evidenceStatus: "proven" }, context(session.id))
        expect(await Bun.file(item.claim).text()).toBe("# Claim\nChanged")
        expect(
          Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, item.atom)).get())
            ?.atom_evidence_status,
        ).toBe("proven")
      },
    })
  })
})
