import { test, expect } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { Database } from "../../../src/storage/db"
import { AtomTable, AtomRelationTable, ResearchProjectTable } from "../../../src/research/research.sql"
import { detectCommunities } from "../../../src/tool/atom-graph-prompt/community"
import { hybridSearch } from "../../../src/tool/atom-graph-prompt/hybrid"
import { Filesystem } from "../../../src/util/filesystem"
import path from "path"
import fs from "fs/promises"

function createResearchProject(projectId: string): string {
  const id = crypto.randomUUID()
  const now = Date.now()
  Database.use((db) => {
    db.insert(ResearchProjectTable)
      .values({ research_project_id: id, project_id: projectId, time_created: now, time_updated: now })
      .run()
  })
  return id
}

interface SeedAtom {
  id: string
  name: string
  type: "fact" | "method" | "theorem" | "verification"
  claim: string
}

async function seedGraph(
  rpId: string,
  dir: string,
  atoms: SeedAtom[],
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
          atom_claim_path: path.join(dir, `${a.id}-claim.txt`),
          atom_evidence_path: path.join(dir, `${a.id}-evidence.txt`),
          time_created: now,
          time_updated: now,
        })),
      )
      .run()
    if (relations.length > 0) {
      db.insert(AtomRelationTable)
        .values(relations.map((r) => ({ atom_id_source: r.source, atom_id_target: r.target, relation_type: r.type })))
        .run()
    }
  })
  for (const a of atoms) {
    await Filesystem.write(path.join(dir, `${a.id}-claim.txt`), a.claim)
    await Filesystem.write(path.join(dir, `${a.id}-evidence.txt`), `Evidence for ${a.name}`)
  }
}

// -------------------------------------------------------------------
// 1. hybridSearch 按 communityIds 过滤
// -------------------------------------------------------------------
test("should filter hybrid results by community IDs", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      // 两个独立子图
      const atoms: SeedAtom[] = [
        { id: `${p}-a1`, name: "A1", type: "method", claim: "Group A method 1" },
        { id: `${p}-a2`, name: "A2", type: "method", claim: "Group A method 2" },
        { id: `${p}-b1`, name: "B1", type: "theorem", claim: "Group B theorem 1" },
        { id: `${p}-b2`, name: "B2", type: "theorem", claim: "Group B theorem 2" },
      ]

      await seedGraph(rpId, dir, atoms, [
        { source: `${p}-a1`, target: `${p}-a2`, type: "derives" },
        { source: `${p}-a2`, target: `${p}-a1`, type: "analyzes" },
        { source: `${p}-b1`, target: `${p}-b2`, type: "validates" },
        { source: `${p}-b2`, target: `${p}-b1`, type: "formalizes" },
      ])

      const cache = await detectCommunities({ minCommunitySize: 2, forceRefresh: true })

      // 找到 a1 所属的社区
      const commA = cache.atomToCommunity[`${p}-a1`]
      expect(commA).toBeDefined()

      // 只搜索 a 组社区
      const result = await hybridSearch({
        seedAtomIds: [`${p}-a1`, `${p}-b1`],
        maxDepth: 2,
        maxAtoms: 10,
        includeEvidence: false,
        includeMetadata: true,
        communityFilter: { communityIds: [commA] },
      })

      // 结果应只包含 a 组
      const ids = result.atoms.map((a) => a.atom.atom_id)
      expect(ids).toContain(`${p}-a1`)
      expect(ids).toContain(`${p}-a2`)
      expect(ids).not.toContain(`${p}-b1`)
      expect(ids).not.toContain(`${p}-b2`)
    },
  })
})

