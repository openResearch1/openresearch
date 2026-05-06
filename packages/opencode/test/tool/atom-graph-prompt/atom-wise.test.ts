import fs from "fs/promises"
import path from "path"
import { expect, test } from "bun:test"

import { Instance } from "../../../src/project/instance"
import { ResearchProjectTable, AtomRelationTable, AtomTable } from "../../../src/research/research.sql"
import { Database } from "../../../src/storage/db"
import { applyAtomQuality, scoreAtomQuality } from "../../../src/tool/atom-graph-prompt/atom-quality"
import { rerankAtoms } from "../../../src/tool/atom-graph-prompt/atom-rerank"
import { hybridSearch } from "../../../src/tool/atom-graph-prompt/hybrid"
import { scoreAndRankAtoms } from "../../../src/tool/atom-graph-prompt/scoring"
import { traverseAtomGraph } from "../../../src/tool/atom-graph-prompt/traversal"
import { Filesystem } from "../../../src/util/filesystem"
import { tmpdir } from "../../fixture/fixture"

function research(projectId: string) {
  const id = crypto.randomUUID()
  const now = Date.now()
  Database.use((db) => {
    db.insert(ResearchProjectTable)
      .values({
        research_project_id: id,
        project_id: projectId,
        time_created: now,
        time_updated: now,
      })
      .run()
  })
  return id
}

type Seed = {
  id: string
  name: string
  type: "fact" | "method" | "theorem" | "verification"
  claim: string
}

async function graph(
  rpId: string,
  dir: string,
  atoms: Seed[],
  rels: Array<{
    source: string
    target: string
    type: "motivates" | "formalizes" | "derives" | "analyzes" | "validates" | "contradicts" | "other"
  }>,
) {
  const now = Date.now()
  Database.use((db) => {
    db.insert(AtomTable)
      .values(
        atoms.map((atom) => ({
          atom_id: atom.id,
          research_project_id: rpId,
          atom_name: atom.name,
          atom_type: atom.type,
          atom_evidence_type: "math" as const,
          atom_claim_path: path.join(dir, `${atom.id}-claim.txt`),
          atom_evidence_path: path.join(dir, `${atom.id}-evidence.txt`),
          time_created: now,
          time_updated: now,
        })),
      )
      .run()

    if (rels.length > 0) {
      db.insert(AtomRelationTable)
        .values(
          rels.map((rel) => ({ atom_id_source: rel.source, atom_id_target: rel.target, relation_type: rel.type })),
        )
        .run()
    }
  })

  for (const atom of atoms) {
    await Filesystem.write(path.join(dir, `${atom.id}-claim.txt`), atom.claim)
    await Filesystem.write(path.join(dir, `${atom.id}-evidence.txt`), `Evidence for ${atom.name}`)
  }
}

test("should score dense informative atoms above sparse atoms", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = research(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)
      const atoms: Seed[] = [
        { id: `${p}-root`, name: "Root", type: "method", claim: "Optimization method for training a model" },
        {
          id: `${p}-bridge`,
          name: "Bridge",
          type: "theorem",
          claim: "Detailed convergence theorem with assumptions and guarantees",
        },
        { id: `${p}-leaf`, name: "Leaf", type: "fact", claim: "misc" },
        {
          id: `${p}-support`,
          name: "Support",
          type: "verification",
          claim: "Validation experiments for optimization convergence",
        },
      ]
      await graph(rpId, dir, atoms, [
        { source: atoms[0].id, target: atoms[1].id, type: "derives" },
        { source: atoms[1].id, target: atoms[2].id, type: "other" },
        { source: atoms[1].id, target: atoms[3].id, type: "validates" },
      ])

      const traversed = await traverseAtomGraph({
        seedAtomIds: [atoms[0].id],
        maxDepth: 3,
        maxAtoms: 10,
      })
      const quality = await scoreAtomQuality(traversed)

      expect(quality[atoms[1].id].score).toBeGreaterThan(quality[atoms[2].id].score)
      expect(quality[atoms[1].id].bridgeScore).toBeGreaterThanOrEqual(quality[atoms[2].id].bridgeScore)
      expect(quality[atoms[2].id].informationScore).toBeLessThan(quality[atoms[1].id].informationScore)
    },
  })
})

