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
  loadCommunityCache,
  saveCommunityCache,
} from "../../../src/tool/atom-graph-prompt/community"
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
// 1. 社区结构验证：两个独立子图应分入不同社区
// -------------------------------------------------------------------
test("should detect separate communities for disconnected subgraphs", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      // 两个完全隔离的子图
      // Group A: method 链
      // Group B: theorem 链
      const atoms: SeedAtom[] = [
        { id: `${p}-a1`, name: "Method A1", type: "method", claim: "Optimization method A1" },
        { id: `${p}-a2`, name: "Method A2", type: "method", claim: "Optimization method A2" },
        { id: `${p}-a3`, name: "Method A3", type: "method", claim: "Optimization method A3" },
        { id: `${p}-b1`, name: "Theorem B1", type: "theorem", claim: "Convergence theorem B1" },
        { id: `${p}-b2`, name: "Theorem B2", type: "theorem", claim: "Convergence theorem B2" },
        { id: `${p}-b3`, name: "Theorem B3", type: "theorem", claim: "Convergence theorem B3" },
      ]

      await seedGraph(rpId, dir, atoms, [
        // Group A 内部连接
        { source: `${p}-a1`, target: `${p}-a2`, type: "derives" },
        { source: `${p}-a2`, target: `${p}-a3`, type: "derives" },
        { source: `${p}-a3`, target: `${p}-a1`, type: "analyzes" },
        // Group B 内部连接
        { source: `${p}-b1`, target: `${p}-b2`, type: "validates" },
        { source: `${p}-b2`, target: `${p}-b3`, type: "validates" },
        { source: `${p}-b3`, target: `${p}-b1`, type: "formalizes" },
        // 没有跨组关系
      ])

      const cache = await detectCommunities({ minCommunitySize: 2, forceRefresh: true })

      const communities = Object.values(cache.communities)
      // 至少 2 个社区（两个隔离子图）
      expect(communities.length).toBeGreaterThanOrEqual(2)

      // 验证 a 组和 b 组不在同一社区
      const a1Comm = cache.atomToCommunity[`${p}-a1`]
      const b1Comm = cache.atomToCommunity[`${p}-b1`]
      expect(a1Comm).toBeDefined()
      expect(b1Comm).toBeDefined()
      expect(a1Comm).not.toBe(b1Comm)

      // 同一子图内应属同一社区
      expect(cache.atomToCommunity[`${p}-a2`]).toBe(a1Comm)
      expect(cache.atomToCommunity[`${p}-b2`]).toBe(b1Comm)
    },
  })
})

// -------------------------------------------------------------------
// 2. 社区主导类型检测
// -------------------------------------------------------------------
test("should identify dominant type per community", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      // 一个社区全是 method
      const atoms: SeedAtom[] = [
        { id: `${p}-m1`, name: "Method 1", type: "method", claim: "Method claim 1" },
        { id: `${p}-m2`, name: "Method 2", type: "method", claim: "Method claim 2" },
        { id: `${p}-m3`, name: "Method 3", type: "method", claim: "Method claim 3" },
      ]

      await seedGraph(rpId, dir, atoms, [
        { source: `${p}-m1`, target: `${p}-m2`, type: "derives" },
        { source: `${p}-m2`, target: `${p}-m3`, type: "derives" },
        { source: `${p}-m3`, target: `${p}-m1`, type: "analyzes" },
      ])

      const cache = await detectCommunities({ minCommunitySize: 2, forceRefresh: true })

      // 找到包含 m1 的社区
      const commId = cache.atomToCommunity[`${p}-m1`]
      expect(commId).toBeDefined()

      const community = cache.communities[commId]
      expect(community.dominantType).toBe("method")
    },
  })
})

