import { test, expect } from "bun:test"
import {
  scoreAtom,
  scoreAndRankAtoms,
  selectDiverseAtoms,
  explainScore,
  DEFAULT_WEIGHTS,
} from "../../../src/tool/atom-graph-prompt/scoring"
import type { TraversedAtom } from "../../../src/tool/atom-graph-prompt/types"

/** Helper to build a mock TraversedAtom */
function mockAtom(
  overrides: Partial<{
    id: string
    name: string
    type: "fact" | "method" | "theorem" | "verification"
    distance: number
    relationChain: Array<
      "motivates" | "formalized_by" | "derives" | "analyzed_by" | "evaluated_by" | "contradicts" | "other"
    >
    created: number
    embedding: number[]
  }>,
): TraversedAtom {
  const now = Date.now()
  return {
    atom: {
      atom_id: overrides.id ?? crypto.randomUUID(),
      research_project_id: "rp-1",
      atom_name: overrides.name ?? "Test Atom",
      atom_type: overrides.type ?? "method",
      atom_claim_path: null,
      atom_evidence_type: "math",
      atom_evidence_status: "pending",
      atom_evidence_path: null,
      atom_evidence_assessment_path: null,
      locked: false,
      article_id: null,
      session_id: null,
      time_created: overrides.created ?? now,
      time_updated: now,
    },
    claim: "test claim",
    evidence: "",
    distance: overrides.distance ?? 0,
    path: [],
    relationChain: overrides.relationChain ?? [],
    claimEmbedding: overrides.embedding,
  }
}

test("should score atoms based on distance", () => {
  const near = mockAtom({ distance: 0 })
  const mid = mockAtom({ distance: 1 })
  const far = mockAtom({ distance: 3 })

  const nearScore = scoreAtom(near, null)
  const midScore = scoreAtom(mid, null)
  const farScore = scoreAtom(far, null)

  expect(nearScore).toBeGreaterThan(midScore)
  expect(midScore).toBeGreaterThan(farScore)
})

test("should score atoms based on type", () => {
  const theorem = mockAtom({ type: "theorem" })
  const method = mockAtom({ type: "method" })
  const verification = mockAtom({ type: "verification" })
  const fact = mockAtom({ type: "fact" })

  // Use type-only weights to isolate the type dimension
  const weights = { distance: 0, type: 1, semantic: 0, temporal: 0, relationChain: 0 }

  const theoremScore = scoreAtom(theorem, null, weights)
  const methodScore = scoreAtom(method, null, weights)
  const verificationScore = scoreAtom(verification, null, weights)
  const factScore = scoreAtom(fact, null, weights)

  expect(theoremScore).toBeGreaterThan(methodScore)
  expect(methodScore).toBeGreaterThan(verificationScore)
  expect(verificationScore).toBeGreaterThan(factScore)
})

test("should score atoms based on relation chain quality", () => {
  const evaluated = mockAtom({ relationChain: ["evaluated_by"] })
  const analyzed = mockAtom({ relationChain: ["analyzed_by"] })
  const derives = mockAtom({ relationChain: ["derives"] })
  const other = mockAtom({ relationChain: ["other"] })
  const origin = mockAtom({ relationChain: [] }) // start node, gets full score

  const weights = { distance: 0, type: 0, semantic: 0, temporal: 0, relationChain: 1 }

  const evaluatedScore = scoreAtom(evaluated, null, weights)
  const analyzedScore = scoreAtom(analyzed, null, weights)
  const derivesScore = scoreAtom(derives, null, weights)
  const otherScore = scoreAtom(other, null, weights)
  const originScore = scoreAtom(origin, null, weights)

  expect(originScore).toBe(10) // start node gets full marks
  expect(evaluatedScore).toBe(10)
  expect(analyzedScore).toBe(9)
  expect(derivesScore).toBe(8)
  expect(otherScore).toBe(3)
})

test("should score atoms based on temporal recency", () => {
  const now = Date.now()
  const recent = mockAtom({ created: now })
  const week = mockAtom({ created: now - 7 * 24 * 60 * 60 * 1000 })
  const month = mockAtom({ created: now - 30 * 24 * 60 * 60 * 1000 })
  const old = mockAtom({ created: now - 120 * 24 * 60 * 60 * 1000 })

  const weights = { distance: 0, type: 0, semantic: 0, temporal: 1, relationChain: 0 }

  const recentScore = scoreAtom(recent, null, weights)
  const weekScore = scoreAtom(week, null, weights)
  const monthScore = scoreAtom(month, null, weights)
  const oldScore = scoreAtom(old, null, weights)

  expect(recentScore).toBeGreaterThanOrEqual(weekScore)
  expect(weekScore).toBeGreaterThan(monthScore)
  expect(monthScore).toBeGreaterThan(oldScore)
  expect(oldScore).toBeGreaterThanOrEqual(1) // minimum score
})

