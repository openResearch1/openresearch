import path from "path"
import Graph from "graphology"
import louvain from "graphology-communities-louvain"
import { Database, inArray, eq } from "../../storage/db"
import { AtomTable, AtomRelationTable, ResearchProjectTable } from "../../research/research.sql"
import { Filesystem } from "../../util/filesystem"
import { Instance } from "../../project/instance"
import type { AtomType, RelationType, Community } from "./types"
import { loadEmbeddingCache, getAtomEmbedding, cosineSimilarity } from "./embedding"

/**
 * 社区缓存结构
 */
export interface CommunityCache {
  version: string
  lastUpdated: number
  communities: Record<string, Community>
  atomToCommunity: Record<string, string>
}

/**
 * 社区检测选项
 */
export interface CommunityDetectionOptions {
  resolution?: number // Louvain 分辨率参数
  minCommunitySize?: number // 最小社区大小
  forceRefresh?: boolean // 强制刷新缓存
}

/**
 * 社区查询选项
 */
export interface CommunityQueryOptions {
  query?: string // 自然语言查询
  atomTypes?: AtomType[]
  minSize?: number
  maxSize?: number
  topK?: number
}

const CACHE_FILE = ".atom-communities-cache.json"
const CACHE_VERSION = "1.0"

/**
 * 获取缓存文件路径
 */
function getCachePath(): string {
  return path.join(Instance.directory, "atom_list", CACHE_FILE)
}

/**
 * 加载社区缓存
 */
export async function loadCommunityCache(): Promise<CommunityCache | null> {
  const cachePath = getCachePath()

  try {
    if (await Filesystem.exists(cachePath)) {
      const content = await Filesystem.readText(cachePath)
      const cache = JSON.parse(content) as CommunityCache

      if (cache.version === CACHE_VERSION) {
        return cache
      }
    }
  } catch (error) {
    console.warn("Failed to load community cache:", error)
  }

  return null
}

/**
 * 保存社区缓存
 */
export async function saveCommunityCache(cache: CommunityCache): Promise<void> {
  const cachePath = getCachePath()

  try {
    await Filesystem.write(cachePath, JSON.stringify(cache, null, 2))
  } catch (error) {
    console.warn("Failed to save community cache:", error)
  }
}

/**
 * 获取当前项目的 research_project_id
 */
function getResearchProjectId(): string | undefined {
  const projectId = Instance.project.id
  const research = Database.use((db) =>
    db
      .select({ research_project_id: ResearchProjectTable.research_project_id })
      .from(ResearchProjectTable)
      .where(eq(ResearchProjectTable.project_id, projectId))
      .get(),
  )
  return research?.research_project_id
}

/**
 * 构建 Atom Graph（只包含当前项目的 atoms）
 */
function buildGraph(): Graph {
  const graph = new Graph({ type: "directed" })

  const researchProjectId = getResearchProjectId()

  // 添加当前项目的 atoms 作为节点
  const atoms = researchProjectId
    ? Database.use((db) =>
        db.select().from(AtomTable).where(eq(AtomTable.research_project_id, researchProjectId)).all(),
      )
    : Database.use((db) => db.select().from(AtomTable).all())

  const atomIdSet = new Set(atoms.map((a) => a.atom_id))

  for (const atom of atoms) {
    graph.addNode(atom.atom_id, {
      name: atom.atom_name,
      type: atom.atom_type,
      created: atom.time_created,
    })
  }

  // 添加关系作为边（只包含两端都在当前项目内的关系）
  const relations = Database.use((db) => db.select().from(AtomRelationTable).all())

  for (const rel of relations) {
    if (atomIdSet.has(rel.atom_id_source) && atomIdSet.has(rel.atom_id_target)) {
      try {
        graph.addEdge(rel.atom_id_source, rel.atom_id_target, {
          type: rel.relation_type,
        })
      } catch (error) {
        // 边可能已存在，忽略
      }
    }
  }

  return graph
}

/**
 * 使用 Louvain 算法检测社区
 */