// -------------------------------------------------------------------
// 3. 社区密度计算
// -------------------------------------------------------------------
test("should calculate community density correctly", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      // 全连接三角形 → 高密度
      const atoms: SeedAtom[] = [
        { id: `${p}-x1`, name: "X1", type: "fact", claim: "X1" },
        { id: `${p}-x2`, name: "X2", type: "fact", claim: "X2" },
        { id: `${p}-x3`, name: "X3", type: "fact", claim: "X3" },
      ]

      await seedGraph(rpId, dir, atoms, [
        { source: `${p}-x1`, target: `${p}-x2`, type: "derives" },
        { source: `${p}-x2`, target: `${p}-x3`, type: "derives" },
        { source: `${p}-x3`, target: `${p}-x1`, type: "derives" },
        { source: `${p}-x1`, target: `${p}-x3`, type: "analyzes" },
        { source: `${p}-x2`, target: `${p}-x1`, type: "analyzes" },
        { source: `${p}-x3`, target: `${p}-x2`, type: "analyzes" },
      ])

      const cache = await detectCommunities({ minCommunitySize: 2, forceRefresh: true })
      const commId = cache.atomToCommunity[`${p}-x1`]
      expect(commId).toBeDefined()

      const community = cache.communities[commId]
      // 全连接有向图：6 / (3*2) = 1.0
      expect(community.density).toBe(1.0)
    },
  })
})

// -------------------------------------------------------------------
// 4. 社区摘要和关键词生成
// -------------------------------------------------------------------
test("should generate meaningful summary and keywords", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      const atoms: SeedAtom[] = [
        { id: `${p}-s1`, name: "SGD Optimizer", type: "method", claim: "Stochastic gradient descent" },
        { id: `${p}-s2`, name: "Adam Optimizer", type: "method", claim: "Adaptive moment estimation" },
      ]

      await seedGraph(rpId, dir, atoms, [
        { source: `${p}-s1`, target: `${p}-s2`, type: "derives" },
        { source: `${p}-s2`, target: `${p}-s1`, type: "analyzes" },
      ])

      const cache = await detectCommunities({ minCommunitySize: 2, forceRefresh: true })
      const commId = cache.atomToCommunity[`${p}-s1`]
      const community = cache.communities[commId]

      // 关键词应包含 atom 名称
      expect(community.keywords.length).toBeGreaterThan(0)
      expect(community.keywords).toContain("SGD Optimizer")

      // 摘要应包含基本信息
      expect(community.summary).toContain("2 atoms")
      expect(community.summary).toContain("method")
    },
  })
})

// -------------------------------------------------------------------
// 5. queryCommunities 按自然语言查询
// -------------------------------------------------------------------
test("should query communities by natural language", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      // ML 社区
      const mlAtoms: SeedAtom[] = [
        {
          id: `${p}-ml1`,
          name: "Neural Network Training",
          type: "method",
          claim: "Deep learning neural network training optimization",
        },
        {
          id: `${p}-ml2`,
          name: "Backpropagation",
          type: "method",
          claim: "Gradient backpropagation algorithm for training",
        },
      ]
      // Bio 社区
      const bioAtoms: SeedAtom[] = [
        { id: `${p}-bio1`, name: "Gene Sequencing", type: "fact", claim: "DNA gene sequencing methodology" },
        { id: `${p}-bio2`, name: "Protein Folding", type: "fact", claim: "Protein folding structure prediction" },
      ]

      await seedGraph(
        rpId,
        dir,
        [...mlAtoms, ...bioAtoms],
        [
          { source: `${p}-ml1`, target: `${p}-ml2`, type: "derives" },
          { source: `${p}-ml2`, target: `${p}-ml1`, type: "analyzes" },
          { source: `${p}-bio1`, target: `${p}-bio2`, type: "analyzes" },
          { source: `${p}-bio2`, target: `${p}-bio1`, type: "validates" },
        ],
      )

      await detectCommunities({ minCommunitySize: 2, forceRefresh: true })

      // 查询 ML 相关
      const mlResults = await queryCommunities({ query: "neural network deep learning training", topK: 5 })
      expect(mlResults.length).toBeGreaterThan(0)
    },
  })
})

