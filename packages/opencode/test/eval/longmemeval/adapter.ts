/**
 * LongMemEval → GraphRAG Data Adapter
 *
 * Converts LongMemEval conversation sessions into our atom knowledge graph.
 *
 * Following the Zep paper (arXiv:2501.13956) methodology:
 * - Conversations are ingested as episodes
 * - Each turn (or chunk) becomes a "fact" atom with its text as the claim
 * - Relations between sequential turns within the same session use "derives"
 * - Cross-session relations for the same entity use "other"
 *
 * Our atom types mapping:
 *   fact    — raw conversational fact / statement
 *   method  — not used (research-domain specific)
 *   theorem — not used (research-domain specific)
 *   verification — not used (research-domain specific)
 */

import { Database, eq, or } from "../../../src/storage/db"
import { AtomTable, AtomRelationTable, ResearchProjectTable } from "../../../src/research/research.sql"
import { Instance } from "../../../src/project/instance"
import { Filesystem } from "../../../src/util/filesystem"
import { mkdir } from "fs/promises"
import path from "path"
import type {
  LongMemEvalInstance,
  LongMemEvalTurn,
  ConversationFact,
  ConversationEntity,
  IngestedGraph,
  EvalConfig,
} from "./types"

// ---------------------------------------------------------------------------
// Research project bootstrap
// ---------------------------------------------------------------------------

