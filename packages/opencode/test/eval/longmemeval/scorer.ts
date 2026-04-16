/**
 * Evaluation scorer for LongMemEval
 *
 * Implements two evaluation modes:
 *   1. LLM-based evaluation (following LongMemEval's official evaluate_qa.py)
 *      Uses GPT-4o to judge whether the generated answer is correct.
 *   2. Exact/substring match (fast, no API cost, used for debugging)
 *
 * The LLM evaluator follows the question-specific prompts from the LongMemEval
 * paper (arXiv:2410.10813), which have demonstrated high correlation with human
 * evaluators.
 */

import type {
  EvalConfig,
  EvalResult,
  EvalSummary,
  GeneratedAnswer,
  LongMemEvalInstance,
  LongMemEvalQuestionType,
} from "./types"
import { complete } from "./api"

// ---------------------------------------------------------------------------
// LLM-based evaluation (official LongMemEval method)
// ---------------------------------------------------------------------------

/**
 * Evaluate a single answer using GPT-4o as judge.
 *
 * The prompt asks the LLM to determine if the hypothesis matches the
 * ground truth answer, returning "correct", "incorrect", or "partially_correct".
 */
export async function evaluateWithLLM(
  instance: LongMemEvalInstance,
  answer: GeneratedAnswer,
  config: EvalConfig,
): Promise<EvalResult> {
  const evalPrompt = buildEvalPrompt(instance, answer.hypothesis)

  let label: "correct" | "incorrect" | "partially_correct" = "incorrect"

  try {
    const response = await callEvalLLM(evalPrompt, config)
    label = parseEvalResponse(response)
  } catch (error) {
    console.error(`Eval API error for ${instance.question_id}:`, error)
  }

  return {
    question_id: instance.question_id,
    question_type: instance.question_type,
    question: instance.question,
    ground_truth: instance.answer,
    hypothesis: answer.hypothesis,
    autoeval_label: label,
    retrieval_time_ms: answer.retrieval_time_ms,
    generation_time_ms: answer.generation_time_ms,
    context_tokens: answer.context_tokens,
  }
}

/**
 * Build the evaluation prompt following LongMemEval's methodology.
 *
 * Adapted from LongMemEval/src/evaluation/evaluate_qa.py
 */
function buildEvalPrompt(instance: LongMemEvalInstance, hypothesis: string): string {
  return [
    "You are an evaluation judge. Your task is to determine whether the predicted answer",
    "(hypothesis) correctly answers the question based on the reference answer (ground truth).",
    "",
    "Rules:",
    "- Focus on factual correctness, not exact wording.",
    "- The hypothesis must contain the key information from the ground truth to be correct.",
    "- Partial credit: if the hypothesis contains some but not all key facts, label it 'partially_correct'.",
    "- If the hypothesis is wrong, irrelevant, or says it cannot answer, label it 'incorrect'.",
    "- If the hypothesis correctly captures the essential facts, label it 'correct'.",
    "",
    `Question type: ${instance.question_type}`,
    "",
    `Question: ${instance.question}`,
    "",
    `Ground truth answer: ${instance.answer}`,
    "",
    `Predicted answer (hypothesis): ${hypothesis}`,
    "",
    "Respond with exactly one of: correct, incorrect, partially_correct",
  ].join("\n")
}

/**
 * Parse the evaluation LLM response into a label.
 */
function parseEvalResponse(response: string): "correct" | "incorrect" | "partially_correct" {
  const lower = response.toLowerCase().trim()
  if (lower.includes("partially_correct") || lower.includes("partially correct")) {
    return "partially_correct"
  }
  if (lower.includes("correct") && !lower.includes("incorrect")) {
    return "correct"
  }
  return "incorrect"
}

/**
 * Call the evaluation LLM (GPT-4o).
 */
async function callEvalLLM(prompt: string, config: EvalConfig): Promise<string> {
  return complete({
    config,
    model: config.evalModel,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.0,
    maxTokens: 32,
  })
}

// ---------------------------------------------------------------------------
// Substring-match evaluation (fast, no API cost)
// ---------------------------------------------------------------------------

/**
 * Simple substring-match evaluation for fast debugging.
 * Checks if key phrases from the ground truth appear in the hypothesis.
 */
