/**
 * Retrieval pipeline for LongMemEval evaluation
 *
 * Following the Zep paper approach (Section 4.3):
 *   1. For each question, query the graphRAG with the question text
 *   2. Retrieve the top K most relevant atoms (facts + entity summaries)
 *   3. Format retrieved context as a structured prompt
 *
 * We use the project's existing hybrid search pipeline (semantic + graph traversal)
 * with scoring and ranking to retrieve the most relevant conversation facts.
 */

import { hybridSearch, graphOnlySearch } from "../../../src/tool/atom-graph-prompt/hybrid"
import {
  loadEmbeddingCache,
  saveEmbeddingCache,
  getAtomEmbedding,
  cosineSimilarity,
} from "../../../src/tool/atom-graph-prompt/embedding"
import { Database, eq } from "../../../src/storage/db"
import { AtomTable, ResearchProjectTable } from "../../../src/research/research.sql"
import { Filesystem } from "../../../src/util/filesystem"
import { Instance } from "../../../src/project/instance"
import { DEFAULT_WEIGHTS } from "../../../src/tool/atom-graph-prompt/scoring"
import type { AtomwiseOptions } from "../../../src/tool/atom-graph-prompt/types"
import type { EvalConfig, RetrievedContext, LongMemEvalInstance } from "./types"

/**
 * Retrieve relevant context for a LongMemEval question using our graphRAG.
 *
 * This is the core evaluation step — we test how well our retrieval system
 * can find the right conversation facts given a natural language question.
 */
export async function retrieveContext(instance: LongMemEvalInstance, config: EvalConfig): Promise<RetrievedContext> {
  return retrieveContextWithCommunityIds(instance, config)
}

export async function retrieveContextWithCommunityIds(
  instance: LongMemEvalInstance,
  config: EvalConfig,
  communityIds?: string[],
  atomwise?: AtomwiseOptions,
): Promise<RetrievedContext> {
  const startTime = performance.now()

  // Use our hybrid search with the question as the query
  const searchResult = await hybridSearch({
    query: instance.question,
    maxDepth: config.maxDepth,
    maxAtoms: config.retrievalTopK,
    semanticTopK: config.retrievalTopK,
    semanticThreshold: config.semanticThreshold,
    scoringWeights: DEFAULT_WEIGHTS,
    includeEvidence: false,
    includeMetadata: true,
    diversityWeight: 0.3,
    communityFilter: communityIds && communityIds.length > 0 ? { communityIds } : undefined,
    atomwise,
  })

  if (process.env.OPENRESEARCH_GRAPHRAG_PROFILE === "1") {
    const meta = searchResult.metadata as typeof searchResult.metadata & { timings?: unknown }
    console.log(
      JSON.stringify(
        {
          type: "graphrag-profile",
          questionId: instance.question_id,
          graphStoreMode: config.graphStoreMode,
          timings: meta.timings,
          totalFound: searchResult.metadata.totalFound,
          selected: searchResult.metadata.selected,
          fromSemanticSearch: searchResult.metadata.fromSemanticSearch,
          fromGraphTraversal: searchResult.metadata.fromGraphTraversal,
          tokensUsed: searchResult.metadata.tokensUsed,
        },
        null,
        2,
      ),
    )
  }

  const retrievalTimeMs = performance.now() - startTime

  // Format atoms for the response
  const atoms = searchResult.atoms.map((a) => ({
    atomId: a.atom.atom_id,
    atomName: a.atom.atom_name,
    claim: a.claim,
    type: a.atom.atom_type,
    score: a.score,
    distance: a.distance,
    timeCreated: a.atom.time_created,
  }))

  // Build formatted context string (similar to Zep's context template)
  const formattedContext = formatContext(atoms, instance)

  return {
    questionId: instance.question_id,
    atoms,
    formattedContext,
    retrievalTimeMs,
    totalFound: searchResult.metadata.totalFound,
    metadata: {
      atomwiseBeforeNodes: searchResult.metadata.atomwiseBeforeNodes,
      atomwiseAfterNodes: searchResult.metadata.atomwiseAfterNodes,
      atomwiseBeforeScore: searchResult.metadata.atomwiseBeforeScore,
      atomwiseAfterScore: searchResult.metadata.atomwiseAfterScore,
      atomwiseRemoved: searchResult.metadata.atomwiseRemoved,
    },
  }
}

/**
 * Lightweight retrieval using only semantic search (no graph traversal).
 * Used as a baseline comparison.
 */
