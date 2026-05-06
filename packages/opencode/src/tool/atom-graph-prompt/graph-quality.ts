import { AtomRelationTable, AtomTable, ResearchProjectTable } from "../../research/research.sql"
import { Database, eq } from "../../storage/db"
import { Instance } from "../../project/instance"
import { Filesystem } from "../../util/filesystem"

import { detectCommunities, loadCommunityCache } from "./community"
import { DEFAULT_PRUNE_OPTIONS, pruneCommunities } from "./community-prune"
import { cosineSimilarity, getAtomEmbedding, loadEmbeddingCache, saveEmbeddingCache } from "./embedding"
import type { CommunityPruneOptions, GraphQualityReport } from "./types"

export interface GraphQualityOptions {
  forceRefresh?: boolean
  prune?: CommunityPruneOptions
}

function fixed(value: number) {
  return Number(value.toFixed(4))
}

function avg(items: number[]) {
  if (items.length === 0) return 0
  return fixed(items.reduce((sum, item) => sum + item, 0) / items.length)
}

function ratio(part: number, total: number) {
  if (total <= 0) return 0
  return fixed(part / total)
}

function clamp(value: number) {
  if (value < 0) return 0
  if (value > 1) return 1
  return fixed(value)
}

function sim(left: number[], right: number[]) {
  return clamp(cosineSimilarity(left, right))
}

function center(items: number[][]) {
  if (items.length === 0) return []
  const dim = items[0]?.length ?? 0
  return Array.from({ length: dim }, (_, idx) => avg(items.map((item) => item[idx] ?? 0)))
}

function zero(): GraphQualityReport {
  return {
    structure: {
      totalCommunities: 0,
      avgCommunitySize: 0,
      avgDensity: 0,
      isolatedAtomRatio: 0,
      bridgeAtomRatio: 0,
    },
    semantic: {
      intraCommunitySimilarity: 0,
      interCommunitySeparation: 0,
      summaryCoherence: 0,
      keywordUniqueness: 0,
    },
    research: {
      typeCoverage: 0,
      evidenceCoverage: 0,
      verificationCoverage: 0,
      contradictionExposure: 0,
    },
    stability: {
      pruneRetentionRatio: 0,
      relationSuggestionConfidence: 0,
      extensionSuggestionConfidence: 0,
    },
  }
}

function project() {
  return Database.use((db) =>
    db
      .select({ id: ResearchProjectTable.research_project_id })
      .from(ResearchProjectTable)
      .where(eq(ResearchProjectTable.project_id, Instance.project.id))
      .get(),
  )?.id
}

async function text(file: string | null) {
  if (!file) return ""
  if (!(await Filesystem.exists(file))) return ""
  return (await Filesystem.readText(file)).trim()
}

