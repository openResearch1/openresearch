import fs from "fs/promises"
import path from "path"
import { expect, test } from "bun:test"

import { Instance } from "../../../src/project/instance"
import { AtomRelationTable, AtomTable, ResearchProjectTable } from "../../../src/research/research.sql"
import { Database } from "../../../src/storage/db"
import { detectCommunities, saveCommunityCache } from "../../../src/tool/atom-graph-prompt/community"
import { pruneCommunities } from "../../../src/tool/atom-graph-prompt/community-prune"
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

test("should prune communities below minimum size", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = research(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      await graph(
        rpId,
        dir,
        [
          { id: `${p}-a1`, name: "A1", type: "method", claim: "A1" },
          { id: `${p}-a2`, name: "A2", type: "method", claim: "A2" },
          { id: `${p}-a3`, name: "A3", type: "method", claim: "A3" },
          { id: `${p}-b1`, name: "B1", type: "fact", claim: "B1" },
          { id: `${p}-b2`, name: "B2", type: "fact", claim: "B2" },
        ],
        [
          { source: `${p}-a1`, target: `${p}-a2`, type: "derives" },
          { source: `${p}-a2`, target: `${p}-a3`, type: "derives" },
          { source: `${p}-a3`, target: `${p}-a1`, type: "analyzes" },
          { source: `${p}-b1`, target: `${p}-b2`, type: "validates" },
          { source: `${p}-b2`, target: `${p}-b1`, type: "formalizes" },
        ],
      )

      const cache = await detectCommunities({ minCommunitySize: 1, forceRefresh: true })
      const result = await pruneCommunities({ minSize: 3 })

      const a = cache.atomToCommunity[`${p}-a1`]
      const b = cache.atomToCommunity[`${p}-b1`]
      expect(result.kept.map((item) => item.id)).toContain(a)
      expect(result.kept.map((item) => item.id)).not.toContain(b)
      expect(result.removed.find((item) => item.community.id === b)?.reasons).toContain("size 2 < 3")
    },
  })
})

test("should prune sparse communities by density and internal edges", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = research(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      await graph(
        rpId,
        dir,
        [
          { id: `${p}-d1`, name: "Dense 1", type: "method", claim: "Dense 1" },
          { id: `${p}-d2`, name: "Dense 2", type: "method", claim: "Dense 2" },
          { id: `${p}-d3`, name: "Dense 3", type: "method", claim: "Dense 3" },
          { id: `${p}-d4`, name: "Dense 4", type: "method", claim: "Dense 4" },
          { id: `${p}-s1`, name: "Sparse 1", type: "fact", claim: "Sparse 1" },
          { id: `${p}-s2`, name: "Sparse 2", type: "fact", claim: "Sparse 2" },
          { id: `${p}-s3`, name: "Sparse 3", type: "fact", claim: "Sparse 3" },
          { id: `${p}-s4`, name: "Sparse 4", type: "fact", claim: "Sparse 4" },
          { id: `${p}-s5`, name: "Sparse 5", type: "fact", claim: "Sparse 5" },
        ],
        [
          { source: `${p}-d1`, target: `${p}-d2`, type: "derives" },
          { source: `${p}-d2`, target: `${p}-d3`, type: "derives" },
          { source: `${p}-d3`, target: `${p}-d4`, type: "derives" },
          { source: `${p}-d4`, target: `${p}-d1`, type: "analyzes" },
          { source: `${p}-s1`, target: `${p}-s2`, type: "validates" },
          { source: `${p}-s2`, target: `${p}-s3`, type: "other" },
          { source: `${p}-s3`, target: `${p}-s4`, type: "other" },
          { source: `${p}-s4`, target: `${p}-s5`, type: "other" },
        ],
      )

      await saveCommunityCache({
        version: "1.0",
        lastUpdated: Date.now(),
        communities: {
          dense: {
            id: "dense",
            atomIds: [`${p}-d1`, `${p}-d2`, `${p}-d3`, `${p}-d4`],
            summary: "Dense method community",
            keywords: ["Dense 1", "Dense 2", "Dense 3", "Dense 4"],
            dominantType: "method",
            size: 4,
            density: 4 / 12,
            timestamp: Date.now(),
          },
          sparse: {
            id: "sparse",
            atomIds: [`${p}-s1`, `${p}-s2`, `${p}-s3`, `${p}-s4`, `${p}-s5`],
            summary: "Sparse fact community",
            keywords: ["Sparse 1", "Sparse 2", "Sparse 3", "Sparse 4", "Sparse 5"],
            dominantType: "fact",
            size: 5,
            density: 4 / 20,
            timestamp: Date.now(),
          },
        },
        atomToCommunity: {
          [`${p}-d1`]: "dense",
          [`${p}-d2`]: "dense",
          [`${p}-d3`]: "dense",
          [`${p}-d4`]: "dense",
          [`${p}-s1`]: "sparse",
          [`${p}-s2`]: "sparse",
          [`${p}-s3`]: "sparse",
          [`${p}-s4`]: "sparse",
          [`${p}-s5`]: "sparse",
        },
      })

      const result = await pruneCommunities({ minDensity: 0.25 })

      expect(result.kept.map((item) => item.id)).toContain("dense")
      expect(result.kept.map((item) => item.id)).not.toContain("sparse")

      const removed = result.removed.find((item) => item.community.id === "sparse")
      expect(removed?.reasons.some((item) => item.includes("density"))).toBeTrue()
    },
  })
})

