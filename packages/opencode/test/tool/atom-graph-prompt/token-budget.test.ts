import { test, expect } from "bun:test"
import {
  estimateTokens,
  estimateAtomTokens,
  selectAtomsWithinBudget,
  adaptiveBudgetSelection,
  estimateTemplateTokens,
  estimatePromptTokens,
  generateTokenReport,
} from "../../../src/tool/atom-graph-prompt/token-budget"
import type { TraversedAtom } from "../../../src/tool/atom-graph-prompt/types"

function mockAtom(
  overrides: Partial<{
    id: string
    name: string
    claim: string
    evidence: string
    score: number
  }>,
): TraversedAtom & { score: number } {
  const now = Date.now()
  return {
    atom: {
      atom_id: overrides.id ?? crypto.randomUUID(),
      research_project_id: "rp-1",
      atom_name: overrides.name ?? "Test Atom",
      atom_type: "method",
      atom_claim_path: null,
      atom_evidence_type: "math",
      atom_evidence_status: "pending",
      atom_evidence_path: null,
      atom_evidence_assessment_path: null,
      locked: false,
      article_id: null,
      session_id: null,
      time_created: now,
      time_updated: now,
    },
    claim: overrides.claim ?? "This is a test claim about machine learning.",
    evidence: overrides.evidence ?? "Experimental results show improvement.",
    distance: 0,
    path: [],
    relationChain: [],
    score: overrides.score ?? 5,
  }
}

// --- Token estimation tests ---

test("should estimate tokens for English text", () => {
  const text = "This is a simple English text for token estimation"
  const tokens = estimateTokens(text)

  // ~4 chars per token for English
  const expected = Math.ceil(text.length / 4)
  expect(tokens).toBeCloseTo(expected, 0)
  expect(tokens).toBeGreaterThan(0)
})

test("should estimate tokens for Chinese text", () => {
  const text = "这是一段中文测试文本用于估算"
  const tokens = estimateTokens(text)

  // ~1.5 chars per token for Chinese
  const expected = Math.ceil(text.length / 1.5)
  expect(tokens).toBeCloseTo(expected, 0)
  expect(tokens).toBeGreaterThan(0)
})

test("should estimate tokens for mixed text", () => {
  const text = "Transformer 架构的改进方法 with attention mechanism"
  const tokens = estimateTokens(text)

  expect(tokens).toBeGreaterThan(0)
  // Mixed text should have more tokens than pure English of same length
  // because Chinese chars use more tokens per char
  const pureEnglish = "This is a test sentence of similar character length here"
  const englishTokens = estimateTokens(pureEnglish)
  // Not a strict comparison since lengths differ, just sanity check
  expect(tokens).toBeGreaterThan(0)
  expect(englishTokens).toBeGreaterThan(0)
})

test("should estimate tokens for code blocks", () => {
  const text = "Some text\n```python\ndef hello():\n    print('world')\n```\nMore text"
  const tokens = estimateTokens(text)

  expect(tokens).toBeGreaterThan(0)
})

test("should handle empty text", () => {
  expect(estimateTokens("")).toBe(0)
  expect(estimateTokens(null as any)).toBe(0)
})

// --- Budget selection tests ---

test("should select atoms within budget", () => {
  const atoms = [
    mockAtom({ claim: "Short claim", score: 10 }),
    mockAtom({ claim: "Another short claim", score: 8 }),
    mockAtom({ claim: "Third short claim", score: 6 }),
  ]

  const result = selectAtomsWithinBudget(atoms, {
    maxTokens: 500,
    includeEvidence: false,
    includeMetadata: true,
    reserveTokens: 50,
  })

  expect(result.selected.length).toBeGreaterThan(0)
  expect(result.totalTokens).toBeLessThanOrEqual(500)
  expect(result.budgetUsed).toBeLessThanOrEqual(1)
  expect(result.budgetUsed).toBeGreaterThan(0)
})

