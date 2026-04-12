import { test, expect } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { Database } from "../../../src/storage/db"
import { AtomTable, AtomRelationTable, ResearchProjectTable } from "../../../src/research/research.sql"
import { hybridSearch, graphOnlySearch } from "../../../src/tool/atom-graph-prompt/hybrid"
import { traverseAtomGraph } from "../../../src/tool/atom-graph-prompt/traversal"
import { Filesystem } from "../../../src/util/filesystem"
import path from "path"
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

interface TestAtom {
  id: string
  name: string
  type: "fact" | "method" | "theorem" | "verification"
  claim: string
}

async function seedTestGraph(
  rpId: string,
  atomListDir: string,
  atoms: TestAtom[],
  relations: Array<{ source: string; target: string; type: "motivates" | "formalizes" | "derives" | "analyzes" | "validates" | "contradicts" | "other" }>,
) {
  const now = Date.now()

  Database.use((db) => {
    db.insert(AtomTable)
      .values(
        atoms.map((a) => ({
          atom_id: a.id,
          research_project_id: rpId,
          atom_name: a.name,
          atom_type: a.type,
          atom_evidence_type: "math" as const,
          atom_claim_path: path.join(atomListDir, `${a.id}-claim.txt`),
          atom_evidence_path: path.join(atomListDir, `${a.id}-evidence.txt`),
          time_created: now,
          time_updated: now,
        })),
      )
      .run()

    if (relations.length > 0) {
      db.insert(AtomRelationTable)
        .values(
          relations.map((r) => ({
            atom_id_source: r.source,
            atom_id_target: r.target,
            relation_type: r.type,
          })),
        )
        .run()
    }
  })

  for (const a of atoms) {
    await Filesystem.write(path.join(atomListDir, `${a.id}-claim.txt`), a.claim)
    await Filesystem.write(path.join(atomListDir, `${a.id}-evidence.txt`), `Evidence for ${a.name}`)
  }
}

test("should traverse graph without query (Phase 1 compat)", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const prefix = crypto.randomUUID().slice(0, 8)
      const atoms: TestAtom[] = [
        {
          id: `${prefix}-a`,
          name: "SGD Optimizer",
          type: "method",
          claim: "SGD is a first-order optimization algorithm",
        },
        {
          id: `${prefix}-b`,
          name: "Convergence Theorem",
          type: "theorem",
          claim: "SGD converges under convexity assumptions",
        },
        {
          id: `${prefix}-c`,
          name: "Convergence Proof",
          type: "verification",
          claim: "Experiments validate convergence",
        },
      ]
      await seedTestGraph(rpId, dir, atoms, [
        { source: atoms[0].id, target: atoms[1].id, type: "derives" },
        { source: atoms[1].id, target: atoms[2].id, type: "validates" },
      ])

      const result = await graphOnlySearch({
        seedAtomIds: [atoms[0].id],
        maxDepth: 2,
        maxAtoms: 10,
        includeEvidence: true,
        includeMetadata: true,
      })

      expect(result.atoms.length).toBe(3)
      expect(result.metadata.fromSemanticSearch).toBe(0)
      expect(result.metadata.fromGraphTraversal).toBe(3)
      // All atoms should have scores
      result.atoms.forEach((a) => expect(a.score).toBeGreaterThan(0))
    },
  })
})

test("should perform BFS traversal correctly", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const prefix = crypto.randomUUID().slice(0, 8)

      // Chain: A -> B -> C -> D
      const atoms: TestAtom[] = [
        { id: `${prefix}-a`, name: "Root", type: "method", claim: "Root method" },
        { id: `${prefix}-b`, name: "Depth1", type: "fact", claim: "Depth 1 fact" },
        { id: `${prefix}-c`, name: "Depth2", type: "theorem", claim: "Depth 2 theorem" },
        { id: `${prefix}-d`, name: "Depth3", type: "verification", claim: "Depth 3 verification" },
      ]
      await seedTestGraph(rpId, dir, atoms, [
        { source: atoms[0].id, target: atoms[1].id, type: "derives" },
        { source: atoms[1].id, target: atoms[2].id, type: "analyzes" },
        { source: atoms[2].id, target: atoms[3].id, type: "validates" },
      ])

      // maxDepth=1 should only get A and B
      const depth1 = await traverseAtomGraph({
        seedAtomIds: [atoms[0].id],
        maxDepth: 1,
        maxAtoms: 10,
      })
      expect(depth1.length).toBe(2)

      // maxDepth=2 should get A, B, C
      const depth2 = await traverseAtomGraph({
        seedAtomIds: [atoms[0].id],
        maxDepth: 2,
        maxAtoms: 10,
      })
      expect(depth2.length).toBe(3)

      // Verify distances
      const root = depth2.find((a) => a.atom.atom_id === atoms[0].id)
      const d1 = depth2.find((a) => a.atom.atom_id === atoms[1].id)
      const d2 = depth2.find((a) => a.atom.atom_id === atoms[2].id)
      expect(root!.distance).toBe(0)
      expect(d1!.distance).toBe(1)
      expect(d2!.distance).toBe(2)
    },
  })
})