test("should prune hub dominated communities", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = research(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      await graph(
        rpId,
        dir,
        [
          { id: `${p}-h0`, name: "Hub", type: "fact", claim: "Hub" },
          { id: `${p}-h1`, name: "Leaf 1", type: "fact", claim: "Leaf 1" },
          { id: `${p}-h2`, name: "Leaf 2", type: "fact", claim: "Leaf 2" },
          { id: `${p}-h3`, name: "Leaf 3", type: "fact", claim: "Leaf 3" },
          { id: `${p}-b1`, name: "Balanced 1", type: "theorem", claim: "Balanced 1" },
          { id: `${p}-b2`, name: "Balanced 2", type: "theorem", claim: "Balanced 2" },
          { id: `${p}-b3`, name: "Balanced 3", type: "theorem", claim: "Balanced 3" },
        ],
        [
          { source: `${p}-h0`, target: `${p}-h1`, type: "other" },
          { source: `${p}-h1`, target: `${p}-h0`, type: "other" },
          { source: `${p}-h0`, target: `${p}-h2`, type: "other" },
          { source: `${p}-h2`, target: `${p}-h0`, type: "other" },
          { source: `${p}-h0`, target: `${p}-h3`, type: "other" },
          { source: `${p}-h3`, target: `${p}-h0`, type: "other" },
          { source: `${p}-b1`, target: `${p}-b2`, type: "derives" },
          { source: `${p}-b2`, target: `${p}-b3`, type: "derives" },
          { source: `${p}-b3`, target: `${p}-b1`, type: "derives" },
          { source: `${p}-b1`, target: `${p}-b3`, type: "analyzes" },
          { source: `${p}-b2`, target: `${p}-b1`, type: "analyzes" },
          { source: `${p}-b3`, target: `${p}-b2`, type: "analyzes" },
        ],
      )

      const cache = await detectCommunities({ minCommunitySize: 1, forceRefresh: true })
      const result = await pruneCommunities({ maxHubRatio: 0.45 })

      const hub = cache.atomToCommunity[`${p}-h0`]
      const balanced = cache.atomToCommunity[`${p}-b1`]
      expect(result.kept.map((item) => item.id)).toContain(balanced)
      expect(result.kept.map((item) => item.id)).not.toContain(hub)

      const removed = result.removed.find((item) => item.community.id === hub)
      expect(removed?.reasons.some((item) => item.includes("hubRatio"))).toBeTrue()
      expect(removed?.metrics.hubRatio).toBeGreaterThan(0.45)
    },
  })
})

test("should report pruning metrics for kept communities", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = research(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      await graph(
        rpId,
        dir,
        [
          { id: `${p}-x1`, name: "X1", type: "method", claim: "X1" },
          { id: `${p}-x2`, name: "X2", type: "method", claim: "X2" },
          { id: `${p}-x3`, name: "X3", type: "method", claim: "X3" },
        ],
        [
          { source: `${p}-x1`, target: `${p}-x2`, type: "derives" },
          { source: `${p}-x2`, target: `${p}-x3`, type: "derives" },
          { source: `${p}-x3`, target: `${p}-x1`, type: "derives" },
          { source: `${p}-x1`, target: `${p}-x3`, type: "analyzes" },
          { source: `${p}-x2`, target: `${p}-x1`, type: "analyzes" },
          { source: `${p}-x3`, target: `${p}-x2`, type: "analyzes" },
        ],
      )

      await detectCommunities({ minCommunitySize: 1, forceRefresh: true })
      const result = await pruneCommunities({ minDensity: 0.2, minKeywords: 2 })

      expect(result.kept).toHaveLength(1)
      expect(result.removed).toHaveLength(0)
      expect(result.decisions[0].metrics.internalEdges).toBe(6)
      expect(result.decisions[0].metrics.keywordCount).toBe(3)
      expect(result.decisions[0].metrics.hubRatio).toBeCloseTo(1 / 3, 2)
    },
  })
})