test("should score atoms based on semantic similarity", () => {
  // Create normalized vectors pointing in similar/different directions
  const dim = 384
  const baseVec = new Array(dim).fill(0)
  baseVec[0] = 1.0

  const similarVec = new Array(dim).fill(0)
  similarVec[0] = 0.9
  similarVec[1] = 0.1
  // Normalize
  const norm = Math.sqrt(similarVec.reduce((s, v) => s + v * v, 0))
  for (let i = 0; i < dim; i++) similarVec[i] /= norm

  const orthogonalVec = new Array(dim).fill(0)
  orthogonalVec[1] = 1.0

  const similar = mockAtom({ embedding: similarVec })
  const orthogonal = mockAtom({ embedding: orthogonalVec })

  const weights = { distance: 0, type: 0, semantic: 1, temporal: 0, relationChain: 0 }

  const similarScore = scoreAtom(similar, baseVec, weights)
  const orthogonalScore = scoreAtom(orthogonal, baseVec, weights)

  expect(similarScore).toBeGreaterThan(orthogonalScore)
})

test("should rank atoms by composite score in descending order", () => {
  const atoms = [
    mockAtom({ type: "fact", distance: 3 }),
    mockAtom({ type: "theorem", distance: 0 }),
    mockAtom({ type: "method", distance: 1 }),
  ]

  const ranked = scoreAndRankAtoms(atoms, null)

  // Should be sorted descending by score
  for (let i = 1; i < ranked.length; i++) {
    expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score)
  }

  // Theorem at distance 0 should be first
  expect(ranked[0].atom.atom_type).toBe("theorem")
})

test("should apply custom weights", () => {
  const atoms = [
    mockAtom({ type: "fact", distance: 0 }), // high distance score, low type score
    mockAtom({ type: "theorem", distance: 3 }), // low distance score, high type score
  ]

  // Type-heavy weights
  const typeHeavy = { distance: 0, type: 1, semantic: 0, temporal: 0, relationChain: 0 }
  const rankedByType = scoreAndRankAtoms(atoms, null, typeHeavy)
  expect(rankedByType[0].atom.atom_type).toBe("theorem")

  // Distance-heavy weights
  const distHeavy = { distance: 1, type: 0, semantic: 0, temporal: 0, relationChain: 0 }
  const rankedByDist = scoreAndRankAtoms(atoms, null, distHeavy)
  expect(rankedByDist[0].atom.atom_type).toBe("fact") // distance 0
})

test("should select diverse atoms using MMR", () => {
  const scored = [
    { ...mockAtom({ type: "method", distance: 0, id: "m1" }), score: 10 },
    { ...mockAtom({ type: "method", distance: 0, id: "m2" }), score: 9 },
    { ...mockAtom({ type: "theorem", distance: 1, id: "t1" }), score: 8 },
    { ...mockAtom({ type: "verification", distance: 2, id: "v1" }), score: 7 },
    { ...mockAtom({ type: "fact", distance: 3, id: "f1" }), score: 6 },
  ]

  // With high diversity weight, should pick varied types
  const diverse = selectDiverseAtoms(scored, 3, 0.8)
  expect(diverse).toHaveLength(3)

  // First should always be highest scored
  expect(diverse[0].score).toBe(10)

  // With diversity, we should see different types in the selection
  const types = new Set(diverse.map((a) => a.atom.atom_type))
  expect(types.size).toBeGreaterThan(1)
})

test("should return all atoms when count <= maxCount", () => {
  const scored = [
    { ...mockAtom({ id: "a" }), score: 5 },
    { ...mockAtom({ id: "b" }), score: 3 },
  ]

  const result = selectDiverseAtoms(scored, 5)
  expect(result).toHaveLength(2)
})

test("should provide score explanation breakdown", () => {
  const atom = mockAtom({ type: "theorem", distance: 1, relationChain: ["evaluated_by"] })

  const explanation = explainScore(atom, null)

  expect(explanation.total).toBeGreaterThan(0)
  expect(explanation.breakdown.distance).toBeGreaterThan(0)
  expect(explanation.breakdown.type).toBeGreaterThan(0)
  expect(explanation.breakdown.relationChain).toBeGreaterThan(0)
  expect(explanation.breakdown.temporal).toBeGreaterThan(0)
  // No embedding provided, so semantic should be 0
  expect(explanation.breakdown.semantic).toBe(0)

  // Sum of breakdown should equal total
  const sum = Object.values(explanation.breakdown).reduce((a, b) => a + b, 0)
  expect(sum).toBeCloseTo(explanation.total, 5)
})
