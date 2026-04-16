/**
 * LongMemEval evaluation types
 *
 * Based on the LongMemEval dataset schema (https://github.com/xiaowu0162/LongMemEval)
 * and the Zep paper evaluation methodology (arXiv:2501.13956)
 */

// ---------------------------------------------------------------------------
// LongMemEval dataset types
// ---------------------------------------------------------------------------

export interface LongMemEvalTurn {
  role: "user" | "assistant"
  content: string
  has_answer?: boolean
}

export type LongMemEvalQuestionType =
  | "single-session-user"
  | "single-session-assistant"
  | "single-session-preference"
  | "temporal-reasoning"
  | "knowledge-update"
  | "multi-session"
  // Abstention variants
  | "single-session-user_abs"
  | "single-session-assistant_abs"
  | "single-session-preference_abs"
  | "temporal-reasoning_abs"
  | "knowledge-update_abs"
  | "multi-session_abs"

export interface LongMemEvalInstance {
  question_id: string
  question_type: LongMemEvalQuestionType
  question: string
  answer: string
  question_date?: string
  haystack_session_ids: string[]
  haystack_dates: string[]
  haystack_sessions: LongMemEvalTurn[][]
  answer_session_ids: string[]
}

// ---------------------------------------------------------------------------
// Graph ingestion types — mapping conversations to atoms & relations
// ---------------------------------------------------------------------------

export interface ConversationFact {
  id: string
  content: string
  sourceSessionId: string
  turnIndex: number
  role: "user" | "assistant"
  timestamp: number
  hasAnswer?: boolean
}

export interface ConversationEntity {
  id: string
  name: string
  mentions: number
  firstSeen: number
}

export interface IngestedGraph {
  facts: ConversationFact[]
  entities: ConversationEntity[]
  atomIds: string[]
  relationIds: Array<{ source: string; target: string; type: string }>
}

// ---------------------------------------------------------------------------
// Retrieval types
// ---------------------------------------------------------------------------

export interface RetrievedContext {
  questionId: string
  atoms: Array<{
    atomId: string
    atomName: string
    claim: string
    type: string
    score: number
    distance: number
    timeCreated?: number
  }>
  formattedContext: string
  retrievalTimeMs: number
  totalFound: number
}

// ---------------------------------------------------------------------------
// Evaluation types
// ---------------------------------------------------------------------------

export interface GeneratedAnswer {
  question_id: string
  hypothesis: string
  retrieval_time_ms: number
  generation_time_ms: number
  context_tokens: number
}

export interface EvalResult {
  question_id: string
  question_type: LongMemEvalQuestionType
  question: string
  ground_truth: string
  hypothesis: string
  autoeval_label: "correct" | "incorrect" | "partially_correct"
  retrieval_time_ms: number
  generation_time_ms: number
  context_tokens: number
}

export interface EvalSummary {
  overall: {
    total: number
    correct: number
    accuracy: number
    avgLatency: number
    avgContextTokens: number
  }
  byType: Record<
    string,
    {
      total: number
      correct: number
      accuracy: number
      avgLatency: number
      avgContextTokens: number
    }
  >
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EvalConfig {
  /** Path to the LongMemEval JSON dataset file */
  datasetPath: string

  /** Maximum number of questions to evaluate (0 = all) */
  maxQuestions: number

  /** Question types to include (empty = all) */
  questionTypes: LongMemEvalQuestionType[]

  /** Whether to exclude abstention questions */
  excludeAbstention: boolean

  // --- Graph ingestion ---

  /** How to chunk conversation turns into atoms */
  chunkStrategy: "turn" | "session" | "sliding-window"

  /** Sliding window size (number of turns) when chunkStrategy = "sliding-window" */
  windowSize: number

  // --- Retrieval ---

  /** Number of atoms to retrieve per question */
  retrievalTopK: number

  /** Maximum graph traversal depth */
  maxDepth: number

  /** Semantic similarity threshold */
  semanticThreshold: number

  /** Whether to use community filtering */
  useCommunityFilter: boolean

  // --- Generation ---

  /** Model for answer generation (OpenAI-compatible) */
  generationModel: string

  /** Model for evaluation (should be gpt-4o per LongMemEval) */
  evalModel: string

  /** API base URL */
  apiBaseUrl: string

  /** API key (from env) */
  apiKey: string

  /** Temperature for answer generation */
  temperature: number

  /** Graph storage mode used by GraphRAG retrieval */
  graphStoreMode: "sqlite" | "dual" | "neo4j"

  // --- Output ---

  /** Directory for output files */
  outputDir: string
}

export const DEFAULT_CONFIG: EvalConfig = {
  datasetPath: "",
  maxQuestions: 0,
  questionTypes: [],
  excludeAbstention: true,
  chunkStrategy: "turn",
  windowSize: 4,
  retrievalTopK: 20,
  maxDepth: 2,
  semanticThreshold: 0.3,
  useCommunityFilter: false,
  generationModel: "gpt-4o-mini",
  evalModel: "gpt-4o",
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  temperature: 0.0,
  graphStoreMode: "sqlite",
  outputDir: "",
}