// -------------------------------------------------------------------
// 6. queryCommunities 按主导类型过滤
// -------------------------------------------------------------------
test("should filter communities by dominant atom type", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      const atoms: SeedAtom[] = [
        { id: `${p}-t1`, name: "Theorem 1", type: "theorem", claim: "Theorem" },
        { id: `${p}-t2`, name: "Theorem 2", type: "theorem", claim: "Theorem" },
      ]

      await seedGraph(rpId, dir, atoms, [
        { source: `${p}-t1`, target: `${p}-t2`, type: "validates" },
        { source: `${p}-t2`, target: `${p}-t1`, type: "formalizes" },
      ])

      await detectCommunities({ minCommunitySize: 2, forceRefresh: true })

      const results = await queryCommunities({ atomTypes: ["theorem"], topK: 10 })
      results.forEach((c) => expect(c.dominantType).toBe("theorem"))
    },
  })
})

// -------------------------------------------------------------------
// 7. getCommunityAtoms 获取社区内所有 atom IDs
// -------------------------------------------------------------------
test("should return all atom IDs in a community", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      const atoms: SeedAtom[] = [
        { id: `${p}-g1`, name: "G1", type: "method", claim: "G1" },
        { id: `${p}-g2`, name: "G2", type: "method", claim: "G2" },
        { id: `${p}-g3`, name: "G3", type: "method", claim: "G3" },
      ]

      await seedGraph(rpId, dir, atoms, [
        { source: `${p}-g1`, target: `${p}-g2`, type: "derives" },
        { source: `${p}-g2`, target: `${p}-g3`, type: "derives" },
        { source: `${p}-g3`, target: `${p}-g1`, type: "analyzes" },
      ])

      const cache = await detectCommunities({ minCommunitySize: 2, forceRefresh: true })
      const commId = cache.atomToCommunity[`${p}-g1`]
      expect(commId).toBeDefined()

      const atomIds = await getCommunityAtoms(commId)
      expect(atomIds).toContain(`${p}-g1`)
      expect(atomIds).toContain(`${p}-g2`)
      expect(atomIds).toContain(`${p}-g3`)
      expect(atomIds.length).toBe(3)
    },
  })
})

// -------------------------------------------------------------------
// 8. getCommunityAtoms 对不存在的社区返回空
// -------------------------------------------------------------------
test("should return empty array for nonexistent community", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fs.mkdir(path.join(tmp.path, "atom_list"), { recursive: true })
      const result = await getCommunityAtoms("nonexistent-community-id")
      expect(result).toEqual([])
    },
  })
})

// -------------------------------------------------------------------
// 9. minCommunitySize 过滤小社区
// -------------------------------------------------------------------
test("should filter out communities smaller than minCommunitySize", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      // 一个 3 节点社区 + 一个孤立节点
      const atoms: SeedAtom[] = [
        { id: `${p}-c1`, name: "C1", type: "method", claim: "C1" },
        { id: `${p}-c2`, name: "C2", type: "method", claim: "C2" },
        { id: `${p}-c3`, name: "C3", type: "method", claim: "C3" },
        { id: `${p}-lone`, name: "Lone", type: "fact", claim: "Lone" },
      ]

      await seedGraph(rpId, dir, atoms, [
        { source: `${p}-c1`, target: `${p}-c2`, type: "derives" },
        { source: `${p}-c2`, target: `${p}-c3`, type: "derives" },
        { source: `${p}-c3`, target: `${p}-c1`, type: "analyzes" },
        // lone 没有连接
      ])

      const cache = await detectCommunities({ minCommunitySize: 2, forceRefresh: true })

      // 孤立节点不应出现在社区映射中（因为大小 < 2）
      const allAtomIds = Object.keys(cache.atomToCommunity)
      expect(allAtomIds).not.toContain(`${p}-lone`)

      // 社区 atoms 都应 >= 2
      Object.values(cache.communities).forEach((c) => {
        expect(c.size).toBeGreaterThanOrEqual(2)
      })
    },
  })
})