// -------------------------------------------------------------------
// 2. hybridSearch 按 minCommunitySize 过滤
// -------------------------------------------------------------------
test("should filter by minimum community size", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      // 大组 4 节点 + 小组 2 节点
      const atoms: SeedAtom[] = [
        { id: `${p}-lg1`, name: "LG1", type: "method", claim: "Large group 1" },
        { id: `${p}-lg2`, name: "LG2", type: "method", claim: "Large group 2" },
        { id: `${p}-lg3`, name: "LG3", type: "method", claim: "Large group 3" },
        { id: `${p}-lg4`, name: "LG4", type: "method", claim: "Large group 4" },
        { id: `${p}-sm1`, name: "SM1", type: "fact", claim: "Small group 1" },
        { id: `${p}-sm2`, name: "SM2", type: "fact", claim: "Small group 2" },
      ]

      await seedGraph(rpId, dir, atoms, [
        { source: `${p}-lg1`, target: `${p}-lg2`, type: "derives" },
        { source: `${p}-lg2`, target: `${p}-lg3`, type: "derives" },
        { source: `${p}-lg3`, target: `${p}-lg4`, type: "derives" },
        { source: `${p}-lg4`, target: `${p}-lg1`, type: "analyzes" },
        { source: `${p}-sm1`, target: `${p}-sm2`, type: "validates" },
        { source: `${p}-sm2`, target: `${p}-sm1`, type: "formalizes" },
      ])

      await detectCommunities({ minCommunitySize: 1, forceRefresh: true })

      // 只要大社区（>= 3）
      const result = await hybridSearch({
        seedAtomIds: [`${p}-lg1`, `${p}-sm1`],
        maxDepth: 3,
        maxAtoms: 20,
        includeEvidence: false,
        includeMetadata: true,
        communityFilter: { minCommunitySize: 3 },
      })

      const ids = result.atoms.map((a) => a.atom.atom_id)
      // 大组应被包含
      expect(ids).toContain(`${p}-lg1`)
      // 小组应被过滤
      expect(ids).not.toContain(`${p}-sm1`)
      expect(ids).not.toContain(`${p}-sm2`)
    },
  })
})

// -------------------------------------------------------------------
// 3. hybridSearch 按 dominantTypes 过滤
// -------------------------------------------------------------------
test("should filter by community dominant types", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      // Method 社区
      const atoms: SeedAtom[] = [
        { id: `${p}-m1`, name: "Method M1", type: "method", claim: "M1" },
        { id: `${p}-m2`, name: "Method M2", type: "method", claim: "M2" },
        // Theorem 社区
        { id: `${p}-t1`, name: "Theorem T1", type: "theorem", claim: "T1" },
        { id: `${p}-t2`, name: "Theorem T2", type: "theorem", claim: "T2" },
      ]

      await seedGraph(rpId, dir, atoms, [
        { source: `${p}-m1`, target: `${p}-m2`, type: "derives" },
        { source: `${p}-m2`, target: `${p}-m1`, type: "analyzes" },
        { source: `${p}-t1`, target: `${p}-t2`, type: "validates" },
        { source: `${p}-t2`, target: `${p}-t1`, type: "formalizes" },
      ])

      await detectCommunities({ minCommunitySize: 2, forceRefresh: true })

      // 只要 theorem 主导的社区
      const result = await hybridSearch({
        seedAtomIds: [`${p}-m1`, `${p}-t1`],
        maxDepth: 2,
        maxAtoms: 10,
        includeEvidence: false,
        includeMetadata: true,
        communityFilter: { dominantTypes: ["theorem"] },
      })

      const types = result.atoms.map((a) => a.atom.atom_type)
      // 应全是 theorem 社区的成员
      types.forEach((t) => expect(t).toBe("theorem"))
    },
  })
})

// -------------------------------------------------------------------
// 4. hybridSearch 无社区缓存时社区过滤优雅降级
// -------------------------------------------------------------------
test("should degrade gracefully when community cache does not exist", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      const atoms: SeedAtom[] = [
        { id: `${p}-x1`, name: "X1", type: "method", claim: "X1" },
        { id: `${p}-x2`, name: "X2", type: "method", claim: "X2" },
      ]
      await seedGraph(rpId, dir, atoms, [{ source: `${p}-x1`, target: `${p}-x2`, type: "derives" }])

      // 不调用 detectCommunities，直接带社区过滤搜索
      // 当没有社区缓存时，applyCommunityFilter 返回空数组
      // hybridSearch 将跳过社区过滤（优雅降级），返回正常遍历结果
      const result = await hybridSearch({
        seedAtomIds: [`${p}-x1`],
        maxDepth: 2,
        maxAtoms: 10,
        includeEvidence: false,
        includeMetadata: true,
        communityFilter: { communityIds: ["nonexistent"] },
      })

      // 无缓存时过滤被跳过，正常遍历结果通过
      expect(result.atoms.length).toBeGreaterThan(0)
    },
  })
})

