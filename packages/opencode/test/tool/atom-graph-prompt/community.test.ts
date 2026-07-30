import { test, expect } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { Database } from "../../../src/storage/db"
import { AtomTable, AtomRelationTable, ResearchProjectTable } from "../../../src/research/research.sql"
import {
  detectCommunities,
  queryCommunities,
  getCommunityStats,
  getAtomCommunity,
  getCommunityAtoms,
  refreshCommunities,
} from "../../../src/tool/atom-graph-prompt/community"
import path from "path"
import { Filesystem } from "../../../src/util/filesystem"
import fs from "fs/promises"

function createResearchProject(projectId: string): string {
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

test("detectCommunities - basic detection", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Create atom_list directory
      const atomListDir = path.join(tmp.path, "atom_list")
      await fs.mkdir(atomListDir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const now = Date.now()

      // Create test atoms
      const atom1Id = "atom-1"
      const atom2Id = "atom-2"
      const atom3Id = "atom-3"

      Database.use((db) => {
        db.insert(AtomTable)
          .values([
            {
              atom_id: atom1Id,
              research_project_id: rpId,
              atom_name: "Test Atom 1",
              atom_type: "method",
              atom_evidence_type: "math",
              atom_claim_path: path.join(atomListDir, "atom1-claim.txt"),
              atom_evidence_path: path.join(atomListDir, "atom1-evidence.txt"),
              time_created: now,
              time_updated: now,
            },
            {
              atom_id: atom2Id,
              research_project_id: rpId,
              atom_name: "Test Atom 2",
              atom_type: "theorem",
              atom_evidence_type: "math",
              atom_claim_path: path.join(atomListDir, "atom2-claim.txt"),
              atom_evidence_path: path.join(atomListDir, "atom2-evidence.txt"),
              time_created: now,
              time_updated: now,
            },
            {
              atom_id: atom3Id,
              research_project_id: rpId,
              atom_name: "Test Atom 3",
              atom_type: "fact",
              atom_evidence_type: "experiment",
              atom_claim_path: path.join(atomListDir, "atom3-claim.txt"),
              atom_evidence_path: path.join(atomListDir, "atom3-evidence.txt"),
              time_created: now,
              time_updated: now,
            },
          ])
          .run()

        // Create relations
        db.insert(AtomRelationTable)
          .values([
            {
              atom_id_source: atom1Id,
              atom_id_target: atom2Id,
              relation_type: "analyzed_by",
            },
            {
              atom_id_source: atom2Id,
              atom_id_target: atom3Id,
              relation_type: "evaluated_by",
            },
          ])
          .run()
      })

      // Write claim files
      await Filesystem.write(path.join(atomListDir, "atom1-claim.txt"), "This is a test method claim")
      await Filesystem.write(path.join(atomListDir, "atom2-claim.txt"), "This is a test theorem claim")
      await Filesystem.write(path.join(atomListDir, "atom3-claim.txt"), "This is a test fact claim")

      // Detect communities
      const cache = await detectCommunities({ minCommunitySize: 1 })

      expect(cache).toBeDefined()
      expect(cache.version).toBe("1.0")
      expect(Object.keys(cache.communities).length).toBeGreaterThan(0)
      expect(Object.keys(cache.atomToCommunity).length).toBeGreaterThanOrEqual(3)
    },
  })
})

test("queryCommunities - filter by size", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const atomListDir = path.join(tmp.path, "atom_list")
      await fs.mkdir(atomListDir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const now = Date.now()

      // Create multiple atoms with unique IDs
      const prefix = crypto.randomUUID().slice(0, 8)
      const atomIds = [`${prefix}-1`, `${prefix}-2`, `${prefix}-3`, `${prefix}-4`]

      Database.use((db) => {
        db.insert(AtomTable)
          .values(
            atomIds.map((id, index) => ({
              atom_id: id,
              research_project_id: rpId,
              atom_name: `Test Atom ${index + 1}`,
              atom_type: "method" as const,
              atom_evidence_type: "math" as const,
              atom_claim_path: path.join(atomListDir, `${id}-claim.txt`),
              atom_evidence_path: path.join(atomListDir, `${id}-evidence.txt`),
              time_created: now,
              time_updated: now,
            })),
          )
          .run()

        // Create relations to form communities
        db.insert(AtomRelationTable)
          .values([
            { atom_id_source: atomIds[0], atom_id_target: atomIds[1], relation_type: "derives" },
            { atom_id_source: atomIds[2], atom_id_target: atomIds[3], relation_type: "evaluated_by" },
          ])
          .run()
      })

      // Write claim files
      for (const id of atomIds) {
        await Filesystem.write(path.join(atomListDir, `${id}-claim.txt`), `Claim for ${id}`)
      }

      // Detect communities first
      await detectCommunities({ minCommunitySize: 1 })

      // Query with size filter
      const communities = await queryCommunities({ minSize: 2, topK: 10 })

      expect(communities).toBeDefined()
      expect(Array.isArray(communities)).toBe(true)
      communities.forEach((comm) => {
        expect(comm.size).toBeGreaterThanOrEqual(2)
      })
    },
  })
})

