import { Database } from "../../storage/db"
import { AtomRelationTable } from "../../research/research.sql"
import { detectCommunities, loadCommunityCache } from "./community"
import type {
  CommunityPruneMetrics,
  CommunityPruneOptions,
  CommunityPruneResult,
  CommunityPruneSummary,
  PrunedCommunity,
} from "./types"

export const DEFAULT_PRUNE_OPTIONS: Required<CommunityPruneOptions> = {
  minSize: 5,
  minDensity: 0.05,
  minInternalEdges: 4,
  minKeywords: 3,
  maxHubRatio: 0.65,
  forceRefresh: false,
}

function metrics(cache: Awaited<ReturnType<typeof detectCommunities>>, atomIds: Set<string>) {
  const rels = Database.use((db) => db.select().from(AtomRelationTable).all()).filter(
    (row) => atomIds.has(row.atom_id_source) && atomIds.has(row.atom_id_target),
  )

  const edges = new Map<string, number>()
  const degree = new Map<string, Map<string, number>>()

  for (const row of rels) {
    const source = cache.atomToCommunity[row.atom_id_source]
    const target = cache.atomToCommunity[row.atom_id_target]
    if (!source || source !== target) continue

    edges.set(source, (edges.get(source) || 0) + 1)

    if (!degree.has(source)) degree.set(source, new Map())
    const counts = degree.get(source)!
    counts.set(row.atom_id_source, (counts.get(row.atom_id_source) || 0) + 1)
    counts.set(row.atom_id_target, (counts.get(row.atom_id_target) || 0) + 1)
  }

  return { edges, degree }
}

function inspect(
  community: PrunedCommunity["community"],
  options: CommunityPruneOptions,
  edgeCount: number,
  degree: Map<string, number>,
): PrunedCommunity {
  const maxEdges = community.size * Math.max(community.size - 1, 0)
  const keywordCount = new Set(community.keywords.map((item) => item.trim()).filter(Boolean)).size
  const values = Array.from(degree.values())
  const totalDegree = values.reduce((sum, item) => sum + item, 0)
  const maxDegree = values.reduce((max, item) => Math.max(max, item), 0)
  const hubRatio = totalDegree > 0 ? maxDegree / totalDegree : 0

  const stats: CommunityPruneMetrics = {
    size: community.size,
    density: community.density,
    internalEdges: edgeCount,
    maxEdges,
    keywordCount,
    hubRatio,
  }

  const reasons: string[] = []

  if (options.minSize !== undefined && stats.size < options.minSize) {
    reasons.push(`size ${stats.size} < ${options.minSize}`)
  }
  if (options.minDensity !== undefined && stats.density < options.minDensity) {
    reasons.push(`density ${stats.density.toFixed(3)} < ${options.minDensity}`)
  }
  if (options.minInternalEdges !== undefined && stats.internalEdges < options.minInternalEdges) {
    reasons.push(`internalEdges ${stats.internalEdges} < ${options.minInternalEdges}`)
  }
  if (options.minKeywords !== undefined && stats.keywordCount < options.minKeywords) {
    reasons.push(`keywordCount ${stats.keywordCount} < ${options.minKeywords}`)
  }
  if (options.maxHubRatio !== undefined && stats.hubRatio > options.maxHubRatio) {
    reasons.push(`hubRatio ${stats.hubRatio.toFixed(3)} > ${options.maxHubRatio}`)
  }

  return {
    community,
    pruned: reasons.length > 0,
    reasons,
    metrics: stats,
  }
}

export async function pruneCommunities(
  options: CommunityPruneOptions = DEFAULT_PRUNE_OPTIONS,
): Promise<CommunityPruneResult> {
  let cache = await loadCommunityCache()
  if (!cache || options.forceRefresh) {
    cache = await detectCommunities({ forceRefresh: options.forceRefresh })
  }

  const atomIds = new Set(Object.keys(cache.atomToCommunity))
  const graph = metrics(cache, atomIds)
  const decisions = Object.values(cache.communities).map((community) =>
    inspect(community, options, graph.edges.get(community.id) || 0, graph.degree.get(community.id) || new Map()),
  )

  return {
    kept: decisions.filter((item) => !item.pruned).map((item) => item.community),
    removed: decisions.filter((item) => item.pruned),
    decisions,
  }
}

export function scoreCommunity(decision: Pick<PrunedCommunity, "community" | "metrics">): number {
  const sizeScore = Math.min(decision.metrics.size / 8, 1)
  const keywordScore = Math.min(decision.metrics.keywordCount / 5, 1)
  const hubBalance = Math.max(0, 1 - decision.metrics.hubRatio)
  const score = decision.metrics.density * 0.4 + sizeScore * 0.25 + keywordScore * 0.15 + hubBalance * 0.2

  return Number((score * 100).toFixed(2))
}

export function summarizePruning(result: CommunityPruneResult): CommunityPruneSummary {
  const uniq = (items: string[][]) => new Set(items.flat()).size
  const before = result.decisions.map(scoreCommunity)
  const after = result.decisions.filter((item) => !item.pruned).map(scoreCommunity)

  return {
    beforeNodes: uniq(result.decisions.map((item) => item.community.atomIds)),
    afterNodes: uniq(result.kept.map((item) => item.atomIds)),
    beforeCommunities: result.decisions.length,
    afterCommunities: result.kept.length,
    beforeScore:
      before.length > 0 ? Number((before.reduce((sum, item) => sum + item, 0) / before.length).toFixed(2)) : 0,
    afterScore: after.length > 0 ? Number((after.reduce((sum, item) => sum + item, 0) / after.length).toFixed(2)) : 0,
  }
}