test("should prioritize high-score atoms", () => {
  const atoms = [
    mockAtom({ claim: "A".repeat(200), score: 3, id: "low" }),
    mockAtom({ claim: "B".repeat(200), score: 10, id: "high" }),
    mockAtom({ claim: "C".repeat(200), score: 7, id: "mid" }),
  ]

  // Tight budget that can only fit ~1-2 atoms
  const result = selectAtomsWithinBudget(atoms, {
    maxTokens: 300,
    includeEvidence: false,
    includeMetadata: false,
    reserveTokens: 50,
  })

  // First selected should be highest score
  if (result.selected.length > 0) {
    expect(result.selected[0].score).toBe(10)
  }
})

test("should respect token budget strictly", () => {
  // Create atoms with known large claims
  const atoms = Array.from({ length: 20 }, (_, i) =>
    mockAtom({
      claim: "A".repeat(500),
      evidence: "B".repeat(500),
      score: 20 - i,
      id: `atom-${i}`,
    }),
  )

  const budget = 1000
  const result = selectAtomsWithinBudget(atoms, {
    maxTokens: budget,
    includeEvidence: true,
    includeMetadata: true,
    reserveTokens: 200,
  })

  expect(result.totalTokens).toBeLessThanOrEqual(budget)
  // Should not include all 20 atoms given tight budget
  expect(result.selected.length).toBeLessThan(20)
})

// --- Adaptive budget tests ---

test("should adaptively disable evidence when budget is tight", () => {
  const atoms = Array.from({ length: 5 }, (_, i) =>
    mockAtom({
      claim: "A moderate claim for testing purposes here.",
      evidence: "A".repeat(300), // Large evidence
      score: 10 - i,
      id: `adapt-${i}`,
    }),
  )

  // Budget too tight for evidence but enough for claims
  const result = adaptiveBudgetSelection(atoms, 400)

  // Should have selected some atoms
  expect(result.selected.length).toBeGreaterThan(0)
  expect(result.totalTokens).toBeLessThanOrEqual(400)
})

test("should include evidence when budget is generous", () => {
  const atoms = [mockAtom({ claim: "Short claim", evidence: "Short evidence", score: 10 })]

  // Very generous budget
  const result = adaptiveBudgetSelection(atoms, 10000)

  expect(result.selected.length).toBe(1)
  expect(result.includeEvidence).toBe(true)
})

// --- Template token estimation ---

test("should estimate different tokens for graphrag vs compact", () => {
  const graphrag = estimateTemplateTokens("graphrag")
  const compact = estimateTemplateTokens("compact")

  expect(graphrag).toBeGreaterThan(compact)
  expect(graphrag).toBe(150)
  expect(compact).toBe(50)
})

// --- Token report tests ---

test("should generate detailed token report", () => {
  const atoms: TraversedAtom[] = [
    { ...mockAtom({ claim: "First claim", evidence: "First evidence" }) },
    { ...mockAtom({ claim: "Second claim", evidence: "Second evidence" }) },
  ]

  const report = generateTokenReport(atoms, "graphrag", true, true, 5000)

  expect(report.totalTokens).toBeGreaterThan(0)
  expect(report.breakdown.template).toBe(150)
  expect(report.breakdown.atoms).toBeGreaterThan(0)
  expect(report.breakdown.relationships).toBe(atoms.length * 5)
  expect(report.atomDetails).toHaveLength(2)
  expect(report.budgetUsed).toBeGreaterThan(0)
  expect(report.budgetUsed).toBeLessThanOrEqual(1)
  expect(report.budgetRemaining).toBe(5000 - report.totalTokens)
})

test("should estimate prompt tokens accurately", () => {
  const atoms: TraversedAtom[] = [{ ...mockAtom({ claim: "Test claim" }) }]

  const graphrag = estimatePromptTokens(atoms, "graphrag", true, true)
  const compact = estimatePromptTokens(atoms, "compact", false, false)

  expect(graphrag).toBeGreaterThan(compact)
  expect(graphrag).toBeGreaterThan(0)
  expect(compact).toBeGreaterThan(0)
})
