import path from "path"
import Graph from "graphology"
import louvain from "graphology-communities-louvain"
import { Database, inArray, eq } from "../../storage/db"
import { AtomTable, AtomRelationTable, ResearchProjectTable } from "../../research/research.sql"
import { Filesystem } from "../../util/filesystem"
import { Instance } from "../../project/instance"
import type { AtomType, RelationType, Community, ArticleCommunityComparisonReport } from "./types"
import { loadEmbeddingCache, getAtomEmbedding, cosineSimilarity, saveEmbeddingCache } from "./embedding"

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
  articleIds?: string[] // 限制到指定文章子图
}

export interface ArticleCommunityComparisonOptions {
  resolution?: number
  minCommunitySize?: number
  coverageThreshold?: number
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
const TYPES: AtomType[] = ["fact", "method", "theorem", "verification"]
const RELS: RelationType[] = ["motivates", "formalizes", "derives", "analyzes", "validates", "contradicts", "other"]
const EVS = ["math", "experiment"] as const
const STATS = ["pending", "in_progress", "proven", "disproven"] as const
const FLOWS = TYPES.flatMap((source) => TYPES.map((target) => `${source}->${target}`))
const MATCH = {
  semantic: 0.3,
  type: 0.2,
  evidence: 0.1,
  relation: 0.2,
  flow: 0.1,
  structure: 0.07,
  keywords: 0.03,
} as const

type Feat = {
  articleId: string
  community: Community
  emb: number[]
  type: number[]
  ev: number[]
  stat: number[]
  rel: number[]
  flow: number[]
  share: number
  mass: number
  density: number
  hub: number
  keywords: Set<string>
}

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
function loadAtoms(articleIds?: string[]) {
  const researchProjectId = getResearchProjectId()
  const atoms = researchProjectId
    ? Database.use((db) =>
        db.select().from(AtomTable).where(eq(AtomTable.research_project_id, researchProjectId)).all(),
      )
    : Database.use((db) => db.select().from(AtomTable).all())

  if (!articleIds || articleIds.length === 0) {
    return atoms
  }

  const ids = new Set(articleIds)
  return atoms.filter((atom) => atom.article_id && ids.has(atom.article_id))
}

function buildGraph(articleIds?: string[]) {
  const graph = new Graph({ type: "directed" })
  const atoms = loadAtoms(articleIds)
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

  return { graph, atoms, rels: relations.filter((rel) => atomIdSet.has(rel.atom_id_source) && atomIdSet.has(rel.atom_id_target)) }
}

async function buildCommunityCache(
  graph: Graph,
  options: Pick<Required<CommunityDetectionOptions>, "resolution" | "minCommunitySize">,
): Promise<CommunityCache> {
  if (graph.order === 0) {
    return {
      version: CACHE_VERSION,
      lastUpdated: Date.now(),
      communities: {},
      atomToCommunity: {},
    }
  }

  const assignments = louvain(graph, { resolution: options.resolution })
  const groups = new Map<string, string[]>()

  for (const [atomId, communityId] of Object.entries(assignments)) {
    const id = String(communityId)
    if (!groups.has(id)) {
      groups.set(id, [])
    }
    groups.get(id)!.push(atomId)
  }

  const communities: Record<string, Community> = {}
  const atomToCommunity: Record<string, string> = {}

  for (const [id, atomIds] of groups.entries()) {
    if (atomIds.length < options.minCommunitySize) {
      continue
    }

    const community: Community = {
      id,
      atomIds,
      summary: "",
      keywords: [],
      dominantType: getDominantType(graph, atomIds),
      size: atomIds.length,
      density: calculateCommunityDensity(graph, atomIds),
      timestamp: Date.now(),
    }

    const meta = await generateCommunitySummary(atomIds)
    community.summary = meta.summary
    community.keywords = meta.keywords
    communities[id] = community

    for (const atomId of atomIds) {
      atomToCommunity[atomId] = id
    }
  }

  return {
    version: CACHE_VERSION,
    lastUpdated: Date.now(),
    communities,
    atomToCommunity,
  }
}

/**
 * 使用 Louvain 算法检测社区
 */
export async function detectCommunities(options: CommunityDetectionOptions = {}): Promise<CommunityCache> {
  const { resolution = 1.0, minCommunitySize = 2, forceRefresh = false, articleIds } = options

  // 检查缓存
  if (!forceRefresh && (!articleIds || articleIds.length === 0)) {
    const cached = await loadCommunityCache()
    if (cached) {
      return cached
    }
  }

  // 构建图
  const { graph } = buildGraph(articleIds)
  const cache = await buildCommunityCache(graph, { resolution, minCommunitySize })

  if (!articleIds || articleIds.length === 0) {
    await saveCommunityCache(cache)
  }

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

function fixed(value: number) {
  return Number(value.toFixed(4))
}

function clamp(value: number) {
  if (value < 0) return 0
  if (value > 1) return 1
  return fixed(value)
}

function avg(items: number[]) {
  if (items.length === 0) return 0
  return fixed(items.reduce((sum, item) => sum + item, 0) / items.length)
}

function center(items: number[][]) {
  if (items.length === 0) return []
  const dim = items[0]?.length ?? 0
  return Array.from({ length: dim }, (_, idx) => avg(items.map((item) => item[idx] ?? 0)))
}

function hist(items: string[], keys: string[]) {
  const total = items.length
  const counts = new Map(keys.map((key) => [key, 0]))

  for (const item of items) {
    counts.set(item, (counts.get(item) || 0) + 1)
  }

  return keys.map((key) => (total > 0 ? (counts.get(key) || 0) / total : 0))
}

function hub(rels: Array<{ atom_id_source: string; atom_id_target: string }>) {
  const degree = new Map<string, number>()

  for (const rel of rels) {
    degree.set(rel.atom_id_source, (degree.get(rel.atom_id_source) || 0) + 1)
    degree.set(rel.atom_id_target, (degree.get(rel.atom_id_target) || 0) + 1)
  }

  const vals = Array.from(degree.values())
  const total = vals.reduce((sum, item) => sum + item, 0)
  const top = vals.reduce((max, item) => Math.max(max, item), 0)
  return total > 0 ? top / total : 0
}

function keys(items: string[]) {
  return new Set(items.map((item) => item.trim().toLowerCase()).filter(Boolean))
}

function jaccard(left: Set<string>, right: Set<string>) {
  if (left.size === 0 && right.size === 0) return 1
  const overlap = Array.from(left).filter((item) => right.has(item)).length
  const union = new Set([...left, ...right]).size
  return union > 0 ? overlap / union : 0
}

function kl(left: number[], right: number[]) {
  let score = 0

  for (let i = 0; i < left.length; i++) {
    if (left[i] === 0 || right[i] === 0) continue
    score += left[i] * Math.log2(left[i] / right[i])
  }

  return score
}

function dist(left: number[], right: number[]) {
  const l = left.reduce((sum, item) => sum + item, 0)
  const r = right.reduce((sum, item) => sum + item, 0)

  if (l === 0 && r === 0) return 1
  if (l === 0 || r === 0) return 0

  const a = left.map((item) => item / l)
  const b = right.map((item) => item / r)
  const mid = a.map((item, idx) => (item + b[idx]) / 2)
  return clamp(1 - (kl(a, mid) + kl(b, mid)) / 2)
}

function sim(left: number[], right: number[]) {
  if (left.length === 0 || right.length === 0) return 0
  if (left.length !== right.length) return 0
  return clamp(cosineSimilarity(left, right))
}

function read(file: string | null) {
  if (!file) return Promise.resolve("")
  return Filesystem.exists(file).then((exists) => {
    if (!exists) return ""
    return Filesystem.readText(file).then((text) => text.trim())
  })
}

async function inspect(
  articleId: string,
  options: Pick<Required<ArticleCommunityComparisonOptions>, "resolution" | "minCommunitySize">,
  cache: Awaited<ReturnType<typeof loadEmbeddingCache>>,
) {
  const { graph, atoms, rels } = buildGraph([articleId])
  const communities = await buildCommunityCache(graph, options)
  const rows = new Map(atoms.map((atom) => [atom.atom_id, atom]))
  const base = atoms.length || 1
  const kept = Object.values(communities.communities)
  const total = kept.reduce((sum, community) => sum + community.size, 0) || 1

  const items = await Promise.all(
    kept.map(async (community) => {
      const ids = new Set(community.atomIds)
      const members = community.atomIds.flatMap((id) => {
        const row = rows.get(id)
        return row ? [row] : []
      })
      const inner = rels.filter((rel) => ids.has(rel.atom_id_source) && ids.has(rel.atom_id_target))
      const embs = await Promise.all(
        members.map(async (atom) => getAtomEmbedding(atom.atom_id, (await read(atom.atom_claim_path)) || atom.atom_name, cache)),
      )

      return {
        articleId,
        community,
        emb: center(embs),
        type: hist(
          members.map((atom) => atom.atom_type),
          TYPES,
        ),
        ev: hist(
          members.map((atom) => atom.atom_evidence_type),
          [...EVS],
        ),
        stat: hist(
          members.map((atom) => atom.atom_evidence_status),
          [...STATS],
        ),
        rel: hist(
          inner.map((rel) => rel.relation_type),
          RELS,
        ),
        flow: hist(
          inner.flatMap((rel) => {
            const source = rows.get(rel.atom_id_source)
            const target = rows.get(rel.atom_id_target)
            return source && target ? [`${source.atom_type}->${target.atom_type}`] : []
          }),
          FLOWS,
        ),
        share: community.size / base,
        mass: community.size / total,
        density: community.density,
        hub: hub(inner),
        keywords: keys(community.keywords),
      } satisfies Feat
    }),
  )

  return { atoms, communities: kept, items }
}

function pair(left: Feat, right: Feat) {
  const semantic = sim(left.emb, right.emb)
  const type = dist(left.type, right.type)
  const evidence = avg([dist(left.ev, right.ev), dist(left.stat, right.stat)])
  const relation = dist(left.rel, right.rel)
  const flow = dist(left.flow, right.flow)
  const structure = avg([
    left.share > 0 && right.share > 0 ? Math.min(left.share, right.share) / Math.max(left.share, right.share) : 1,
    clamp(1 - Math.abs(left.density - right.density)),
    clamp(1 - Math.abs(left.hub - right.hub)),
  ])
  const keywords = clamp(jaccard(left.keywords, right.keywords))
  const score = fixed(
    semantic * MATCH.semantic +
      type * MATCH.type +
      evidence * MATCH.evidence +
      relation * MATCH.relation +
      flow * MATCH.flow +
      structure * MATCH.structure +
      keywords * MATCH.keywords,
  )

  return {
    semantic,
    type,
    evidence,
    relation,
    flow,
    structure,
    keywords,
    score,
  }
}

function match(source: Feat[], target: Feat[], threshold: number) {
  if (source.length === 0) {
    return { articleId: "", score: 0, coverage: 0, matches: [] }
  }

  const articleId = source[0].articleId
  if (target.length === 0) {
    return {
      articleId,
      score: 0,
      coverage: 0,
      matches: source.map((item) => ({
        sourceCommunityId: item.community.id,
        targetCommunityId: null,
        sourceSize: item.community.size,
        targetSize: null,
        sourceWeight: fixed(item.mass),
        targetWeight: null,
        score: 0,
        breakdown: {
          semantic: 0,
          type: 0,
          evidence: 0,
          relation: 0,
          flow: 0,
          structure: 0,
          keywords: 0,
        },
      })),
    }
  }

  const matches = source.map((item) => {
    const best = target
      .map((other) => ({ other, score: pair(item, other) }))
      .sort((a, b) => b.score.score - a.score.score)[0]

    return {
      sourceCommunityId: item.community.id,
      targetCommunityId: best.other.community.id,
      sourceSize: item.community.size,
      targetSize: best.other.community.size,
      sourceWeight: fixed(item.mass),
      targetWeight: fixed(best.other.mass),
      score: best.score.score,
      breakdown: {
        semantic: best.score.semantic,
        type: best.score.type,
        evidence: best.score.evidence,
        relation: best.score.relation,
        flow: best.score.flow,
        structure: best.score.structure,
        keywords: best.score.keywords,
      },
    }
  })

  const score = fixed(
    matches.reduce((sum, item) => {
      const sourceWeight = source.find((feat) => feat.community.id === item.sourceCommunityId)?.mass || 0
      return sum + sourceWeight * item.score
    }, 0),
  )
  const coverage = fixed(
    matches.reduce((sum, item) => {
      const sourceWeight = source.find((feat) => feat.community.id === item.sourceCommunityId)?.mass || 0
      return sum + (item.score >= threshold ? sourceWeight : 0)
    }, 0),
  )

  return {
    articleId,
    score,
    coverage,
    matches: matches.sort((a, b) => b.score - a.score),
  }
}

export async function compareArticleCommunities(
  leftId: string,
  rightId: string,
  options: ArticleCommunityComparisonOptions = {},
): Promise<ArticleCommunityComparisonReport> {
  const resolution = options.resolution ?? 1
  const minCommunitySize = options.minCommunitySize ?? 1
  const threshold = options.coverageThreshold ?? 0.6
  const cache = await loadEmbeddingCache()
  const [left, right] = await Promise.all([
    inspect(leftId, { resolution, minCommunitySize }, cache),
    inspect(rightId, { resolution, minCommunitySize }, cache),
  ])
  await saveEmbeddingCache(cache)

  const leftToRight = match(left.items, right.items, threshold)
  const rightToLeft = match(right.items, left.items, threshold)
  leftToRight.articleId = leftId
  rightToLeft.articleId = rightId

  return {
    articleIds: [leftId, rightId],
    similarity: fixed((leftToRight.score + rightToLeft.score) / 2),
    threshold: fixed(threshold),
    articles: {
      left: {
        articleId: leftId,
        atomCount: left.atoms.length,
        communityCount: left.communities.length,
      },
      right: {
        articleId: rightId,
        atomCount: right.atoms.length,
        communityCount: right.communities.length,
      },
    },
    communities: {
      left: left.communities,
      right: right.communities,
    },
    directional: {
      leftToRight,
      rightToLeft,
    },
  }
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
