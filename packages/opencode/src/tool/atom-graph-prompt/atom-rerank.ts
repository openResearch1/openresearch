import type { RankedAtom } from "./types"

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

export function rerankAtoms(atoms: RankedAtom[], query?: string) {
  if (atoms.length === 0) return { kept: atoms, removed: 0 }

  const max = atoms.reduce((score, item) => Math.max(score, item.score), 0) || 1
  const reranked = atoms.map((item) => {
    const base = item.score / max
    const atomQuality = item.atomQuality ?? 0.5
    const queryOverlap = query ? overlap(query, item.claim) : 0
    const score = Number((base * 0.55 + atomQuality * 0.3 + queryOverlap * 0.15).toFixed(4))

    return {
      ...item,
      baseScore: item.score,
      atomQuality,
      queryOverlap,
      score,
    }
  })

  const kept = reranked.filter((item) => item.atomQuality >= 0.32 || item.queryOverlap > 0 || item.distance <= 1)
  kept.sort((a, b) => b.score - a.score)

  return {
    kept,
    removed: reranked.length - kept.length,
  }
}