test("should filter by relation types", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const prefix = crypto.randomUUID().slice(0, 8)
      const atoms: TestAtom[] = [
        { id: `${prefix}-a`, name: "Root", type: "method", claim: "Root" },
        { id: `${prefix}-b`, name: "Derived", type: "theorem", claim: "Derived via derives" },
        { id: `${prefix}-c`, name: "Validated", type: "verification", claim: "Validated via validates" },
      ]
      await seedTestGraph(rpId, dir, atoms, [
        { source: atoms[0].id, target: atoms[1].id, type: "derives" },
        { source: atoms[0].id, target: atoms[2].id, type: "validates" },
      ])

      // Only follow "derives" relations
      const result = await traverseAtomGraph({
        seedAtomIds: [atoms[0].id],
        maxDepth: 2,
        relationTypes: ["derives"],
      })

      expect(result.length).toBe(2) // Root + Derived
      const ids = result.map((a) => a.atom.atom_id)
      expect(ids).toContain(atoms[0].id)
      expect(ids).toContain(atoms[1].id)
      expect(ids).not.toContain(atoms[2].id)
    },
  })
})

test("should filter by atom types", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const prefix = crypto.randomUUID().slice(0, 8)
      const atoms: TestAtom[] = [
        { id: `${prefix}-a`, name: "Method A", type: "method", claim: "Method" },
        { id: `${prefix}-b`, name: "Theorem B", type: "theorem", claim: "Theorem" },
        { id: `${prefix}-c`, name: "Fact C", type: "fact", claim: "Fact" },
      ]
      await seedTestGraph(rpId, dir, atoms, [
        { source: atoms[0].id, target: atoms[1].id, type: "derives" },
        { source: atoms[0].id, target: atoms[2].id, type: "analyzes" },
      ])

      // Only include method and theorem
      const result = await traverseAtomGraph({
        seedAtomIds: [atoms[0].id],
        maxDepth: 2,
        atomTypes: ["method", "theorem"],
      })

      expect(result.length).toBe(2)
      result.forEach((a) => {
        expect(["method", "theorem"]).toContain(a.atom.atom_type)
      })
    },
  })
})

test("should find atoms by semantic query", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const prefix = crypto.randomUUID().slice(0, 8)
      const atoms: TestAtom[] = [
        {
          id: `${prefix}-opt`,
          name: "SGD Optimization",
          type: "method",
          claim: "Stochastic gradient descent optimization method for training neural networks",
        },
        {
          id: `${prefix}-conv`,
          name: "Convergence Analysis",
          type: "theorem",
          claim: "Analysis of convergence properties for gradient descent algorithms",
        },
        {
          id: `${prefix}-unrel`,
          name: "Data Collection",
          type: "fact",
          claim: "Survey methodology for collecting biological samples in marine environments",
        },
      ]
      await seedTestGraph(rpId, dir, atoms, [{ source: atoms[0].id, target: atoms[1].id, type: "derives" }])

      const result = await hybridSearch({
        query: "gradient optimization training",
        maxDepth: 2,
        maxAtoms: 10,
        includeEvidence: false,
        includeMetadata: true,
        semanticTopK: 3,
        semanticThreshold: 0.0,
      })

      expect(result.atoms.length).toBeGreaterThan(0)
      expect(result.metadata.fromSemanticSearch).toBeGreaterThan(0)
    },
  })
})

test("should merge and deduplicate results", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const prefix = crypto.randomUUID().slice(0, 8)
      const atoms: TestAtom[] = [
        {
          id: `${prefix}-a`,
          name: "Optimization Method",
          type: "method",
          claim: "An optimization method for training",
        },
        {
          id: `${prefix}-b`,
          name: "Training Analysis",
          type: "theorem",
          claim: "Analysis of training optimization convergence",
        },
      ]
      await seedTestGraph(rpId, dir, atoms, [{ source: atoms[0].id, target: atoms[1].id, type: "derives" }])

      // Use both seedAtomIds and query to potentially find same atoms
      const result = await hybridSearch({
        query: "optimization training",
        seedAtomIds: [atoms[0].id],
        maxDepth: 2,
        maxAtoms: 10,
        includeEvidence: false,
        includeMetadata: true,
        semanticTopK: 5,
        semanticThreshold: 0.0,
      })

      // No duplicate atom IDs
      const ids = result.atoms.map((a) => a.atom.atom_id)
      const unique = new Set(ids)
      expect(unique.size).toBe(ids.length)
    },
  })
})

test("should apply token budget to hybrid results", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const prefix = crypto.randomUUID().slice(0, 8)
      const atoms: TestAtom[] = Array.from({ length: 5 }, (_, i) => ({
        id: `${prefix}-${i}`,
        name: `Atom ${i}`,
        type: "method" as const,
        claim: `This is a longer claim text for atom ${i}. `.repeat(10),
      }))
      const relations = atoms.slice(0, -1).map((a, i) => ({
        source: a.id,
        target: atoms[i + 1].id,
        type: "derives" as const,
      }))
      await seedTestGraph(rpId, dir, atoms, relations)

      const result = await hybridSearch({
        seedAtomIds: [atoms[0].id],
        maxDepth: 4,
        maxAtoms: 10,
        maxTokens: 500,
        includeEvidence: false,
        includeMetadata: true,
      })

      expect(result.metadata.tokensUsed).toBeDefined()
      expect(result.metadata.tokensUsed!).toBeLessThanOrEqual(500)
      expect(result.metadata.budgetUsed).toBeDefined()
      expect(result.metadata.budgetUsed!).toBeLessThanOrEqual(1)
    },
  })
})

test("should return empty results when no seed atoms or query", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fs.mkdir(path.join(tmp.path, "atom_list"), { recursive: true })

      const result = await hybridSearch({
        maxDepth: 2,
        maxAtoms: 10,
        includeEvidence: false,
        includeMetadata: true,
      })

      expect(result.atoms).toHaveLength(0)
      expect(result.metadata.totalFound).toBe(0)
    },
  })
})
