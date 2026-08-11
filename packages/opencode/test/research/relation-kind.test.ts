import { describe, expect, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { AtomRelationTable, AtomTable, linkKind, ResearchProjectTable } from "../../src/research/research.sql"
import { ResearchRoutes } from "../../src/server/routes/research"
import { Database } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

describe("research.relation-kind", () => {
  test("normalizes legacy API inputs to canonical relation names", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = crypto.randomUUID()
        const source = crypto.randomUUID()
        const target = crypto.randomUUID()
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
            .values([
              {
                atom_id: source,
                research_project_id: research,
                atom_name: "Method",
                atom_type: "method",
                atom_evidence_type: "math",
                time_created: now,
                time_updated: now,
              },
              {
                atom_id: target,
                research_project_id: research,
                atom_name: "Evaluation",
                atom_type: "verification",
                atom_evidence_type: "experiment",
                time_created: now,
                time_updated: now,
              },
            ])
            .run()
        })

        const create = await ResearchRoutes.request(`/project/${research}/relation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source_atom_id: source, target_atom_id: target, relation_type: "validates" }),
        })
        expect(create.status).toBe(200)
        expect(await create.json()).toMatchObject({ relation_type: "evaluated_by" })
        expect(Database.use((db) => db.select().from(AtomRelationTable).get())?.relation_type).toBe("evaluated_by")

        const remove = await ResearchRoutes.request(`/project/${research}/relation`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source_atom_id: source, target_atom_id: target, relation_type: "validates" }),
        })
        expect(remove.status).toBe(200)
        expect(await remove.json()).toMatchObject({ relation_type: "evaluated_by", deleted: true })
        expect(Database.use((db) => db.select().from(AtomRelationTable).get())).toBeUndefined()

        expect(linkKind("formalizes")).toBe("formalized_by")
        expect(linkKind("analyzes")).toBe("analyzed_by")
        expect(linkKind("validates")).toBe("evaluated_by")
        expect(linkKind("unknown")).toBeUndefined()
      },
    })
  })
})
