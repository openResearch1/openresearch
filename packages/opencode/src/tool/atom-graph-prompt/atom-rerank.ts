import type { AtomwiseOptions, RankedAtom } from "./types"

export const ATOMWISE_PRESETS = {
  mild: {
    enabled: true,
    baseWeight: 0.6,
    qualityWeight: 0.25,
    overlapWeight: 0.15,
  },
  medium: {
    enabled: true,
    baseWeight: 0.55,
    qualityWeight: 0.3,
    overlapWeight: 0.15,
  },
  aggressive: {
    enabled: true,
    baseWeight: 0.45,
    qualityWeight: 0.4,
    overlapWeight: 0.15,
  },
} as const satisfies Record<string, Required<AtomwiseOptions>>

export const DEFAULT_ATOMWISE_OPTIONS = ATOMWISE_PRESETS.mild

function terms(text: string) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 1),
  )
}

function overlap(query: string, claim: string) {
  const a = terms(query)
  const b = terms(claim)
  if (a.size === 0 || b.size === 0) return 0
  let hits = 0
  for (const item of a) {
    if (b.has(item)) hits++
  }
  return hits / a.size
}

export function rerankAtoms(atoms: RankedAtom[], query?: string, input: AtomwiseOptions = DEFAULT_ATOMWISE_OPTIONS) {
  if (atoms.length === 0) return { kept: atoms, removed: 0 }

  const opts = {
    ...DEFAULT_ATOMWISE_OPTIONS,
    ...input,
  }

  const max = atoms.reduce((score, item) => Math.max(score, item.score), 0) || 1
  const reranked = atoms.map((item) => {
    const base = item.score / max
    const atomQuality = item.atomQuality ?? 0.5
    const queryOverlap = query ? overlap(query, item.claim) : 0
    const score = Number(
      (base * opts.baseWeight + atomQuality * opts.qualityWeight + queryOverlap * opts.overlapWeight).toFixed(4),
    )

    return {
      ...item,
      baseScore: item.score,
      atomQuality,
      queryOverlap,
      score,
    }
  })

  const beforeScore = Number(
    (reranked.reduce((sum, item) => sum + (item.atomQuality ?? 0), 0) / reranked.length).toFixed(4),
  )

  if (!opts.enabled) {
    reranked.sort((a, b) => b.score - a.score)
    return {
      kept: reranked,
      removed: 0,
      beforeCount: reranked.length,
      afterCount: reranked.length,
      beforeScore,
      afterScore: beforeScore,
    }
  }

  reranked.sort((a, b) => b.score - a.score)

  return {
    kept: reranked,
    removed: 0,
    beforeCount: reranked.length,
    afterCount: reranked.length,
    beforeScore,
    afterScore: beforeScore,
  }
}