export function evaluateWithSubstringMatch(instance: LongMemEvalInstance, answer: GeneratedAnswer): EvalResult {
  const hypothesis = answer.hypothesis.toLowerCase()
  const groundTruth = instance.answer.toLowerCase()

  // Split ground truth into key phrases
  const keyPhrases = groundTruth
    .split(/[,;.!?]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 3)

  if (keyPhrases.length === 0) {
    return {
      question_id: instance.question_id,
      question_type: instance.question_type,
      question: instance.question,
      ground_truth: instance.answer,
      hypothesis: answer.hypothesis,
      autoeval_label: "incorrect",
      retrieval_time_ms: answer.retrieval_time_ms,
      generation_time_ms: answer.generation_time_ms,
      context_tokens: answer.context_tokens,
    }
  }

  let matches = 0
  for (const phrase of keyPhrases) {
    if (hypothesis.includes(phrase)) {
      matches++
    }
  }

  const matchRatio = matches / keyPhrases.length
  let label: "correct" | "incorrect" | "partially_correct"

  if (matchRatio >= 0.7) {
    label = "correct"
  } else if (matchRatio >= 0.3) {
    label = "partially_correct"
  } else {
    label = "incorrect"
  }

  return {
    question_id: instance.question_id,
    question_type: instance.question_type,
    question: instance.question,
    ground_truth: instance.answer,
    hypothesis: answer.hypothesis,
    autoeval_label: label,
    retrieval_time_ms: answer.retrieval_time_ms,
    generation_time_ms: answer.generation_time_ms,
    context_tokens: answer.context_tokens,
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate evaluation results into a summary.
 *
 * Produces overall metrics and per-question-type breakdown,
 * matching Table 2 and Table 3 from the Zep paper.
 */
export function aggregateResults(results: EvalResult[]): EvalSummary {
  const overall = computeGroupMetrics(results)

  const byType: Record<string, typeof overall> = {}
  const typeGroups = new Map<string, EvalResult[]>()

  for (const r of results) {
    // Normalize type: strip _abs suffix for grouping
    const baseType = r.question_type.replace(/_abs$/, "")
    if (!typeGroups.has(baseType)) {
      typeGroups.set(baseType, [])
    }
    typeGroups.get(baseType)!.push(r)
  }

  for (const [type, group] of typeGroups) {
    byType[type] = computeGroupMetrics(group)
  }

  return { overall, byType }
}

function computeGroupMetrics(results: EvalResult[]) {
  const total = results.length
  const correct = results.filter((r) => r.autoeval_label === "correct").length
  const accuracy = total > 0 ? (correct / total) * 100 : 0

  const avgLatency =
    total > 0 ? results.reduce((sum, r) => sum + r.retrieval_time_ms + r.generation_time_ms, 0) / total / 1000 : 0

  const avgContextTokens = total > 0 ? results.reduce((sum, r) => sum + r.context_tokens, 0) / total : 0

  return { total, correct, accuracy, avgLatency, avgContextTokens }
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

/**
 * Format evaluation summary as a markdown table.
 *
 * Produces output similar to Zep paper Table 2 (LongMemEval_s):
 *
 *   | Memory       | Model        | Score  | Latency | Avg Context Tokens |
 *   |--------------|-------------|--------|---------|-------------------|
 *   | GraphRAG     | gpt-4o-mini | 63.8%  | 3.20 s  | 1.6k              |
 */
export function formatSummaryTable(summary: EvalSummary, label: string, model: string): string {
  const lines: string[] = []

  lines.push("## LongMemEval Results")
  lines.push("")
  lines.push("### Overall")
  lines.push("")
  lines.push("| Memory | Model | Score | Latency | Avg Context Tokens |")
  lines.push("|--------|-------|-------|---------|-------------------|")
  lines.push(
    `| ${label} | ${model} | ${summary.overall.accuracy.toFixed(1)}% | ${summary.overall.avgLatency.toFixed(2)} s | ${formatTokenCount(summary.overall.avgContextTokens)} |`,
  )
  lines.push("")

  // Per-type breakdown (Table 3 style)
  lines.push("### Breakdown by Question Type")
  lines.push("")
  lines.push("| Question Type | Total | Correct | Accuracy | Avg Latency |")
  lines.push("|--------------|-------|---------|----------|-------------|")

  const typeOrder = [
    "single-session-user",
    "single-session-assistant",
    "single-session-preference",
    "temporal-reasoning",
    "knowledge-update",
    "multi-session",
  ]

  for (const type of typeOrder) {
    const metrics = summary.byType[type]
    if (metrics) {
      lines.push(
        `| ${type} | ${metrics.total} | ${metrics.correct} | ${metrics.accuracy.toFixed(1)}% | ${metrics.avgLatency.toFixed(2)} s |`,
      )
    }
  }

  lines.push("")
  return lines.join("\n")
}

function formatTokenCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`
  }
  return String(Math.round(count))
}

/**
 * Format comparison with Zep paper baselines.
 */
export function formatComparisonTable(summary: EvalSummary, model: string): string {
  const lines: string[] = []

  lines.push("### Comparison with Zep Paper Baselines (Table 2)")
  lines.push("")
  lines.push("| Memory | Model | Score | Avg Context Tokens |")
  lines.push("|--------|-------|-------|-------------------|")
  lines.push(`| Full-context (Zep baseline) | gpt-4o-mini | 55.4% | 115k |`)
  lines.push(`| Zep (Zep paper) | gpt-4o-mini | 63.8% | 1.6k |`)
  lines.push(`| Full-context (Zep baseline) | gpt-4o | 60.2% | 115k |`)
  lines.push(`| Zep (Zep paper) | gpt-4o | 71.2% | 1.6k |`)
  lines.push(
    `| **OpenResearch GraphRAG** | **${model}** | **${summary.overall.accuracy.toFixed(1)}%** | **${formatTokenCount(summary.overall.avgContextTokens)}** |`,
  )
  lines.push("")

  return lines.join("\n")
}