export function ensureResearchProject(): string {
  const projectId = Instance.project.id
  const existing = Database.use((db) =>
    db
      .select({ id: ResearchProjectTable.research_project_id })
      .from(ResearchProjectTable)
      .where(eq(ResearchProjectTable.project_id, projectId))
      .get(),
  )

  if (existing) return existing.id

  const rpId = `rp-longmemeval-${Date.now()}`
  const now = Date.now()
  Database.use((db) =>
    db
      .insert(ResearchProjectTable)
      .values({
        research_project_id: rpId,
        project_id: projectId,
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  return rpId
}

// ---------------------------------------------------------------------------
// Chunking strategies
// ---------------------------------------------------------------------------

/**
 * Turn-level chunking: each conversation turn becomes one atom.
 */
function chunkByTurn(sessions: LongMemEvalTurn[][], sessionIds: string[], sessionDates: string[]): ConversationFact[] {
  const facts: ConversationFact[] = []

  for (let si = 0; si < sessions.length; si++) {
    const session = sessions[si]
    const sessionId = sessionIds[si] ?? `session-${si}`
    const baseTime = sessionDates[si]
      ? new Date(sessionDates[si]).getTime()
      : Date.now() - (sessions.length - si) * 86400000

    for (let ti = 0; ti < session.length; ti++) {
      const turn = session[ti]
      facts.push({
        id: `fact-${sessionId}-t${ti}`,
        content: `[${turn.role}]: ${turn.content}`,
        sourceSessionId: sessionId,
        turnIndex: ti,
        role: turn.role,
        timestamp: baseTime + ti * 1000, // each turn is 1s apart
        hasAnswer: turn.has_answer,
      })
    }
  }

  return facts
}

/**
 * Session-level chunking: each session becomes one atom (concatenated turns).
 */
function chunkBySession(
  sessions: LongMemEvalTurn[][],
  sessionIds: string[],
  sessionDates: string[],
): ConversationFact[] {
  const facts: ConversationFact[] = []

  for (let si = 0; si < sessions.length; si++) {
    const session = sessions[si]
    const sessionId = sessionIds[si] ?? `session-${si}`
    const baseTime = sessionDates[si]
      ? new Date(sessionDates[si]).getTime()
      : Date.now() - (sessions.length - si) * 86400000

    const content = session.map((t) => `[${t.role}]: ${t.content}`).join("\n")
    const hasAnswer = session.some((t) => t.has_answer)

    facts.push({
      id: `fact-${sessionId}`,
      content,
      sourceSessionId: sessionId,
      turnIndex: 0,
      role: "user", // session-level
      timestamp: baseTime,
      hasAnswer,
    })
  }

  return facts
}

/**
 * Sliding-window chunking: overlapping windows of N turns.
 */
function chunkBySlidingWindow(
  sessions: LongMemEvalTurn[][],
  sessionIds: string[],
  sessionDates: string[],
  windowSize: number,
): ConversationFact[] {
  const facts: ConversationFact[] = []

  for (let si = 0; si < sessions.length; si++) {
    const session = sessions[si]
    const sessionId = sessionIds[si] ?? `session-${si}`
    const baseTime = sessionDates[si]
      ? new Date(sessionDates[si]).getTime()
      : Date.now() - (sessions.length - si) * 86400000

    for (let start = 0; start < session.length; start += Math.max(1, Math.floor(windowSize / 2))) {
      const windowTurns = session.slice(start, start + windowSize)
      if (windowTurns.length === 0) break

      const content = windowTurns.map((t) => `[${t.role}]: ${t.content}`).join("\n")
      const hasAnswer = windowTurns.some((t) => t.has_answer)

      facts.push({
        id: `fact-${sessionId}-w${start}`,
        content,
        sourceSessionId: sessionId,
        turnIndex: start,
        role: "user",
        timestamp: baseTime + start * 1000,
        hasAnswer,
      })

      if (start + windowSize >= session.length) break
    }
  }

  return facts
}

// ---------------------------------------------------------------------------
// Simple entity extraction (keyword-based, no LLM dependency)
// ---------------------------------------------------------------------------

function extractEntities(facts: ConversationFact[]): ConversationEntity[] {
  const entityMap = new Map<string, ConversationEntity>()

  for (const fact of facts) {
    // Extract proper nouns and capitalized phrases (simple heuristic)
    const words = fact.content.split(/\s+/)
    for (let i = 0; i < words.length; i++) {
      const word = words[i].replace(/[^\w]/g, "")
      if (word.length >= 2 && word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) {
        // Skip common words
        if (
          [
            "The",
            "This",
            "That",
            "What",
            "How",
            "When",
            "Where",
            "Why",
            "Yes",
            "No",
            "And",
            "But",
            "Or",
            "If",
          ].includes(word)
        )
          continue

        const key = word.toLowerCase()
        if (entityMap.has(key)) {
          const ent = entityMap.get(key)!
          ent.mentions++
        } else {
          entityMap.set(key, {
            id: `entity-${key}`,
            name: word,
            mentions: 1,
            firstSeen: fact.timestamp,
          })
        }
      }
    }
  }

  // Keep only entities with ≥ 2 mentions (significant)
  return Array.from(entityMap.values()).filter((e) => e.mentions >= 2)
}

// ---------------------------------------------------------------------------
// Graph ingestion — write atoms and relations to DB
// ---------------------------------------------------------------------------

export async function ingestInstance(
  instance: LongMemEvalInstance,
  rpId: string,
  config: EvalConfig,
): Promise<IngestedGraph> {
  // 1. Chunk conversations into facts
  let facts: ConversationFact[]
  switch (config.chunkStrategy) {
    case "session":
      facts = chunkBySession(instance.haystack_sessions, instance.haystack_session_ids, instance.haystack_dates)
      break
    case "sliding-window":
      facts = chunkBySlidingWindow(
        instance.haystack_sessions,
        instance.haystack_session_ids,
        instance.haystack_dates,
        config.windowSize,
      )
      break
    case "turn":
    default:
      facts = chunkByTurn(instance.haystack_sessions, instance.haystack_session_ids, instance.haystack_dates)
      break
  }

  // 2. Extract entities
  const entities = extractEntities(facts)

  // 3. Write claim files and insert atoms
  const atomListDir = path.join(Instance.directory, "atom_list")
  await mkdir(atomListDir, { recursive: true })

  const atomIds: string[] = []
  const now = Date.now()

  for (const fact of facts) {
    const atomId = `lme-${instance.question_id}-${fact.id}`
    const claimPath = path.join(atomListDir, `${atomId}.claim.md`)

    await Filesystem.write(claimPath, fact.content)

    Database.use((db) =>
      db
        .insert(AtomTable)
        .values({
          atom_id: atomId,
          research_project_id: rpId,
          atom_name: `Turn ${fact.turnIndex} [${fact.role}] (${fact.sourceSessionId})`,
          atom_type: "fact",
          atom_claim_path: claimPath,
          atom_evidence_type: "experiment",
          atom_evidence_status: "pending",
          time_created: fact.timestamp,
          time_updated: now,
        })
        .onConflictDoNothing()
        .run(),
    )

    atomIds.push(atomId)
  }

  // 4. Build relations: sequential turns within the same session
  const relationIds: Array<{ source: string; target: string; type: string }> = []
  const factsBySession = new Map<string, ConversationFact[]>()
  for (const fact of facts) {
    if (!factsBySession.has(fact.sourceSessionId)) {
      factsBySession.set(fact.sourceSessionId, [])
    }
    factsBySession.get(fact.sourceSessionId)!.push(fact)
  }

  for (const [, sessionFacts] of factsBySession) {
    sessionFacts.sort((a, b) => a.turnIndex - b.turnIndex)

    for (let i = 1; i < sessionFacts.length; i++) {
      const sourceId = `lme-${instance.question_id}-${sessionFacts[i - 1].id}`
      const targetId = `lme-${instance.question_id}-${sessionFacts[i].id}`

      Database.use((db) =>
        db
          .insert(AtomRelationTable)
          .values({
            atom_id_source: sourceId,
            atom_id_target: targetId,
            relation_type: "derives",
            note: "sequential conversation turn",
            time_created: now,
            time_updated: now,
          })
          .onConflictDoNothing()
          .run(),
      )

      relationIds.push({ source: sourceId, target: targetId, type: "derives" })
    }
  }
  return { facts, entities, atomIds, relationIds }
}

// ---------------------------------------------------------------------------
// Cleanup — remove atoms for a given question instance
// ---------------------------------------------------------------------------

export async function cleanupInstance(questionId: string): Promise<void> {
  const prefix = `lme-${questionId}-`
  const atoms = Database.use((db) => db.select().from(AtomTable).all())
  const toDelete = atoms.filter((a) => a.atom_id.startsWith(prefix)).map((a) => a.atom_id)

  for (const atomId of toDelete) {
    Database.use((db) =>
      db
        .delete(AtomRelationTable)
        .where(or(eq(AtomRelationTable.atom_id_source, atomId), eq(AtomRelationTable.atom_id_target, atomId)))
        .run(),
    )
    Database.use((db) => db.delete(AtomTable).where(eq(AtomTable.atom_id, atomId)).run())
  }
}
