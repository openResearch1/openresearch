import fs from "fs/promises"
import path from "path"
import { expect, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { repairContainerArticles } from "../../src/research/article-repair"
import { ArticleTable, AtomRelationTable, AtomTable, ResearchProjectTable } from "../../src/research/research.sql"
import { Database, eq } from "../../src/storage/db"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

function research(projectId: string) {
  const id = crypto.randomUUID()
  const now = Date.now()
  Database.use((db) => {
    db.insert(ResearchProjectTable)
      .values({ research_project_id: id, project_id: projectId, time_created: now, time_updated: now })
      .run()
  })
  return id
}

test("repairContainerArticles should split container article assignments by paper source", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "articles", "papers")
      const atoms = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })
      await fs.mkdir(atoms, { recursive: true })

      const files = [
        "Bai 等 - 2025 - AutoSchemaKG Autonomous Knowledge Graph Construction through Dynamic Schema Induction from Web-Scale.pdf",
        "Charakorn 等 - 2025 - Text-to-LoRA Instant Transformer Adaption.pdf",
        "Charakorn 等 - 2026 - Doc-to-LoRA Learning to Instantly Internalize Contexts.pdf",
      ]

      await Promise.all(files.map((file) => Filesystem.write(path.join(dir, file), "pdf")))

      const rpId = research(Instance.project.id)
      const articleId = crypto.randomUUID()
      const now = Date.now()

      Database.use((db) => {
        db.insert(ArticleTable)
          .values({
            article_id: articleId,
            research_project_id: rpId,
            path: dir,
            status: "parsed",
            time_created: now,
            time_updated: now,
          })
          .run()

        db.insert(AtomTable)
          .values([
            {
              atom_id: "auto-1",
              research_project_id: rpId,
              article_id: articleId,
              atom_name: "AutoSchemaKG removes predefined schemas",
              atom_type: "method",
              atom_evidence_type: "math",
              atom_claim_path: path.join(atoms, "auto-1", "claim.md"),
              atom_evidence_path: path.join(atoms, "auto-1", "evidence.md"),
              atom_evidence_assessment_path: path.join(atoms, "auto-1", "evidence_assessment.md"),
              time_created: now,
              time_updated: now,
            },
            {
              atom_id: "auto-2",
              research_project_id: rpId,
              article_id: articleId,
              atom_name: "ATLAS reaches billion-scale graph size",
              atom_type: "verification",
              atom_evidence_type: "experiment",
              atom_claim_path: path.join(atoms, "auto-2", "claim.md"),
              atom_evidence_path: path.join(atoms, "auto-2", "evidence.md"),
              atom_evidence_assessment_path: path.join(atoms, "auto-2", "evidence_assessment.md"),
              time_created: now,
              time_updated: now,
            },
            {
              atom_id: "t2l-1",
              research_project_id: rpId,
              article_id: articleId,
              atom_name: "T2L generates LoRAs from task descriptions",
              atom_type: "method",
              atom_evidence_type: "math",
              atom_claim_path: path.join(atoms, "t2l-1", "claim.md"),
              atom_evidence_path: path.join(atoms, "t2l-1", "evidence.md"),
              atom_evidence_assessment_path: path.join(atoms, "t2l-1", "evidence_assessment.md"),
              time_created: now,
              time_updated: now,
            },
            {
              atom_id: "t2l-2",
              research_project_id: rpId,
              article_id: articleId,
              atom_name: "SFT-trained T2L improves zero-shot adaptation",
              atom_type: "verification",
              atom_evidence_type: "experiment",
              atom_claim_path: path.join(atoms, "t2l-2", "claim.md"),
              atom_evidence_path: path.join(atoms, "t2l-2", "evidence.md"),
              atom_evidence_assessment_path: path.join(atoms, "t2l-2", "evidence_assessment.md"),
              time_created: now,
              time_updated: now,
            },
            {
              atom_id: "d2l-1",
              research_project_id: rpId,
              article_id: articleId,
              atom_name: "D2L meta-learns one-pass context distillation",
              atom_type: "method",
              atom_evidence_type: "math",
              atom_claim_path: path.join(atoms, "d2l-1", "claim.md"),
              atom_evidence_path: path.join(atoms, "d2l-1", "evidence.md"),
              atom_evidence_assessment_path: path.join(atoms, "d2l-1", "evidence_assessment.md"),
              time_created: now,
              time_updated: now,
            },
            {
              atom_id: "d2l-2",
              research_project_id: rpId,
              article_id: articleId,
              atom_name: "D2L generalizes to much longer contexts on NIAH",
              atom_type: "verification",
              atom_evidence_type: "experiment",
              atom_claim_path: path.join(atoms, "d2l-2", "claim.md"),
              atom_evidence_path: path.join(atoms, "d2l-2", "evidence.md"),
              atom_evidence_assessment_path: path.join(atoms, "d2l-2", "evidence_assessment.md"),
              time_created: now,
              time_updated: now,
            },
          ])
          .run()

        db.insert(AtomRelationTable)
          .values([
            { atom_id_source: "auto-1", atom_id_target: "auto-2", relation_type: "validates" },
            { atom_id_source: "t2l-1", atom_id_target: "t2l-2", relation_type: "validates" },
            { atom_id_source: "d2l-1", atom_id_target: "d2l-2", relation_type: "validates" },
          ])
          .run()
      })

      await Promise.all([
        Filesystem.write(path.join(atoms, "auto-1", "claim.md"), "AutoSchemaKG eliminates predefined schemas."),
        Filesystem.write(path.join(atoms, "auto-1", "evidence.md"), "AutoSchemaKG builds ATLAS."),
        Filesystem.write(path.join(atoms, "auto-1", "evidence_assessment.md"), "ok"),
        Filesystem.write(path.join(atoms, "auto-2", "claim.md"), "AutoSchemaKG reports that ATLAS reaches billion-scale graph size."),
        Filesystem.write(path.join(atoms, "auto-2", "evidence.md"), "AutoSchemaKG reports ATLAS scale."),
        Filesystem.write(path.join(atoms, "auto-2", "evidence_assessment.md"), "ok"),
        Filesystem.write(path.join(atoms, "t2l-1", "claim.md"), "Text-to-LoRA (T2L) generates LoRAs from task descriptions."),
        Filesystem.write(path.join(atoms, "t2l-1", "evidence.md"), "T2L is a hypernetwork."),
        Filesystem.write(path.join(atoms, "t2l-1", "evidence_assessment.md"), "ok"),
        Filesystem.write(path.join(atoms, "t2l-2", "claim.md"), "Text-to-LoRA (T2L) improves zero-shot adaptation."),
        Filesystem.write(path.join(atoms, "t2l-2", "evidence.md"), "Text-to-LoRA zero-shot results."),
        Filesystem.write(path.join(atoms, "t2l-2", "evidence_assessment.md"), "ok"),
        Filesystem.write(path.join(atoms, "d2l-1", "claim.md"), "Doc-to-LoRA (D2L) meta-learns one-pass context distillation."),
        Filesystem.write(path.join(atoms, "d2l-1", "evidence.md"), "D2L maps context to LoRA adapters."),
        Filesystem.write(path.join(atoms, "d2l-1", "evidence_assessment.md"), "ok"),
        Filesystem.write(path.join(atoms, "d2l-2", "claim.md"), "Doc-to-LoRA (D2L) generalizes to much longer contexts on NIAH."),
        Filesystem.write(path.join(atoms, "d2l-2", "evidence.md"), "Doc-to-LoRA outperforms standard context distillation."),
        Filesystem.write(path.join(atoms, "d2l-2", "evidence_assessment.md"), "ok"),
      ])

      const report = await repairContainerArticles(rpId)

      expect(report).toHaveLength(1)
      expect(report[0].assigned).toHaveLength(3)

      const arts = Database.use((db) =>
        db.select().from(ArticleTable).where(eq(ArticleTable.research_project_id, rpId)).all(),
      )
      expect(arts).toHaveLength(4)

      const filePaths = arts.filter((item) => item.path !== dir).map((item) => item.path).sort()
      expect(filePaths).toEqual(files.map((file) => path.join(dir, file)).sort())

      const rows = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.research_project_id, rpId)).all())
      const next = new Map(arts.map((item) => [item.article_id, item.path]))

      expect(rows.filter((row) => row.article_id === articleId)).toHaveLength(0)
      expect(next.get(rows.find((row) => row.atom_id === "auto-1")!.article_id!)).toContain("AutoSchemaKG")
      expect(next.get(rows.find((row) => row.atom_id === "t2l-1")!.article_id!)).toContain("Text-to-LoRA")
      expect(next.get(rows.find((row) => row.atom_id === "d2l-1")!.article_id!)).toContain("Doc-to-LoRA")
    },
  })
})
