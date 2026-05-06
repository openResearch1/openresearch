import { Database } from "../../storage/db"
import { AtomRelationTable } from "../../research/research.sql"

import { loadCommunityCache } from "./community"
import type { AtomQualityMetrics, Community, RankedAtom, TraversedAtom } from "./types"

function words(text: string) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 1),
  )
}

function score(value: number, max: number) {
  if (max <= 0) return 0
  return Math.min(value / max, 1)
}

function scoreCommunityMetrics(input: { size: number; density: number; keywordCount: number; hubRatio: number }) {
  const sizeScore = Math.min(input.size / 8, 1)
  const keywordScore = Math.min(input.keywordCount / 5, 1)
  const hubBalance = Math.max(0, 1 - input.hubRatio)
  return Number((input.density * 0.4 + sizeScore * 0.25 + keywordScore * 0.15 + hubBalance * 0.2).toFixed(4))
}

export async function scoreAtomQuality(atoms: TraversedAtom[]): Promise<Record<string, AtomQualityMetrics>> {
  const ids = new Set(atoms.map((item) => item.atom.atom_id))
  const rels = Database.use((db) => db.select().from(AtomRelationTable).all()).filter(
    (row) => ids.has(row.atom_id_source) && ids.has(row.atom_id_target),
  )

  const deg = new Map<string, number>()
  const nbr = new Map<string, Set<string>>()
  const communityDegree = new Map<string, Map<string, number>>()
  for (const row of rels) {
    deg.set(row.atom_id_source, (deg.get(row.atom_id_source) || 0) + 1)
    deg.set(row.atom_id_target, (deg.get(row.atom_id_target) || 0) + 1)

    if (!nbr.has(row.atom_id_source)) nbr.set(row.atom_id_source, new Set())
    if (!nbr.has(row.atom_id_target)) nbr.set(row.atom_id_target, new Set())
    nbr.get(row.atom_id_source)!.add(row.atom_id_target)
    nbr.get(row.atom_id_target)!.add(row.atom_id_source)
  }

  const cache = await loadCommunityCache()
  const atomToCommunity = cache?.atomToCommunity || {}
  const edges = new Map<string, number>()

  for (const row of rels) {
    const source = atomToCommunity[row.atom_id_source]
    const target = atomToCommunity[row.atom_id_target]
    if (!source || source !== target) continue
    edges.set(source, (edges.get(source) || 0) + 1)
    if (!communityDegree.has(source)) communityDegree.set(source, new Map())
    const degs = communityDegree.get(source)!
    degs.set(row.atom_id_source, (degs.get(row.atom_id_source) || 0) + 1)
    degs.set(row.atom_id_target, (degs.get(row.atom_id_target) || 0) + 1)
  }

  const communityScore = new Map<string, number>()
  for (const community of Object.values(cache?.communities || {}) as Community[]) {
    const values = Array.from((communityDegree.get(community.id) || new Map()).values())
    const totalDegree = values.reduce((sum, item) => sum + item, 0)
    const maxDegree = values.reduce((max, item) => Math.max(max, item), 0)
    const hubRatio = totalDegree > 0 ? maxDegree / totalDegree : 0
    communityScore.set(
      community.id,
      scoreCommunityMetrics({
        size: community.size,
        density: community.density,
        keywordCount: new Set(community.keywords.map((item) => item.trim()).filter(Boolean)).size,
        hubRatio,
      }),
    )
  }

  return Object.fromEntries(
    atoms.map((item) => {
      const id = item.atom.atom_id
      const communityId = atomToCommunity[id]
      const communityQuality = communityId ? (communityScore.get(communityId) ?? 0.5) : 0.5
      const neighbors = Array.from(nbr.get(id) || [])
      const bridgeCommunities = new Set(
        neighbors
          .map((neighbor) => atomToCommunity[neighbor])
          .filter((neighbor): neighbor is string => Boolean(neighbor) && neighbor !== communityId),
      ).size
      const evidenceScore =
        item.atom.atom_evidence_status === "proven" || item.atom.atom_evidence_status === "disproven"
          ? 1
          : item.atom.atom_evidence_status === "in_progress"
            ? 0.75
            : item.evidence.trim()
              ? 0.4
              : 0
      const metrics: AtomQualityMetrics = {
        degree: deg.get(id) || 0,
        degreeScore: score(deg.get(id) || 0, 6),
        bridgeCommunities,
        bridgeScore: score(bridgeCommunities, 2),
        communityScore: communityQuality,
        evidenceScore,
        informationScore: score(words(item.claim).size, 20),
        score: 0,
      }

      metrics.score = Number(
        (
          metrics.degreeScore * 0.2 +
          metrics.bridgeScore * 0.25 +
          metrics.communityScore * 0.25 +
          metrics.evidenceScore * 0.1 +
          metrics.informationScore * 0.2
        ).toFixed(4),
      )

      return [id, metrics]
    }),
  )
}

export function applyAtomQuality(
  atoms: Array<RankedAtom | (TraversedAtom & { score: number })>,
  quality: Record<string, AtomQualityMetrics>,
): RankedAtom[] {
  return atoms.map((item) => ({
    ...item,
    atomQuality: quality[item.atom.atom_id]?.score ?? 0.5,
  }))
}
