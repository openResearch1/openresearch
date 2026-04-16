#!/usr/bin/env bun
/**
 * LongMemEval Evaluation CLI
 *
 * Usage:
 *   bun test/eval/longmemeval/run-eval.ts --dataset data/longmemeval_s_cleaned.json
 *
 * Options:
 *   --dataset         Path to LongMemEval JSON dataset file (required)
 *   --output          Output directory (default: test/eval/longmemeval/output/)
 *   --max-questions   Max questions to evaluate (default: 0 = all)
 *   --retrieval-mode  graphrag | semantic-only | full-context (default: graphrag)
 *   --eval-mode       llm | substring (default: substring)
 *   --chunk-strategy  turn | session | sliding-window (default: turn)
 *   --top-k           Retrieval top K (default: 20)
 *   --max-depth       Graph traversal max depth (default: 2)
 *   --model           Generation model (default: gpt-4o-mini)
 *   --eval-model      Evaluation model (default: gpt-4o)
 *   --graph-store     sqlite | dual | neo4j (default: env or sqlite)
 *   --api-key         OpenAI-compatible API key
 *   --api-base        API base URL
 *
 * Environment variables:
 *   OPENAI_API_KEY              API key for generation and evaluation
 *   OPENAI_BASE_URL / OPENAI_API_BASE
 *                           API base URL for generation and evaluation
 *   OPENCODE_EMBEDDING_API_KEY
 *                           Fallback API key when sharing one provider
 *   OPENCODE_EMBEDDING_BASE_URL
 *                           Fallback API base when sharing one provider
 *
 * Example:
 *   # Quick test with 10 questions, no API key needed (substring eval)
 *   bun test/eval/longmemeval/run-eval.ts \
 *     --dataset data/longmemeval_s_cleaned.json \
 *     --max-questions 10 \
 *     --eval-mode substring
 *
 *   # Full evaluation with GPT-4o scoring
 *   OPENAI_API_KEY=sk-... bun test/eval/longmemeval/run-eval.ts \
 *     --dataset data/longmemeval_s_cleaned.json \
 *     --eval-mode llm
 */

import path from "path"
import os from "os"
import fs from "fs/promises"
import { spawn } from "child_process"
import { parseArgs } from "util"
import { runEvaluation, saveResults, type RetrievalMode, type EvalMode } from "./runner"
import type { EvalConfig } from "./types"
import { DEFAULT_CONFIG } from "./types"
import { Instance } from "../../../src/project/instance"

function env(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]
    if (value) return value
  }
}

async function cmd(cwd: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: "ignore",
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) return resolve()
      reject(new Error(`git ${args.join(" ")} failed with exit code ${code}`))
    })
  })
}

