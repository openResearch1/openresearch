/**
 * Unit tests for LongMemEval evaluation pipeline
 *
 * Tests the adapter, retrieval, and scoring logic using synthetic data.
 * No API key needed — these tests use substring-match evaluation.
 */

import { test, expect, describe, beforeAll } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { Database } from "../../../src/storage/db"
import { AtomTable, AtomRelationTable, ResearchProjectTable } from "../../../src/research/research.sql"
import { ingestInstance, ensureResearchProject, cleanupInstance } from "./adapter"
import { computeRetrievalRecall } from "./retrieval"
import { evaluateWithSubstringMatch, aggregateResults, formatSummaryTable } from "./scorer"
import { loadDataset, filterInstances } from "./runner"
import type { LongMemEvalInstance, EvalConfig, GeneratedAnswer, RetrievedContext } from "./types"
import { DEFAULT_CONFIG } from "./types"
import path from "path"
import fs from "fs/promises"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSyntheticInstance(overrides?: Partial<LongMemEvalInstance>): LongMemEvalInstance {
  return {
    question_id: "test-q1",
    question_type: "single-session-user",
    question: "What is Alice's favorite color?",
    answer: "blue",
    question_date: "2024-03-15",
    haystack_session_ids: ["session-1", "session-2"],
    haystack_dates: ["2024-03-01", "2024-03-10"],
    haystack_sessions: [
      [
        { role: "user", content: "Hi, I'm Alice. My favorite color is blue.", has_answer: true },
        { role: "assistant", content: "Nice to meet you, Alice! Blue is a great color." },
        { role: "user", content: "Do you know any blue flowers?" },
        { role: "assistant", content: "Yes, bluebells and hydrangeas are blue flowers." },
      ],
      [
        { role: "user", content: "I went to the park today." },
        { role: "assistant", content: "That sounds nice! How was the weather?" },
        { role: "user", content: "It was sunny and warm." },
        { role: "assistant", content: "Perfect weather for a park visit!" },
      ],
    ],
    answer_session_ids: ["session-1"],
    ...overrides,
  }
}

function makeConfig(overrides?: Partial<EvalConfig>): EvalConfig {
  return {
    ...DEFAULT_CONFIG,
    chunkStrategy: "turn",
    retrievalTopK: 5,
    maxDepth: 2,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Adapter tests
// ---------------------------------------------------------------------------

describe("LongMemEval Adapter", () => {
  test("ingestInstance creates atoms and relations for turn-level chunks", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rpId = ensureResearchProject()
        const instance = makeSyntheticInstance()
        const config = makeConfig()

        const graph = await ingestInstance(instance, rpId, config)

        // Should create one atom per turn (4 + 4 = 8 turns)
        expect(graph.atomIds.length).toBe(8)
        expect(graph.facts.length).toBe(8)

        // Should create sequential relations within each session
        // session-1: 3 relations (t0→t1, t1→t2, t2→t3)
        // session-2: 3 relations
        expect(graph.relationIds.length).toBe(6)

        // Verify atoms exist in DB
        const atoms = Database.use((db) => db.select().from(AtomTable).all())
        const lmeAtoms = atoms.filter((a) => a.atom_id.startsWith("lme-test-q1-"))
        expect(lmeAtoms.length).toBe(8)

        // All atoms should be "fact" type
        for (const atom of lmeAtoms) {
          expect(atom.atom_type).toBe("fact")
        }

        // Verify relations in DB
        const relations = Database.use((db) => db.select().from(AtomRelationTable).all())
        const lmeRels = relations.filter((r) => r.atom_id_source.startsWith("lme-test-q1-"))
        expect(lmeRels.length).toBe(6)
        for (const rel of lmeRels) {
          expect(rel.relation_type).toBe("derives")
        }
      },
    })
  })

  test("ingestInstance with session-level chunking", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rpId = ensureResearchProject()
        const instance = makeSyntheticInstance()
        const config = makeConfig({ chunkStrategy: "session" })

        const graph = await ingestInstance(instance, rpId, config)

        // Session-level: 2 sessions = 2 atoms
        expect(graph.atomIds.length).toBe(2)
        expect(graph.facts.length).toBe(2)

        // No intra-session relations (each session is one chunk)
        expect(graph.relationIds.length).toBe(0)
      },
    })
  })

  test("ingestInstance with sliding-window chunking", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rpId = ensureResearchProject()
        const instance = makeSyntheticInstance()
        const config = makeConfig({ chunkStrategy: "sliding-window", windowSize: 2 })

        const graph = await ingestInstance(instance, rpId, config)

        // Window size 2 with step 1: each session of 4 turns produces windows at 0,1,2,3
        // So 4 windows per session, 8 total
        expect(graph.facts.length).toBeGreaterThanOrEqual(4)
      },
    })
  })

  test("cleanupInstance removes atoms and relations", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rpId = ensureResearchProject()
        const instance = makeSyntheticInstance()
        const config = makeConfig()

        await ingestInstance(instance, rpId, config)

        // Verify atoms exist
        let atoms = Database.use((db) => db.select().from(AtomTable).all())
        expect(atoms.filter((a) => a.atom_id.startsWith("lme-test-q1-")).length).toBe(8)

        // Cleanup
        cleanupInstance("test-q1")

        // Verify atoms removed
        atoms = Database.use((db) => db.select().from(AtomTable).all())
        expect(atoms.filter((a) => a.atom_id.startsWith("lme-test-q1-")).length).toBe(0)
      },
    })
  })
})