test("getCommunityStats - returns correct statistics", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const atomListDir = path.join(tmp.path, "atom_list")
      await fs.mkdir(atomListDir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const now = Date.now()

      // Create test atoms with unique IDs
      const prefix = crypto.randomUUID().slice(0, 8)
      const atomIds = [`${prefix}-1`, `${prefix}-2`, `${prefix}-3`]

      Database.use((db) => {
        db.insert(AtomTable)
          .values(
            atomIds.map((id, index) => ({
              atom_id: id,
              research_project_id: rpId,
              atom_name: `Test Atom ${index + 1}`,
              atom_type: "method" as const,
              atom_evidence_type: "math" as const,
              atom_claim_path: path.join(atomListDir, `${id}-claim.txt`),
              atom_evidence_path: path.join(atomListDir, `${id}-evidence.txt`),
              time_created: now,
              time_updated: now,
            })),
          )
          .run()

        db.insert(AtomRelationTable)
          .values([
            { atom_id_source: atomIds[0], atom_id_target: atomIds[1], relation_type: "derives" },
            { atom_id_source: atomIds[1], atom_id_target: atomIds[2], relation_type: "evaluated_by" },
          ])
          .run()
      })

      for (const id of atomIds) {
        await Filesystem.write(path.join(atomListDir, `${id}-claim.txt`), `Claim for ${id}`)
      }

      // Detect communities
      await detectCommunities({ minCommunitySize: 1 })

      // Get stats
      const stats = await getCommunityStats()

      expect(stats).toBeDefined()
      expect(stats.totalCommunities).toBeGreaterThan(0)
      expect(stats.totalAtoms).toBeGreaterThanOrEqual(3)
      expect(stats.avgCommunitySize).toBeGreaterThan(0)
      expect(stats.largestCommunity).toBeGreaterThan(0)
      expect(stats.avgDensity).toBeGreaterThanOrEqual(0)
    },
  })
})

test("getAtomCommunity - returns correct community", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const atomListDir = path.join(tmp.path, "atom_list")
      await fs.mkdir(atomListDir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const now = Date.now()
      const atomId = crypto.randomUUID()

      Database.use((db) => {
        db.insert(AtomTable)
          .values({
            atom_id: atomId,
            research_project_id: rpId,
            atom_name: "Test Atom",
            atom_type: "method",
            atom_evidence_type: "math",
            atom_claim_path: path.join(atomListDir, "atom-claim.txt"),
            atom_evidence_path: path.join(atomListDir, "atom-evidence.txt"),
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      await Filesystem.write(path.join(atomListDir, "atom-claim.txt"), "Test claim")

      // Detect communities
      await detectCommunities({ minCommunitySize: 1 })

      // Get atom's community
      const community = await getAtomCommunity(atomId)

      expect(community).toBeDefined()
      if (community) {
        expect(community.atomIds).toContain(atomId)
        expect(community.size).toBeGreaterThan(0)
      }
    },
  })
})

test("refreshCommunities - forces cache refresh", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const atomListDir = path.join(tmp.path, "atom_list")
      await fs.mkdir(atomListDir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const now = Date.now()

      const refreshAtomId = crypto.randomUUID()

      Database.use((db) => {
        db.insert(AtomTable)
          .values({
            atom_id: refreshAtomId,
            research_project_id: rpId,
            atom_name: "Test Atom",
            atom_type: "method",
            atom_evidence_type: "math",
            atom_claim_path: path.join(atomListDir, "atom-claim.txt"),
            atom_evidence_path: path.join(atomListDir, "atom-evidence.txt"),
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      await Filesystem.write(path.join(atomListDir, "atom-claim.txt"), "Test claim")

      // First detection
      const cache1 = await detectCommunities({ minCommunitySize: 1 })
      const timestamp1 = cache1.lastUpdated

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Refresh
      const cache2 = await refreshCommunities({ minCommunitySize: 1 })
      const timestamp2 = cache2.lastUpdated

      expect(timestamp2).toBeGreaterThan(timestamp1)
    },
  })
})
