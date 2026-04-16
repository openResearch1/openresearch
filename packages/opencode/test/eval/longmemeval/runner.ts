/**
 * Main evaluation runner for LongMemEval benchmark
 *
 * Orchestrates the full evaluation pipeline:
 *   1. Load dataset
 *   2. For each question instance:
 *      a. Ingest conversation sessions into the knowledge graph
 *      b. Retrieve relevant context using graphRAG
 *      c. Generate answer using LLM
 *      d. Evaluate answer
 *      e. Cleanup graph state
 *   3. Aggregate and report results
 *
 * Following the Zep paper (arXiv:2501.13956) methodology.
 */

import fs from "fs/promises"
import path from "path"
import { ingestInstance, ensureResearchProject, cleanupInstance } from "./adapter"
import {
  retrieveContext,
  retrieveContextSemanticOnly,
  retrieveContextFullHistory,
  computeRetrievalRecall,
} from "./retrieval"
import { generateAnswer } from "./generation"
import {
  evaluateWithLLM,
  evaluateWithSubstringMatch,
  aggregateResults,
  formatSummaryTable,
  formatComparisonTable,
} from "./scorer"
import type { EvalConfig, EvalResult, GeneratedAnswer, LongMemEvalInstance, RetrievedContext } from "./types"

// ---------------------------------------------------------------------------
// Dataset loading
// ---------------------------------------------------------------------------

export async function loadDataset(datasetPath: string): Promise<LongMemEvalInstance[]> {
  const content = await fs.readFile(datasetPath, "utf-8")
  const data = JSON.parse(content) as LongMemEvalInstance[]

  if (!Array.isArray(data)) {
    throw new Error("Dataset must be a JSON array of LongMemEvalInstance objects")
  }

  return data
}

/**
 * Filter dataset instances based on config.
 */
export function filterInstances(instances: LongMemEvalInstance[], config: EvalConfig): LongMemEvalInstance[] {
  let filtered = instances

  // Filter by question type
  if (config.questionTypes.length > 0) {
    const typeSet = new Set(config.questionTypes)
    filtered = filtered.filter((i) => typeSet.has(i.question_type))
  }

  // Exclude abstention questions
  if (config.excludeAbstention) {
    filtered = filtered.filter((i) => !i.question_type.endsWith("_abs"))
  }

  // Limit count
  if (config.maxQuestions > 0) {
    filtered = filtered.slice(0, config.maxQuestions)
  }

  return filtered
}

// ---------------------------------------------------------------------------
// Evaluation modes
// ---------------------------------------------------------------------------

export type RetrievalMode = "graphrag" | "semantic-only" | "full-context"
export type EvalMode = "llm" | "substring"

// ---------------------------------------------------------------------------
// Single instance pipeline
// ---------------------------------------------------------------------------

export interface InstanceResult {
  questionId: string
  retrieval: RetrievedContext
  answer: GeneratedAnswer
  evalResult: EvalResult
  retrievalRecall: { sessionRecall: number; turnRecall: number }
  ingestionTimeMs: number
}

/**
 * Run the full evaluation pipeline for a single instance.
 */
export async function evaluateInstance(
  instance: LongMemEvalInstance,
  config: EvalConfig,
  rpId: string,
  retrievalMode: RetrievalMode = "graphrag",
  evalMode: EvalMode = "substring",
): Promise<InstanceResult> {
  // 1. Ingest conversation into graph
  const ingestStart = performance.now()
  const graph = await ingestInstance(instance, rpId, config)
  const ingestionTimeMs = performance.now() - ingestStart

  // 2. Retrieve context
  let retrieval: RetrievedContext
  switch (retrievalMode) {
    case "semantic-only":
      retrieval = await retrieveContextSemanticOnly(instance, config)
      break
    case "full-context":
      retrieval = await retrieveContextFullHistory(instance)
      break
    case "graphrag":
    default:
      retrieval = await retrieveContext(instance, config)
      break
  }

  // 3. Compute retrieval recall
  const retrievalRecall = computeRetrievalRecall(retrieval, instance)

  // 4. Generate answer
  const answer = await generateAnswer(instance, retrieval, config)

  // 5. Evaluate
  let evalResult: EvalResult
  switch (evalMode) {
    case "llm":
      evalResult = await evaluateWithLLM(instance, answer, config)
      break
    case "substring":
    default:
      evalResult = evaluateWithSubstringMatch(instance, answer)
      break
  }

  // 6. Cleanup graph state for this instance
  await cleanupInstance(instance.question_id)

  return {
    questionId: instance.question_id,
    retrieval,
    answer,
    evalResult,
    retrievalRecall,
    ingestionTimeMs,
  }
}

// ---------------------------------------------------------------------------
// Full evaluation run
// ---------------------------------------------------------------------------