// -------------------------------------------------------------------
// 10. 分辨率参数影响社区粒度
// -------------------------------------------------------------------
test("should produce different community counts with different resolution", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      // 6 个节点，形成两组松散连接
      const atoms: SeedAtom[] = Array.from({ length: 6 }, (_, i) => ({
        id: `${p}-r${i}`,
        name: `R${i}`,
        type: "method" as const,
        claim: `Claim ${i}`,
      }))

      await seedGraph(rpId, dir, atoms, [
        // 组 1 内部
        { source: `${p}-r0`, target: `${p}-r1`, type: "derives" },
        { source: `${p}-r1`, target: `${p}-r2`, type: "derives" },
        { source: `${p}-r2`, target: `${p}-r0`, type: "analyzes" },
        // 组 2 内部
        { source: `${p}-r3`, target: `${p}-r4`, type: "validates" },
        { source: `${p}-r4`, target: `${p}-r5`, type: "validates" },
        { source: `${p}-r5`, target: `${p}-r3`, type: "formalizes" },
        // 跨组弱连接
        { source: `${p}-r2`, target: `${p}-r3`, type: "other" },
      ])

      const lowRes = await detectCommunities({ resolution: 0.5, minCommunitySize: 1, forceRefresh: true })
      const highRes = await detectCommunities({ resolution: 2.0, minCommunitySize: 1, forceRefresh: true })

      const lowCount = Object.keys(lowRes.communities).length
      const highCount = Object.keys(highRes.communities).length

      // 高分辨率通常产生更多社区（或至少相同数量）
      expect(highCount).toBeGreaterThanOrEqual(lowCount)
    },
  })
})

// -------------------------------------------------------------------
// 11. 缓存持久化和加载
// -------------------------------------------------------------------
test("should persist and load community cache correctly", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      const atoms: SeedAtom[] = [
        { id: `${p}-p1`, name: "P1", type: "method", claim: "P1" },
        { id: `${p}-p2`, name: "P2", type: "method", claim: "P2" },
      ]
      await seedGraph(rpId, dir, atoms, [
        { source: `${p}-p1`, target: `${p}-p2`, type: "derives" },
        { source: `${p}-p2`, target: `${p}-p1`, type: "analyzes" },
      ])

      // 首次检测
      const original = await detectCommunities({ minCommunitySize: 1, forceRefresh: true })
      expect(original.version).toBe("1.0")

      // 从缓存加载（不 forceRefresh）
      const loaded = await detectCommunities({ minCommunitySize: 1 })

      // 应该返回缓存的版本
      expect(loaded.version).toBe(original.version)
      expect(loaded.lastUpdated).toBe(original.lastUpdated)
      expect(Object.keys(loaded.communities).length).toBe(Object.keys(original.communities).length)
    },
  })
})

// -------------------------------------------------------------------
// 12. getCommunityStats 在空图上的行为
// -------------------------------------------------------------------
test("should return zero stats when no communities detected", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fs.mkdir(path.join(tmp.path, "atom_list"), { recursive: true })

      // 没有 atom 数据，直接查询统计
      const stats = await getCommunityStats()
      expect(stats.totalCommunities).toBe(0)
      expect(stats.totalAtoms).toBe(0)
      expect(stats.avgCommunitySize).toBe(0)
      expect(stats.avgDensity).toBe(0)
    },
  })
})

// -------------------------------------------------------------------
// 13. getAtomCommunity 对不存在的 atom 返回 null
// -------------------------------------------------------------------
test("should return null for atom not in any community", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fs.mkdir(path.join(tmp.path, "atom_list"), { recursive: true })
      const result = await getAtomCommunity("nonexistent-atom-id")
      expect(result).toBeNull()
    },
  })
})