export async function detectCommunities(options: CommunityDetectionOptions = {}): Promise<CommunityCache> {
  const { resolution = 1.0, minCommunitySize = 2, forceRefresh = false } = options

  // 检查缓存
  if (!forceRefresh) {
    const cached = await loadCommunityCache()
    if (cached) {
      return cached
    }
  }

  // 构建图
  const graph = buildGraph()

  // 运行 Louvain 算法
  const assignments = louvain(graph, { resolution })

  // 按社区分组 atoms
  const communityGroups = new Map<string, string[]>()

  for (const [atomId, communityId] of Object.entries(assignments)) {
    const commId = String(communityId)
    if (!communityGroups.has(commId)) {
      communityGroups.set(commId, [])
    }
    communityGroups.get(commId)!.push(atomId)
  }

  // 过滤小社区并生成社区信息
  const communities: Record<string, Community> = {}
  const atomToCommunity: Record<string, string> = {}

  for (const [commId, atomIds] of communityGroups.entries()) {
    if (atomIds.length < minCommunitySize) {
      continue
    }

    // 计算社区密度
    const density = calculateCommunityDensity(graph, atomIds)

    // 确定主导类型
    const dominantType = getDominantType(graph, atomIds)

    // 生成摘要和关键词
    const { summary, keywords } = await generateCommunitySummary(atomIds)

    const community: Community = {
      id: commId,
      atomIds,
      summary,
      keywords,
      dominantType,
      size: atomIds.length,
      density,
      timestamp: Date.now(),
    }

    communities[commId] = community

    // 建立 atom 到社区的映射
    for (const atomId of atomIds) {
      atomToCommunity[atomId] = commId
    }
  }

  const cache: CommunityCache = {
    version: CACHE_VERSION,
    lastUpdated: Date.now(),
    communities,
    atomToCommunity,
  }

  await saveCommunityCache(cache)

  return cache
}

/**
 * 计算社区密度
 */
function calculateCommunityDensity(graph: Graph, atomIds: string[]): number {
  if (atomIds.length < 2) return 0

  let internalEdges = 0
  const maxEdges = atomIds.length * (atomIds.length - 1)

  for (const source of atomIds) {
    for (const target of atomIds) {
      if (source !== target && graph.hasEdge(source, target)) {
        internalEdges++
      }
    }
  }

  return maxEdges > 0 ? internalEdges / maxEdges : 0
}

/**
 * 获取社区的主导 Atom 类型
 */
function getDominantType(graph: Graph, atomIds: string[]): AtomType {
  const typeCounts = new Map<AtomType, number>()

  for (const atomId of atomIds) {
    const attrs = graph.getNodeAttributes(atomId)
    const type = attrs.type as AtomType
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1)
  }

  let maxCount = 0
  let dominantType: AtomType = "fact"

  for (const [type, count] of typeCounts.entries()) {
    if (count > maxCount) {
      maxCount = count
      dominantType = type
    }
  }

  return dominantType
}

/**
 * 生成社区摘要和关键词
 */
async function generateCommunitySummary(atomIds: string[]): Promise<{ summary: string; keywords: string[] }> {
  // 获取所有 atoms 的信息
  const atoms = Database.use((db) => db.select().from(AtomTable).where(inArray(AtomTable.atom_id, atomIds)).all())

  // 收集所有 atom 名称作为关键词
  const keywords = atoms.map((a) => a.atom_name).slice(0, 5)

  // 读取 claims 生成摘要
  const claims: string[] = []

  for (const atom of atoms.slice(0, 3)) {
    // 只读取前3个
    try {
      if (atom.atom_claim_path) {
        const claim = await Filesystem.readText(atom.atom_claim_path)
        claims.push(claim.substring(0, 200))
      }
    } catch (error) {
      // 忽略读取失败
    }
  }

  // 生成简单摘要
  const typeCount = new Map<string, number>()
  for (const atom of atoms) {
    typeCount.set(atom.atom_type, (typeCount.get(atom.atom_type) || 0) + 1)
  }

  const typeDesc = Array.from(typeCount.entries())
    .map(([type, count]) => `${count} ${type}${count > 1 ? "s" : ""}`)
    .join(", ")

  const summary = `Community of ${atoms.length} atoms (${typeDesc}). Key topics: ${keywords.slice(0, 3).join(", ")}.`

  return { summary, keywords }
}