// -------------------------------------------------------------------
// 5. hybridSearch 社区过滤 + 语义搜索组合
// -------------------------------------------------------------------
test("should combine community filter with semantic search", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      const atoms: SeedAtom[] = [
        {
          id: `${p}-opt1`,
          name: "SGD Method",
          type: "method",
          claim: "Stochastic gradient descent optimization for neural network training",
        },
        {
          id: `${p}-opt2`,
          name: "Adam Method",
          type: "method",
          claim: "Adaptive moment estimation for deep learning optimization",
        },
        { id: `${p}-bio1`, name: "Gene Seq", type: "fact", claim: "DNA gene sequencing using next generation methods" },
        { id: `${p}-bio2`, name: "Protein", type: "fact", claim: "Protein structure prediction and folding analysis" },
      ]

      await seedGraph(rpId, dir, atoms, [
        { source: `${p}-opt1`, target: `${p}-opt2`, type: "derives" },
        { source: `${p}-opt2`, target: `${p}-opt1`, type: "analyzes" },
        { source: `${p}-bio1`, target: `${p}-bio2`, type: "analyzes" },
        { source: `${p}-bio2`, target: `${p}-bio1`, type: "validates" },
      ])

      const cache = await detectCommunities({ minCommunitySize: 2, forceRefresh: true })
      const optComm = cache.atomToCommunity[`${p}-opt1`]

      // 语义搜索 "gradient optimization" + 限制到 opt 社区
      const result = await hybridSearch({
        query: "gradient optimization training",
        maxDepth: 2,
        maxAtoms: 10,
        includeEvidence: false,
        includeMetadata: true,
        semanticTopK: 5,
        semanticThreshold: 0.0,
        communityFilter: { communityIds: [optComm] },
      })

      // 结果应只包含 opt 社区
      const ids = result.atoms.map((a) => a.atom.atom_id)
      ids.forEach((id) => {
        expect(id.startsWith(`${p}-opt`)).toBe(true)
      })
    },
  })
})

// -------------------------------------------------------------------
// 6. hybridSearch maxCommunitySize 过滤
// -------------------------------------------------------------------
test("should filter by maximum community size", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      // 小组 2 节点 + 大组 4 节点
      const atoms: SeedAtom[] = [
        { id: `${p}-s1`, name: "S1", type: "fact", claim: "Small 1" },
        { id: `${p}-s2`, name: "S2", type: "fact", claim: "Small 2" },
        { id: `${p}-l1`, name: "L1", type: "method", claim: "Large 1" },
        { id: `${p}-l2`, name: "L2", type: "method", claim: "Large 2" },
        { id: `${p}-l3`, name: "L3", type: "method", claim: "Large 3" },
        { id: `${p}-l4`, name: "L4", type: "method", claim: "Large 4" },
      ]

      await seedGraph(rpId, dir, atoms, [
        { source: `${p}-s1`, target: `${p}-s2`, type: "validates" },
        { source: `${p}-s2`, target: `${p}-s1`, type: "formalizes" },
        { source: `${p}-l1`, target: `${p}-l2`, type: "derives" },
        { source: `${p}-l2`, target: `${p}-l3`, type: "derives" },
        { source: `${p}-l3`, target: `${p}-l4`, type: "derives" },
        { source: `${p}-l4`, target: `${p}-l1`, type: "analyzes" },
      ])

      await detectCommunities({ minCommunitySize: 2, forceRefresh: true })

      // 只要小社区（<= 2）
      const result = await hybridSearch({
        seedAtomIds: [`${p}-s1`, `${p}-l1`],
        maxDepth: 3,
        maxAtoms: 20,
        includeEvidence: false,
        includeMetadata: true,
        communityFilter: { maxCommunitySize: 2 },
      })

      const ids = result.atoms.map((a) => a.atom.atom_id)
      // 小组在
      expect(ids).toContain(`${p}-s1`)
      // 大组被过滤
      expect(ids).not.toContain(`${p}-l1`)
    },
  })
})