export async function retrieveContextSemanticOnly(
  instance: LongMemEvalInstance,
  config: EvalConfig,
): Promise<RetrievedContext> {
  const startTime = performance.now()

  // Load all atoms and compute similarity
  const cache = await loadEmbeddingCache()
  const queryEmbedding = await getAtomEmbedding("query-" + instance.question_id, instance.question, cache)

  const researchProjectId = Database.use((db) =>
    db
      .select({ id: ResearchProjectTable.research_project_id })
      .from(ResearchProjectTable)
      .where(eq(ResearchProjectTable.project_id, Instance.project.id))
      .get(),
  )?.id

  const allAtoms = researchProjectId
    ? Database.use((db) =>
        db.select().from(AtomTable).where(eq(AtomTable.research_project_id, researchProjectId)).all(),
      )
    : Database.use((db) => db.select().from(AtomTable).all())

  // Filter to only this instance's atoms
  const prefix = `lme-${instance.question_id}-`
  const instanceAtoms = allAtoms.filter((a) => a.atom_id.startsWith(prefix))

  // Score each atom by semantic similarity
  const scored: Array<{ atom: (typeof instanceAtoms)[0]; claim: string; similarity: number }> = []

  for (const atom of instanceAtoms) {
    let claimText = ""
    try {
      if (atom.atom_claim_path) {
        claimText = await Filesystem.readText(atom.atom_claim_path)
      }
    } catch {
      continue
    }

    if (!claimText) continue

    const atomEmbedding = await getAtomEmbedding(atom.atom_id, claimText, cache)
    const similarity = cosineSimilarity(queryEmbedding, atomEmbedding)

    scored.push({ atom, claim: claimText, similarity })
  }

  await saveEmbeddingCache(cache)

  // Sort by similarity and take top K
  scored.sort((a, b) => b.similarity - a.similarity)
  const topK = scored.slice(0, config.retrievalTopK)

  const retrievalTimeMs = performance.now() - startTime

  const atoms = topK.map((s) => ({
    atomId: s.atom.atom_id,
    atomName: s.atom.atom_name,
    claim: s.claim,
    type: s.atom.atom_type,
    score: s.similarity,
    distance: 0,
    timeCreated: s.atom.time_created,
  }))

  const formattedContext = formatContext(atoms, instance)

  return {
    questionId: instance.question_id,
    atoms,
    formattedContext,
    retrievalTimeMs,
    totalFound: instanceAtoms.length,
  }
}

/**
 * Full-context baseline: return all conversation turns as context.
 * This mimics the "Full-context" baseline in the Zep paper.
 */
export async function retrieveContextFullHistory(instance: LongMemEvalInstance): Promise<RetrievedContext> {
  const startTime = performance.now()

  const allTurns: Array<{ content: string; sessionId: string }> = []
  for (let si = 0; si < instance.haystack_sessions.length; si++) {
    const session = instance.haystack_sessions[si]
    const sessionId = instance.haystack_session_ids[si] ?? `session-${si}`
    for (const turn of session) {
      allTurns.push({
        content: `[${turn.role}]: ${turn.content}`,
        sessionId,
      })
    }
  }

  const formattedContext = allTurns.map((t) => t.content).join("\n\n")

  const retrievalTimeMs = performance.now() - startTime

  return {
    questionId: instance.question_id,
    atoms: [],
    formattedContext,
    retrievalTimeMs,
    totalFound: allTurns.length,
  }
}

// ---------------------------------------------------------------------------
// Context formatting
// ---------------------------------------------------------------------------

/**
 * Format retrieved atoms into a context string for LLM consumption.
 *
 * Follows the Zep paper's context template (Section 3, page 4):
 *   FACTS represent relevant context to the current conversation.
 *   format: FACT (Date range: from - to)
 */
function formatContext(
  atoms: Array<{
    atomId: string
    atomName: string
    claim: string
    type: string
    score: number
    distance: number
    timeCreated?: number
  }>,
  instance: LongMemEvalInstance,
): string {
  if (atoms.length === 0) {
    return "No relevant conversation context found."
  }

  const sections: string[] = []

  sections.push("FACTS and ENTITIES represent relevant context to the current conversation.")
  sections.push("These are the most relevant facts and their valid date ranges.")
  sections.push("format: FACT (relevance score)")
  sections.push("")
  sections.push("<FACTS>")

  for (const atom of atoms) {
    const date = atom.timeCreated ? new Date(atom.timeCreated).toISOString().slice(0, 10) : "unknown-date"
    sections.push(`- [${date}] ${atom.atomName} | distance=${atom.distance} | score=${atom.score.toFixed(3)}`)
    sections.push(`  ${atom.claim}`)
  }

  sections.push("</FACTS>")
  sections.push("")

  if (instance.question_date) {
    sections.push(`Current date: ${instance.question_date}`)
    sections.push("")
  }

  return sections.join("\n")
}

/**
 * Compute retrieval recall metrics.
 *
 * Measures whether the retrieved atoms contain the answer-bearing turns
 * from the ground truth sessions.
 */
export function computeRetrievalRecall(
  retrieved: RetrievedContext,
  instance: LongMemEvalInstance,
): { sessionRecall: number; turnRecall: number } {
  // Session-level recall: do retrieved atoms cover the answer sessions?
  const answerSessionIds = new Set(instance.answer_session_ids)
  const retrievedSessionIds = new Set<string>()
  for (const atom of retrieved.atoms) {
    // Extract session ID from atom ID: lme-{qid}-fact-{sessionId}-t{turnIdx}
    const match = atom.atomId.match(/fact-(.+?)(?:-t\d+|-w\d+)?$/)
    if (match) {
      retrievedSessionIds.add(match[1])
    }
  }

  let sessionHits = 0
  for (const sid of answerSessionIds) {
    if (retrievedSessionIds.has(sid)) sessionHits++
  }
  const sessionRecall = answerSessionIds.size > 0 ? sessionHits / answerSessionIds.size : 0

  // Turn-level recall: do retrieved atoms include the has_answer=true turns?
  let answerTurns = 0
  let retrievedAnswerTurns = 0

  for (let si = 0; si < instance.haystack_sessions.length; si++) {
    const session = instance.haystack_sessions[si]
    const sessionId = instance.haystack_session_ids[si] ?? `session-${si}`
    for (let ti = 0; ti < session.length; ti++) {
      if (session[ti].has_answer) {
        answerTurns++
        const targetAtomId = `lme-${instance.question_id}-fact-${sessionId}-t${ti}`
        if (retrieved.atoms.some((a) => a.atomId === targetAtomId)) {
          retrievedAnswerTurns++
        }
      }
    }
  }

  const turnRecall = answerTurns > 0 ? retrievedAnswerTurns / answerTurns : 0

  return { sessionRecall, turnRecall }
}