/**
 * 按社区查询
 */
export async function queryCommunities(options: CommunityQueryOptions = {}): Promise<Community[]> {
  const { query, atomTypes, minSize, maxSize, topK = 10 } = options

  // 加载或检测社区
  let cache = await loadCommunityCache()
  if (!cache) {
    cache = await detectCommunities()
  }

  let communities = Object.values(cache.communities)

  // 应用过滤器
  if (atomTypes && atomTypes.length > 0) {
    communities = communities.filter((c) => atomTypes.includes(c.dominantType))
  }

  if (minSize !== undefined) {
    communities = communities.filter((c) => c.size >= minSize)
  }

  if (maxSize !== undefined) {
    communities = communities.filter((c) => c.size <= maxSize)
  }

  // 如果有查询，进行语义搜索
  if (query) {
    const embeddingCache = await loadEmbeddingCache()
    const queryEmbedding = await getAtomEmbedding("query", query, embeddingCache)

    // 为每个社区计算相似度
    const scored = await Promise.all(
      communities.map(async (community) => {
        // 使用摘要和关键词计算相似度
        const text = `${community.summary} ${community.keywords.join(" ")}`
        const commEmbedding = await getAtomEmbedding(community.id, text, embeddingCache)
        const similarity = cosineSimilarity(queryEmbedding, commEmbedding)

        return { community, similarity }
      }),
    )

    // 按相似度排序
    scored.sort((a, b) => b.similarity - a.similarity)

    return scored.slice(0, topK).map((s) => s.community)
  }

  // 按大小排序
  communities.sort((a, b) => b.size - a.size)

  return communities.slice(0, topK)
}

/**
 * 获取 atom 所属的社区
 */
export async function getAtomCommunity(atomId: string): Promise<Community | null> {
  const cache = await loadCommunityCache()
  if (!cache) {
    return null
  }

  const communityId = cache.atomToCommunity[atomId]
  if (!communityId) {
    return null
  }

  return cache.communities[communityId] || null
}

/**
 * 获取社区内的所有 atoms
 */
export async function getCommunityAtoms(communityId: string): Promise<string[]> {
  const cache = await loadCommunityCache()
  if (!cache) {
    return []
  }

  const community = cache.communities[communityId]
  return community ? community.atomIds : []
}

/**
 * 获取社区统计信息
 */
export async function getCommunityStats(): Promise<{
  totalCommunities: number
  totalAtoms: number
  avgCommunitySize: number
  largestCommunity: number
  smallestCommunity: number
  avgDensity: number
}> {
  const cache = await loadCommunityCache()
  if (!cache) {
    return {
      totalCommunities: 0,
      totalAtoms: 0,
      avgCommunitySize: 0,
      largestCommunity: 0,
      smallestCommunity: 0,
      avgDensity: 0,
    }
  }

  const communities = Object.values(cache.communities)

  if (communities.length === 0) {
    return {
      totalCommunities: 0,
      totalAtoms: 0,
      avgCommunitySize: 0,
      largestCommunity: 0,
      smallestCommunity: 0,
      avgDensity: 0,
    }
  }

  const sizes = communities.map((c) => c.size)
  const densities = communities.map((c) => c.density)

  return {
    totalCommunities: communities.length,
    totalAtoms: Object.keys(cache.atomToCommunity).length,
    avgCommunitySize: sizes.reduce((a, b) => a + b, 0) / sizes.length,
    largestCommunity: Math.max(...sizes),
    smallestCommunity: Math.min(...sizes),
    avgDensity: densities.reduce((a, b) => a + b, 0) / densities.length,
  }
}

/**
 * 刷新社区缓存
 */
export async function refreshCommunities(options: CommunityDetectionOptions = {}): Promise<CommunityCache> {
  return detectCommunities({ ...options, forceRefresh: true })
}