async function initProject(dir: string) {
  await cmd(dir, ["init", "--quiet"])
  await fs.writeFile(
    path.join(dir, ".git", "opencode"),
    `longmemeval-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      dataset: { type: "string" },
      output: { type: "string" },
      "max-questions": { type: "string" },
      "retrieval-mode": { type: "string" },
      "eval-mode": { type: "string" },
      "chunk-strategy": { type: "string" },
      "top-k": { type: "string" },
      "max-depth": { type: "string" },
      model: { type: "string" },
      "eval-model": { type: "string" },
      "graph-store": { type: "string" },
      "api-key": { type: "string" },
      "api-base": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
  })

  if (values.help || !values.dataset) {
    console.log(`
LongMemEval Evaluation for OpenResearch GraphRAG

Usage:
  bun test/eval/longmemeval/run-eval.ts --dataset <path> [options]

Options:
  --dataset           Path to LongMemEval JSON dataset file (required)
  --output            Output directory (default: test/eval/longmemeval/output/)
  --max-questions     Max questions to evaluate (default: 0 = all)
  --retrieval-mode    graphrag | semantic-only | full-context (default: graphrag)
  --eval-mode         llm | substring (default: substring)
  --chunk-strategy    turn | session | sliding-window (default: turn)
  --top-k             Retrieval top K (default: 20)
  --max-depth         Graph traversal max depth (default: 2)
  --model             Generation model (default: gpt-4o-mini)
   --eval-model        Evaluation model (default: gpt-4o)
   --graph-store       sqlite | dual | neo4j
   --api-key           OpenAI-compatible API key
   --api-base          API base URL
   -h, --help          Show this help
`)
    process.exit(values.help ? 0 : 1)
  }

  const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined)

  const retrievalMode = (str(values["retrieval-mode"]) || "graphrag") as RetrievalMode
  const evalMode = (str(values["eval-mode"]) || "substring") as EvalMode
  const graphStoreMode = (str(values["graph-store"]) || process.env.OPENRESEARCH_NEO4J_MODE || "sqlite") as
    | "sqlite"
    | "dual"
    | "neo4j"
  const outputDir = str(values.output) || path.join(__dirname, "output", `${retrievalMode}-${Date.now()}`)

  process.env.OPENRESEARCH_NEO4J_MODE = graphStoreMode

  const config: EvalConfig = {
    ...DEFAULT_CONFIG,
    datasetPath: path.resolve(str(values.dataset) || ""),
    outputDir,
    maxQuestions: parseInt(str(values["max-questions"]) || "0", 10),
    chunkStrategy: (str(values["chunk-strategy"]) as any) || DEFAULT_CONFIG.chunkStrategy,
    retrievalTopK: parseInt(str(values["top-k"]) || "20", 10),
    maxDepth: parseInt(str(values["max-depth"]) || "2", 10),
    generationModel: str(values.model) || DEFAULT_CONFIG.generationModel,
    evalModel: str(values["eval-model"]) || DEFAULT_CONFIG.evalModel,
    graphStoreMode,
    apiKey: str(values["api-key"]) || env("OPENAI_API_KEY", "OPENCODE_EMBEDDING_API_KEY") || "",
    apiBaseUrl:
      str(values["api-base"]) ||
      env("OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENCODE_EMBEDDING_BASE_URL") ||
      DEFAULT_CONFIG.apiBaseUrl,
  }

  // Validate
  if (evalMode === "llm" && !config.apiKey) {
    console.error("Error: --api-key, OPENAI_API_KEY, or OPENCODE_EMBEDDING_API_KEY required for LLM evaluation mode")
    process.exit(1)
  }

  console.log("=".repeat(60))
  console.log("LongMemEval Evaluation — OpenResearch GraphRAG")
  console.log("=".repeat(60))
  console.log(`Dataset:         ${config.datasetPath}`)
  console.log(`Retrieval mode:  ${retrievalMode}`)
  console.log(`Eval mode:       ${evalMode}`)
  console.log(`Chunk strategy:  ${config.chunkStrategy}`)
  console.log(`Top K:           ${config.retrievalTopK}`)
  console.log(`Max depth:       ${config.maxDepth}`)
  console.log(`Generation model:${config.generationModel}`)
  console.log(`Graph store:     ${config.graphStoreMode}`)
  console.log(`Max questions:   ${config.maxQuestions || "all"}`)
  console.log(`Output:          ${outputDir}`)
  console.log("=".repeat(60))
  console.log()

  // Create temporary project directory
  const tmpDir = path.join(os.tmpdir(), `longmemeval-${Date.now()}`)
  await fs.mkdir(tmpDir, { recursive: true })
  await initProject(tmpDir)

  // Run evaluation in project context
  const result = await Instance.provide({
    directory: tmpDir,
    fn: async () => {
      return await runEvaluation(config, retrievalMode, evalMode, (completed, total, last) => {
        const pct = ((completed / total) * 100).toFixed(1)
        const label = last?.evalResult.autoeval_label || "?"
        process.stdout.write(`\r[${completed}/${total}] ${pct}% — ${last?.questionId || ""} → ${label}  `)
      })
    },
  })

  console.log("\n")

  // Print summary
  console.log("=".repeat(60))
  console.log("RESULTS")
  console.log("=".repeat(60))
  console.log()
  console.log(`Overall accuracy: ${result.summary.overall.accuracy.toFixed(1)}%`)
  console.log(`Average latency:  ${result.summary.overall.avgLatency.toFixed(2)}s`)
  console.log(`Avg context tokens: ${Math.round(result.summary.overall.avgContextTokens)}`)
  console.log(`Retrieval session recall: ${(result.avgRetrievalRecall.sessionRecall * 100).toFixed(1)}%`)
  console.log(`Retrieval turn recall: ${(result.avgRetrievalRecall.turnRecall * 100).toFixed(1)}%`)
  console.log(`Total time: ${(result.totalTimeMs / 1000).toFixed(1)}s`)
  console.log()

  // Per-type breakdown
  console.log("By question type:")
  for (const [type, metrics] of Object.entries(result.summary.byType)) {
    console.log(
      `  ${type.padEnd(30)} ${metrics.accuracy.toFixed(1).padStart(5)}% (${metrics.correct}/${metrics.total})`,
    )
  }
  console.log()

  // Save results
  await saveResults(result, outputDir)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