test("should rerank atoms using query overlap and atom quality", async () => {
  const now = Date.now()
  const atoms = [
    {
      atom: {
        atom_id: "a",
        research_project_id: "rp",
        atom_name: "Relevant",
        atom_type: "method" as const,
        atom_claim_path: null,
        atom_evidence_type: "math" as const,
        atom_evidence_status: "pending" as const,
        atom_evidence_path: null,
        atom_evidence_assessment_path: null,
        article_id: null,
        session_id: null,
        time_created: now,
        time_updated: now,
      },
      claim: "gradient optimization for model training",
      evidence: "e",
      distance: 1,
      path: ["a"],
      relationChain: [],
      score: 10,
      atomQuality: 0.55,
    },
    {
      atom: {
        atom_id: "b",
        research_project_id: "rp",
        atom_name: "Noise",
        atom_type: "fact" as const,
        atom_claim_path: null,
        atom_evidence_type: "math" as const,
        atom_evidence_status: "pending" as const,
        atom_evidence_path: null,
        atom_evidence_assessment_path: null,
        article_id: null,
        session_id: null,
        time_created: now,
        time_updated: now,
      },
      claim: "shopping list",
      evidence: "e",
      distance: 2,
      path: ["b"],
      relationChain: [],
      score: 10,
      atomQuality: 0.3,
    },
  ]

  const result = rerankAtoms(atoms, "gradient optimization training")

  expect(result.kept[0].atom.atom_id).toBe("a")
  expect(result.kept[0].queryOverlap).toBeGreaterThan(0)
  expect(result.removed).toBe(0)
  expect(result.kept).toHaveLength(2)
})

test("should rerank low quality distant atoms behind relevant atoms", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = research(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)
      const atoms: Seed[] = [
        { id: `${p}-root`, name: "Root", type: "method", claim: "Optimization method for training a model" },
        { id: `${p}-rel`, name: "Relevant", type: "theorem", claim: "Convergence theorem for optimization training" },
        { id: `${p}-sup`, name: "Support", type: "verification", claim: "Validation experiments for convergence" },
        { id: `${p}-noise`, name: "Noise", type: "fact", claim: "misc" },
      ]
      await graph(rpId, dir, atoms, [
        { source: atoms[0].id, target: atoms[1].id, type: "derives" },
        { source: atoms[1].id, target: atoms[2].id, type: "validates" },
        { source: atoms[2].id, target: atoms[3].id, type: "other" },
      ])

      const traversed = await traverseAtomGraph({
        seedAtomIds: [atoms[0].id],
        maxDepth: 3,
        maxAtoms: 10,
      })
      const quality = await scoreAtomQuality(traversed)
      const reranked = rerankAtoms(
        applyAtomQuality(scoreAndRankAtoms(traversed, null), quality),
        "optimization training convergence",
      )

      const ids = reranked.kept.map((item) => item.atom.atom_id)
      expect(reranked.removed).toBe(0)
      expect(ids).toContain(atoms[0].id)
      expect(ids).toContain(atoms[1].id)
      expect(ids[ids.length - 1]).toBe(atoms[3].id)
    },
  })
})

test("should expose atom-wise scores through hybrid search", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = research(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)
      const atoms: Seed[] = [
        { id: `${p}-root`, name: "Root", type: "method", claim: "Optimization method for training a model" },
        { id: `${p}-rel`, name: "Relevant", type: "theorem", claim: "Convergence theorem for optimization training" },
      ]
      await graph(rpId, dir, atoms, [{ source: atoms[0].id, target: atoms[1].id, type: "derives" }])

      const result = await hybridSearch({
        query: "optimization training convergence",
        seedAtomIds: [atoms[0].id],
        maxDepth: 2,
        maxAtoms: 10,
        includeEvidence: false,
        includeMetadata: true,
        semanticTopK: 2,
        semanticThreshold: 0.0,
      })

      expect(result.metadata.atomwiseRemoved).toBe(0)
      expect(result.atoms[0].atomQuality).toBeDefined()
      expect(result.atoms[0].queryOverlap).toBeDefined()
    },
  })
})
