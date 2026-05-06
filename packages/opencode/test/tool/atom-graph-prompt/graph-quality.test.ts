import fs from "fs/promises"
import path from "path"
import { expect, test } from "bun:test"

import { Instance } from "../../../src/project/instance"
import { AtomRelationTable, AtomTable, ResearchProjectTable } from "../../../src/research/research.sql"
import { Database } from "../../../src/storage/db"
import { evaluateGraphQuality } from "../../../src/tool/atom-graph-prompt/graph-quality"
import { Filesystem } from "../../../src/util/filesystem"
import { tmpdir } from "../../fixture/fixture"

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

type Seed = {
  id: string
  name: string
  type: "fact" | "method" | "theorem" | "verification"
  claim: string
  evidence: string
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
        .values(rels.map((rel) => ({ atom_id_source: rel.source, atom_id_target: rel.target, relation_type: rel.type })))
        .run()
    }
  })

  for (const atom of atoms) {
    await Filesystem.write(path.join(dir, `${atom.id}-claim.txt`), atom.claim)
    await Filesystem.write(path.join(dir, `${atom.id}-evidence.txt`), atom.evidence)
  }
}

test("should return zero metrics for an empty project", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fs.mkdir(path.join(tmp.path, "atom_list"), { recursive: true })
      research(Instance.project.id)

      const report = await evaluateGraphQuality({ forceRefresh: true })

      expect(report.structure.totalCommunities).toBe(0)
      expect(report.structure.avgDensity).toBe(0)
      expect(report.semantic.intraCommunitySimilarity).toBe(0)
      expect(report.research.typeCoverage).toBe(0)
      expect(report.stability.pruneRetentionRatio).toBe(0)
    },
  })
})

test("should assess dense communities, isolate ratio, and prune retention", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = research(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)
      const atoms: Seed[] = [
        {
          id: `${p}-a1`,
          name: "Optimization Method A1",
          type: "method",
          claim: "Optimization method for gradient training and stable updates",
          evidence: "Experiment A1",
        },
        {
          id: `${p}-a2`,
          name: "Optimization Method A2",
          type: "method",
          claim: "Gradient optimization method with convergence guarantees",
          evidence: "Experiment A2",
        },
        {
          id: `${p}-a3`,
          name: "Optimization Method A3",
          type: "method",
          claim: "Training optimization improves stability and learning speed",
          evidence: "Experiment A3",
        },
        {
          id: `${p}-b1`,
          name: "Memory Verification B1",
          type: "verification",
          claim: "Memory benchmark verifies retrieval latency improvement",
          evidence: "Benchmark B1",
        },
        {
          id: `${p}-b2`,
          name: "Memory Verification B2",
          type: "verification",
          claim: "Benchmark verifies memory efficiency and retrieval throughput",
          evidence: "Benchmark B2",
        },
        {
          id: `${p}-b3`,
          name: "Memory Verification B3",
          type: "verification",
          claim: "Evaluation verifies benchmark quality for memory retrieval",
          evidence: "Benchmark B3",
        },
        {
          id: `${p}-c1`,
          name: "Open Question C1",
          type: "fact",
          claim: "Open question about long context reasoning",
          evidence: "Observation C1",
        },
      ]

      await graph(rpId, dir, atoms, [
        { source: atoms[0].id, target: atoms[1].id, type: "derives" },
        { source: atoms[1].id, target: atoms[2].id, type: "derives" },
        { source: atoms[2].id, target: atoms[0].id, type: "analyzes" },
        { source: atoms[3].id, target: atoms[4].id, type: "validates" },
        { source: atoms[4].id, target: atoms[5].id, type: "validates" },
        { source: atoms[5].id, target: atoms[3].id, type: "formalizes" },
        { source: atoms[3].id, target: atoms[4].id, type: "contradicts" },
      ])

      const report = await evaluateGraphQuality({
        forceRefresh: true,
        prune: {
          minSize: 3,
          minDensity: 0.3,
          minInternalEdges: 3,
          minKeywords: 3,
          maxHubRatio: 0.8,
        },
      })

      expect(report.structure.totalCommunities).toBe(2)
      expect(report.structure.avgCommunitySize).toBe(3)
      expect(report.structure.avgDensity).toBeCloseTo(0.5, 4)
      expect(report.structure.isolatedAtomRatio).toBeCloseTo(1 / 7, 4)
      expect(report.structure.bridgeAtomRatio).toBe(0)

      expect(report.semantic.intraCommunitySimilarity).toBeGreaterThan(0)
      expect(report.semantic.interCommunitySeparation).toBeGreaterThan(0)
      expect(report.semantic.summaryCoherence).toBeGreaterThan(0)
      expect(report.semantic.keywordUniqueness).toBe(1)

      expect(report.research.typeCoverage).toBeCloseTo(3 / 4, 4)
      expect(report.research.evidenceCoverage).toBe(1)
      expect(report.research.verificationCoverage).toBeCloseTo(3 / 7, 4)
      expect(report.research.contradictionExposure).toBeCloseTo(1 / 7, 4)

      expect(report.stability.pruneRetentionRatio).toBeCloseTo(6 / 7, 4)
      expect(report.stability.relationSuggestionConfidence).toBe(0)
      expect(report.stability.extensionSuggestionConfidence).toBe(0)
    },
  })
})