export async function evaluateGraphQuality(options: GraphQualityOptions = {}): Promise<GraphQualityReport> {
  const id = project()
  const atoms = id
    ? Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.research_project_id, id)).all())
    : Database.use((db) => db.select().from(AtomTable).all())

  if (atoms.length === 0) {
    return zero()
  }

  const ids = new Set(atoms.map((item) => item.atom_id))
  const rels = Database.use((db) => db.select().from(AtomRelationTable).all()).filter(
    (row) => ids.has(row.atom_id_source) && ids.has(row.atom_id_target),
  )

  const claims = new Map(await Promise.all(atoms.map(async (item) => [item.atom_id, await text(item.atom_claim_path)] as const)))
  const evidence = new Map(
    await Promise.all(atoms.map(async (item) => [item.atom_id, await text(item.atom_evidence_path)] as const)),
  )

  let cache = await loadCommunityCache()
  if (!cache || options.forceRefresh) {
    cache = await detectCommunities({ forceRefresh: options.forceRefresh })
  }

  const communities = Object.values(cache.communities)
  const nbr = new Map<string, Set<string>>()
  for (const atom of atoms) {
    nbr.set(atom.atom_id, new Set())
  }
  for (const row of rels) {
    nbr.get(row.atom_id_source)?.add(row.atom_id_target)
    nbr.get(row.atom_id_target)?.add(row.atom_id_source)
  }

  const isolated = atoms.filter((item) => (nbr.get(item.atom_id)?.size ?? 0) === 0).length
  const bridge = atoms.filter((item) => {
    const own = cache.atomToCommunity[item.atom_id]
    const seen = new Set(
      Array.from(nbr.get(item.atom_id) || [])
        .map((id) => cache.atomToCommunity[id])
        .filter((id): id is string => Boolean(id)),
    )
    if (!own) return seen.size > 1
    return Array.from(seen).some((id) => id !== own)
  }).length

  const ec = await loadEmbeddingCache()
  const aemb = new Map<string, number[]>()
  for (const atom of atoms) {
    aemb.set(atom.atom_id, await getAtomEmbedding(atom.atom_id, claims.get(atom.atom_id) || atom.atom_name, ec))
  }

  const cemb = new Map<string, number[]>()
  for (const community of communities) {
    cemb.set(
      community.id,
      await getAtomEmbedding(`community:${community.id}`, `${community.summary} ${community.keywords.join(" ")}`, ec),
    )
  }
  await saveEmbeddingCache(ec)

  const intra = communities.map((community) => {
    const items = community.atomIds.map((id) => aemb.get(id)).filter((item): item is number[] => Boolean(item))
    const vals: number[] = []
    for (let left = 0; left < items.length; left++) {
      for (let right = left + 1; right < items.length; right++) {
        vals.push(sim(items[left], items[right]))
      }
    }
    return avg(vals)
  })

  const coherence = communities.map((community) => {
    const items = community.atomIds.map((id) => aemb.get(id)).filter((item): item is number[] => Boolean(item))
    const emb = cemb.get(community.id)
    if (!emb || items.length === 0) return 0
    return sim(emb, center(items))
  })

  const sep: number[] = []
  for (let left = 0; left < communities.length; left++) {
    for (let right = left + 1; right < communities.length; right++) {
      const l = cemb.get(communities[left].id)
      const r = cemb.get(communities[right].id)
      if (!l || !r) continue
      sep.push(fixed(1 - sim(l, r)))
    }
  }

  const words = communities.flatMap((community) => community.keywords.map((item) => item.trim()).filter(Boolean))
  const types = new Set(atoms.map((item) => item.atom_type)).size
  const evidenceCount = atoms.filter(
    (item) => item.atom_evidence_status !== "pending" || Boolean(evidence.get(item.atom_id)?.trim()),
  ).length
  const verification = atoms.filter((item) => item.atom_type === "verification").length
  const contradictions = rels.filter((item) => item.relation_type === "contradicts").length

  const prune = await pruneCommunities({
    ...DEFAULT_PRUNE_OPTIONS,
    ...options.prune,
    forceRefresh: options.forceRefresh || options.prune?.forceRefresh,
  })

  return {
    structure: {
      totalCommunities: communities.length,
      avgCommunitySize: avg(communities.map((item) => item.size)),
      avgDensity: avg(communities.map((item) => item.density)),
      isolatedAtomRatio: ratio(isolated, atoms.length),
      bridgeAtomRatio: ratio(bridge, atoms.length),
    },
    semantic: {
      intraCommunitySimilarity: avg(intra),
      interCommunitySeparation: avg(sep),
      summaryCoherence: avg(coherence),
      keywordUniqueness: ratio(new Set(words).size, words.length),
    },
    research: {
      typeCoverage: ratio(types, 4),
      evidenceCoverage: ratio(evidenceCount, atoms.length),
      verificationCoverage: ratio(verification, atoms.length),
      contradictionExposure: ratio(contradictions, rels.length),
    },
    stability: {
      pruneRetentionRatio: ratio(new Set(prune.kept.flatMap((item) => item.atomIds)).size, atoms.length),
      relationSuggestionConfidence: 0,
      extensionSuggestionConfidence: 0,
    },
  }
}