// ---------------------------------------------------------------------------
// Retrieval recall tests
// ---------------------------------------------------------------------------

describe("Retrieval Recall", () => {
  test("computeRetrievalRecall returns correct session recall", () => {
    const instance = makeSyntheticInstance()

    // Simulate retrieved atoms that cover session-1
    const retrieved: RetrievedContext = {
      questionId: "test-q1",
      atoms: [
        {
          atomId: "lme-test-q1-fact-session-1-t0",
          atomName: "Turn 0",
          claim: "Hi, I'm Alice.",
          type: "fact",
          score: 0.9,
          distance: 0,
        },
      ],
      formattedContext: "",
      retrievalTimeMs: 10,
      totalFound: 8,
    }

    const recall = computeRetrievalRecall(retrieved, instance)

    // session-1 is the answer session, and we retrieved it
    expect(recall.sessionRecall).toBe(1.0)
  })

  test("computeRetrievalRecall returns correct turn recall", () => {
    const instance = makeSyntheticInstance()

    // Retrieve the answer turn (t0 of session-1 has has_answer=true)
    const retrieved: RetrievedContext = {
      questionId: "test-q1",
      atoms: [
        {
          atomId: "lme-test-q1-fact-session-1-t0",
          atomName: "Turn 0",
          claim: "Alice's favorite color is blue",
          type: "fact",
          score: 0.9,
          distance: 0,
        },
      ],
      formattedContext: "",
      retrievalTimeMs: 10,
      totalFound: 8,
    }

    const recall = computeRetrievalRecall(retrieved, instance)
    expect(recall.turnRecall).toBe(1.0)
  })

  test("computeRetrievalRecall returns 0 when wrong session retrieved", () => {
    const instance = makeSyntheticInstance()

    const retrieved: RetrievedContext = {
      questionId: "test-q1",
      atoms: [
        {
          atomId: "lme-test-q1-fact-session-2-t0",
          atomName: "Turn 0",
          claim: "I went to the park",
          type: "fact",
          score: 0.5,
          distance: 0,
        },
      ],
      formattedContext: "",
      retrievalTimeMs: 10,
      totalFound: 8,
    }

    const recall = computeRetrievalRecall(retrieved, instance)
    expect(recall.sessionRecall).toBe(0)
    expect(recall.turnRecall).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Scorer tests
// ---------------------------------------------------------------------------

describe("Scorer", () => {
  test("evaluateWithSubstringMatch detects correct answers", () => {
    const instance = makeSyntheticInstance()
    const answer: GeneratedAnswer = {
      question_id: "test-q1",
      hypothesis: "Alice's favorite color is blue.",
      retrieval_time_ms: 10,
      generation_time_ms: 100,
      context_tokens: 500,
    }

    const result = evaluateWithSubstringMatch(instance, answer)
    expect(result.autoeval_label).toBe("correct")
  })

  test("evaluateWithSubstringMatch detects incorrect answers", () => {
    const instance = makeSyntheticInstance()
    const answer: GeneratedAnswer = {
      question_id: "test-q1",
      hypothesis: "Alice's favorite color is red.",
      retrieval_time_ms: 10,
      generation_time_ms: 100,
      context_tokens: 500,
    }

    const result = evaluateWithSubstringMatch(instance, answer)
    expect(result.autoeval_label).toBe("incorrect")
  })

  test("aggregateResults produces correct summary", () => {
    const results = [
      {
        question_id: "q1",
        question_type: "single-session-user" as const,
        question: "Q1",
        ground_truth: "A1",
        hypothesis: "A1",
        autoeval_label: "correct" as const,
        retrieval_time_ms: 10,
        generation_time_ms: 100,
        context_tokens: 500,
      },
      {
        question_id: "q2",
        question_type: "single-session-user" as const,
        question: "Q2",
        ground_truth: "A2",
        hypothesis: "Wrong",
        autoeval_label: "incorrect" as const,
        retrieval_time_ms: 15,
        generation_time_ms: 120,
        context_tokens: 600,
      },
      {
        question_id: "q3",
        question_type: "multi-session" as const,
        question: "Q3",
        ground_truth: "A3",
        hypothesis: "A3",
        autoeval_label: "correct" as const,
        retrieval_time_ms: 20,
        generation_time_ms: 150,
        context_tokens: 800,
      },
    ]

    const summary = aggregateResults(results)

    // Overall: 2/3 correct = 66.7%
    expect(summary.overall.total).toBe(3)
    expect(summary.overall.correct).toBe(2)
    expect(summary.overall.accuracy).toBeCloseTo(66.67, 0)

    // By type
    expect(summary.byType["single-session-user"]!.total).toBe(2)
    expect(summary.byType["single-session-user"]!.correct).toBe(1)
    expect(summary.byType["single-session-user"]!.accuracy).toBeCloseTo(50, 0)

    expect(summary.byType["multi-session"]!.total).toBe(1)
    expect(summary.byType["multi-session"]!.correct).toBe(1)
    expect(summary.byType["multi-session"]!.accuracy).toBeCloseTo(100, 0)
  })

  test("formatSummaryTable produces valid markdown", () => {
    const summary = aggregateResults([
      {
        question_id: "q1",
        question_type: "single-session-user" as const,
        question: "Q1",
        ground_truth: "A1",
        hypothesis: "A1",
        autoeval_label: "correct" as const,
        retrieval_time_ms: 10,
        generation_time_ms: 100,
        context_tokens: 1600,
      },
    ])

    const table = formatSummaryTable(summary, "GraphRAG", "gpt-4o-mini")

    expect(table).toContain("## LongMemEval Results")
    expect(table).toContain("GraphRAG")
    expect(table).toContain("gpt-4o-mini")
    expect(table).toContain("100.0%")
    expect(table).toContain("single-session-user")
  })
})

// ---------------------------------------------------------------------------
// Dataset loading tests
// ---------------------------------------------------------------------------

describe("Dataset loading", () => {
  test("loadDataset reads JSON array", async () => {
    const tmpFile = path.join("/tmp", `longmemeval-test-${Date.now()}.json`)

    const data: LongMemEvalInstance[] = [
      makeSyntheticInstance({ question_id: "q1" }),
      makeSyntheticInstance({ question_id: "q2", question_type: "multi-session" }),
    ]

    await fs.writeFile(tmpFile, JSON.stringify(data))

    try {
      const loaded = await loadDataset(tmpFile)
      expect(loaded.length).toBe(2)
      expect(loaded[0].question_id).toBe("q1")
      expect(loaded[1].question_id).toBe("q2")
    } finally {
      await fs.unlink(tmpFile).catch(() => {})
    }
  })

  test("filterInstances respects maxQuestions", () => {
    const instances = [
      makeSyntheticInstance({ question_id: "q1" }),
      makeSyntheticInstance({ question_id: "q2" }),
      makeSyntheticInstance({ question_id: "q3" }),
    ]

    const config = makeConfig({ maxQuestions: 2 })
    const filtered = filterInstances(instances, config)
    expect(filtered.length).toBe(2)
  })

  test("filterInstances excludes abstention questions", () => {
    const instances = [
      makeSyntheticInstance({ question_id: "q1", question_type: "single-session-user" }),
      makeSyntheticInstance({ question_id: "q2", question_type: "single-session-user_abs" }),
      makeSyntheticInstance({ question_id: "q3", question_type: "multi-session" }),
    ]

    const config = makeConfig({ excludeAbstention: true })
    const filtered = filterInstances(instances, config)
    expect(filtered.length).toBe(2)
    expect(filtered.every((i) => !i.question_type.endsWith("_abs"))).toBe(true)
  })

  test("filterInstances filters by question type", () => {
    const instances = [
      makeSyntheticInstance({ question_id: "q1", question_type: "single-session-user" }),
      makeSyntheticInstance({ question_id: "q2", question_type: "multi-session" }),
      makeSyntheticInstance({ question_id: "q3", question_type: "temporal-reasoning" }),
    ]

    const config = makeConfig({ questionTypes: ["multi-session", "temporal-reasoning"] })
    const filtered = filterInstances(instances, config)
    expect(filtered.length).toBe(2)
    expect(filtered[0].question_type).toBe("multi-session")
    expect(filtered[1].question_type).toBe("temporal-reasoning")
  })
})