export interface RunResult {
  config: EvalConfig
  retrievalMode: RetrievalMode
  evalMode: EvalMode
  results: EvalResult[]
  summary: ReturnType<typeof aggregateResults>
  avgRetrievalRecall: { sessionRecall: number; turnRecall: number }
  totalTimeMs: number
}

/**
 * Run the full LongMemEval evaluation.
 */
export async function runEvaluation(
  config: EvalConfig,
  retrievalMode: RetrievalMode = "graphrag",
  evalMode: EvalMode = "substring",
  onProgress?: (completed: number, total: number, lastResult?: InstanceResult) => void,
): Promise<RunResult> {
  const totalStart = performance.now()

  // 1. Load and filter dataset
  const allInstances = await loadDataset(config.datasetPath)
  const instances = filterInstances(allInstances, config)
  console.log(`Loaded ${allInstances.length} instances, filtered to ${instances.length}`)

  // 2. Ensure research project exists
  const rpId = ensureResearchProject()

  // 3. Process each instance
  const results: EvalResult[] = []
  const recalls: Array<{ sessionRecall: number; turnRecall: number }> = []

  for (let i = 0; i < instances.length; i++) {
    const instance = instances[i]

    try {
      const result = await evaluateInstance(instance, config, rpId, retrievalMode, evalMode)
      results.push(result.evalResult)
      recalls.push(result.retrievalRecall)
      onProgress?.(i + 1, instances.length, result)
    } catch (error) {
      console.error(`Error processing ${instance.question_id}:`, error)
      // Add a failed result
      results.push({
        question_id: instance.question_id,
        question_type: instance.question_type,
        question: instance.question,
        ground_truth: instance.answer,
        hypothesis: "",
        autoeval_label: "incorrect",
        retrieval_time_ms: 0,
        generation_time_ms: 0,
        context_tokens: 0,
      })
    }
  }

  // 4. Aggregate results
  const summary = aggregateResults(results)

  // 5. Compute average retrieval recall
  const avgRetrievalRecall = {
    sessionRecall: recalls.length > 0 ? recalls.reduce((s, r) => s + r.sessionRecall, 0) / recalls.length : 0,
    turnRecall: recalls.length > 0 ? recalls.reduce((s, r) => s + r.turnRecall, 0) / recalls.length : 0,
  }

  const totalTimeMs = performance.now() - totalStart

  return {
    config,
    retrievalMode,
    evalMode,
    results,
    summary,
    avgRetrievalRecall,
    totalTimeMs,
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Save evaluation results to files.
 */
export async function saveResults(run: RunResult, outputDir: string): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true })

  // 1. Save raw results as JSONL (LongMemEval compatible format)
  const jsonlPath = path.join(outputDir, "predictions.jsonl")
  const jsonlContent = run.results
    .map((r) =>
      JSON.stringify({
        question_id: r.question_id,
        hypothesis: r.hypothesis,
        autoeval_label: r.autoeval_label,
      }),
    )
    .join("\n")
  await fs.writeFile(jsonlPath, jsonlContent)

  // 2. Save detailed results
  const detailedPath = path.join(outputDir, "detailed-results.json")
  await fs.writeFile(
    detailedPath,
    JSON.stringify(
      {
        config: {
          retrievalMode: run.retrievalMode,
          evalMode: run.evalMode,
          graphStoreMode: run.config.graphStoreMode,
          retrievalTopK: run.config.retrievalTopK,
          maxDepth: run.config.maxDepth,
          chunkStrategy: run.config.chunkStrategy,
          generationModel: run.config.generationModel,
        },
        summary: run.summary,
        avgRetrievalRecall: run.avgRetrievalRecall,
        totalTimeMs: run.totalTimeMs,
        results: run.results,
      },
      null,
      2,
    ),
  )

  // 3. Save markdown report
  const reportPath = path.join(outputDir, "report.md")
  const report = [
    `# LongMemEval Evaluation Report`,
    ``,
    `Date: ${new Date().toISOString()}`,
    `Retrieval mode: ${run.retrievalMode}`,
    `Eval mode: ${run.evalMode}`,
    `Graph store mode: ${run.config.graphStoreMode}`,
    `Total questions: ${run.results.length}`,
    `Total time: ${(run.totalTimeMs / 1000).toFixed(1)}s`,
    ``,
    `## Retrieval Recall`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Session-level recall | ${(run.avgRetrievalRecall.sessionRecall * 100).toFixed(1)}% |`,
    `| Turn-level recall | ${(run.avgRetrievalRecall.turnRecall * 100).toFixed(1)}% |`,
    ``,
    formatSummaryTable(run.summary, run.retrievalMode, run.config.generationModel),
    formatComparisonTable(run.summary, run.config.generationModel),
  ].join("\n")
  await fs.writeFile(reportPath, report)

  console.log(`Results saved to ${outputDir}`)
  console.log(`  - ${jsonlPath} (LongMemEval compatible)`)
  console.log(`  - ${detailedPath}`)
  console.log(`  - ${reportPath}`)
}
