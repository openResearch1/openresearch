#!/usr/bin/env bun

import fs from "fs/promises"
import os from "os"
import path from "path"
import { spawn } from "child_process"
import { parseArgs } from "util"

import { Instance } from "../../../src/project/instance"
import { detectCommunities } from "../../../src/tool/atom-graph-prompt/community"
import {
  DEFAULT_PRUNE_OPTIONS,
  pruneCommunities,
  summarizePruning,
} from "../../../src/tool/atom-graph-prompt/community-prune"

import { ensureResearchProject, ingestInstance, cleanupInstance } from "./adapter"
import { generateAnswer } from "./generation"
import { retrieveContext, retrieveContextWithCommunityIds } from "./retrieval"
import { loadDataset } from "./runner"
import { evaluateWithLLM, evaluateWithSubstringMatch } from "./scorer"
import { DEFAULT_CONFIG, type EvalConfig, type EvalResult, type LongMemEvalInstance } from "./types"

type EvalMode = "llm" | "substring"

type SampleResult = {
  questionId: string
  questionType: string
  question: string
  beforeNodes: number
  afterNodes: number
  beforeCommunities: number
  afterCommunities: number
  beforeCommunityScore: number
  afterCommunityScore: number
  beforeAccuracy: string
  afterAccuracy: string
  beforeContextTokens: number
  afterContextTokens: number
}

type PruneConfig = {
  minSize?: number
  minDensity?: number
  minInternalEdges?: number
  minKeywords?: number
  maxHubRatio?: number
}

function env(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]
    if (value) return value
  }
}

async function cmd(cwd: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" })
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
    `longmemeval-prune-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
}

function pick(instances: LongMemEvalInstance[], count: number) {
  const desired = [
    ["single-session-user", 2],
    ["single-session-assistant", 1],
    ["single-session-preference", 1],
    ["temporal-reasoning", 2],
    ["knowledge-update", 2],
    ["multi-session", 2],
  ] as const

  const selected: LongMemEvalInstance[] = []
  const used = new Set<string>()

  for (const [type, size] of desired) {
    const items = instances.filter((item) => item.question_type === type && !used.has(item.question_id)).slice(0, size)
    for (const item of items) {
      selected.push(item)
      used.add(item.question_id)
    }
  }

  if (selected.length >= count) return selected.slice(0, count)

  for (const item of instances) {
    if (used.has(item.question_id)) continue
    selected.push(item)
    used.add(item.question_id)
    if (selected.length >= count) break
  }

  return selected
}

async function judge(
  instance: LongMemEvalInstance,
  result: { hypothesis: string; retrieval_time_ms: number; generation_time_ms: number; context_tokens: number },
  config: EvalConfig,
  evalMode: EvalMode,
) {
  if (evalMode === "llm") {
    return evaluateWithLLM(instance, { question_id: instance.question_id, ...result }, config)
  }

  return evaluateWithSubstringMatch(instance, { question_id: instance.question_id, ...result })
}

async function evaluatePair(
  instance: LongMemEvalInstance,
  config: EvalConfig,
  evalMode: EvalMode,
  prune: PruneConfig,
): Promise<SampleResult> {
  const rpId = ensureResearchProject()
  await ingestInstance(instance, rpId, config)

  await detectCommunities({ minCommunitySize: 1, forceRefresh: true })
  const pruned = await pruneCommunities(prune)
  const summary = summarizePruning(pruned)

  const before = await retrieveContext(instance, config)
  const beforeAnswer = await generateAnswer(instance, before, config)
  const beforeEval = await judge(instance, beforeAnswer, config, evalMode)

  const keptIds = pruned.kept.map((item) => item.id)
  const after = await retrieveContextWithCommunityIds(instance, config, keptIds)
  const afterAnswer = await generateAnswer(instance, after, config)
  const afterEval = await judge(instance, afterAnswer, config, evalMode)

  await cleanupInstance(instance.question_id)

  return {
    questionId: instance.question_id,
    questionType: instance.question_type,
    question: instance.question,
    beforeNodes: summary.beforeNodes,
    afterNodes: summary.afterNodes,
    beforeCommunities: summary.beforeCommunities,
    afterCommunities: summary.afterCommunities,
    beforeCommunityScore: summary.beforeScore,
    afterCommunityScore: summary.afterScore,
    beforeAccuracy: beforeEval.autoeval_label,
    afterAccuracy: afterEval.autoeval_label,
    beforeContextTokens: beforeEval.context_tokens,
    afterContextTokens: afterEval.context_tokens,
  }
}

function rate(label: EvalResult["autoeval_label"]) {
  if (label === "correct") return 1
  if (label === "partially_correct") return 0.5
  return 0
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      dataset: { type: "string" },
      output: { type: "string" },
      samples: { type: "string" },
      "eval-mode": { type: "string" },
      "min-size": { type: "string" },
      "min-density": { type: "string" },
      "min-internal-edges": { type: "string" },
      "min-keywords": { type: "string" },
      "max-hub-ratio": { type: "string" },
      model: { type: "string" },
      "eval-model": { type: "string" },
      "api-key": { type: "string" },
      "api-base": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
  })

  if (values.help || !values.dataset) {
    console.log(`
LongMemEval pruning evaluation

Usage:
  bun test/eval/longmemeval/pruning-eval.ts --dataset <path> [options]

Options:
  --dataset       Path to LongMemEval JSON dataset file
  --output        Output directory
  --samples       Number of samples to evaluate (default: 10)
  --eval-mode     llm | substring (default: llm)
  --min-size      Community minimum size (default: 5)
  --min-density   Community minimum density (default: 0.05)
  --min-internal-edges  Community minimum internal edges (default: 4)
  --min-keywords  Community minimum keyword count (default: 3)
  --max-hub-ratio Community maximum hub ratio (default: 0.65)
  --model         Generation model (default: gpt-4o-mini)
  --eval-model    Evaluation model (default: gpt-4o-mini)
  --api-key       OpenAI-compatible API key
  --api-base      API base URL
`)
    process.exit(values.help ? 0 : 1)
  }

  const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined)
  const evalMode = (str(values["eval-mode"]) || "llm") as EvalMode
  const sampleCount = parseInt(str(values.samples) || "10", 10)
  const outputDir = str(values.output) || path.join(__dirname, "output", `pruning-${Date.now()}`)
  const prune: PruneConfig = {
    minSize: str(values["min-size"]) ? parseInt(str(values["min-size"])!, 10) : DEFAULT_PRUNE_OPTIONS.minSize,
    minDensity: str(values["min-density"]) ? parseFloat(str(values["min-density"])!) : DEFAULT_PRUNE_OPTIONS.minDensity,
    minInternalEdges: str(values["min-internal-edges"])
      ? parseInt(str(values["min-internal-edges"])!, 10)
      : DEFAULT_PRUNE_OPTIONS.minInternalEdges,
    minKeywords: str(values["min-keywords"])
      ? parseInt(str(values["min-keywords"])!, 10)
      : DEFAULT_PRUNE_OPTIONS.minKeywords,
    maxHubRatio: str(values["max-hub-ratio"])
      ? parseFloat(str(values["max-hub-ratio"])!)
      : DEFAULT_PRUNE_OPTIONS.maxHubRatio,
  }
  const config: EvalConfig = {
    ...DEFAULT_CONFIG,
    datasetPath: path.resolve(str(values.dataset) || ""),
    maxQuestions: 0,
    generationModel: str(values.model) || DEFAULT_CONFIG.generationModel,
    evalModel: str(values["eval-model"]) || DEFAULT_CONFIG.generationModel,
    apiKey: str(values["api-key"]) || env("OPENAI_API_KEY", "OPENCODE_EMBEDDING_API_KEY") || "",
    apiBaseUrl:
      str(values["api-base"]) ||
      env("OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENCODE_EMBEDDING_BASE_URL") ||
      DEFAULT_CONFIG.apiBaseUrl,
    outputDir,
  }

  if (evalMode === "llm" && !config.apiKey) {
    console.error("Error: API key required for llm mode")
    process.exit(1)
  }

  const data = await loadDataset(config.datasetPath)
  const samples = pick(
    data.filter((item) => !item.question_type.endsWith("_abs")),
    sampleCount,
  )

  console.log(`Loaded ${data.length} instances, selected ${samples.length}`)

  const tmpDir = path.join(os.tmpdir(), `longmemeval-pruning-${Date.now()}`)
  await fs.mkdir(tmpDir, { recursive: true })
  await initProject(tmpDir)

  const results = await Instance.provide({
    directory: tmpDir,
    fn: async () => {
      const out: SampleResult[] = []
      for (let i = 0; i < samples.length; i++) {
        const item = samples[i]
        const result = await evaluatePair(item, config, evalMode, prune)
        out.push(result)
        process.stdout.write(`\r[${i + 1}/${samples.length}] ${item.question_id}  `)
      }
      return out
    },
  })

  console.log("\n")

  const summary = {
    samples: results.length,
    beforeAvgNodes: Number((results.reduce((sum, item) => sum + item.beforeNodes, 0) / results.length).toFixed(2)),
    afterAvgNodes: Number((results.reduce((sum, item) => sum + item.afterNodes, 0) / results.length).toFixed(2)),
    beforeAvgCommunityScore: Number(
      (results.reduce((sum, item) => sum + item.beforeCommunityScore, 0) / results.length).toFixed(2),
    ),
    afterAvgCommunityScore: Number(
      (results.reduce((sum, item) => sum + item.afterCommunityScore, 0) / results.length).toFixed(2),
    ),
    beforeAccuracy: Number(
      (
        (results.reduce((sum, item) => sum + rate(item.beforeAccuracy as EvalResult["autoeval_label"]), 0) /
          results.length) *
        100
      ).toFixed(2),
    ),
    afterAccuracy: Number(
      (
        (results.reduce((sum, item) => sum + rate(item.afterAccuracy as EvalResult["autoeval_label"]), 0) /
          results.length) *
        100
      ).toFixed(2),
    ),
  }

  await fs.mkdir(outputDir, { recursive: true })
  await fs.writeFile(path.join(outputDir, "pruning-results.json"), JSON.stringify({ prune, summary, results }, null, 2))

  const report = [
    "# LongMemEval Pruning Evaluation",
    "",
    `Date: ${new Date().toISOString()}`,
    `Dataset: ${config.datasetPath}`,
    `Samples: ${results.length}`,
    `Eval mode: ${evalMode}`,
    `Prune config: ${JSON.stringify(prune)}`,
    "",
    "## Summary",
    "",
    "| Metric | Before | After |",
    "|--------|--------|-------|",
    `| Avg nodes | ${summary.beforeAvgNodes} | ${summary.afterAvgNodes} |`,
    `| Avg community score | ${summary.beforeAvgCommunityScore} | ${summary.afterAvgCommunityScore} |`,
    `| Accuracy | ${summary.beforeAccuracy}% | ${summary.afterAccuracy}% |`,
    "",
    "Community score formula:",
    "",
    "`score = 0.4*density + 0.25*sizeScore + 0.15*keywordScore + 0.2*(1-hubRatio)`",
    "",
    "## Samples",
    "",
    "| ID | Type | Nodes Before | Nodes After | Score Before | Score After | Accuracy Before | Accuracy After |",
    "|----|------|--------------|-------------|--------------|-------------|-----------------|----------------|",
    ...results.map(
      (item) =>
        `| ${item.questionId} | ${item.questionType} | ${item.beforeNodes} | ${item.afterNodes} | ${item.beforeCommunityScore} | ${item.afterCommunityScore} | ${item.beforeAccuracy} | ${item.afterAccuracy} |`,
    ),
    "",
  ].join("\n")

  await fs.writeFile(path.join(outputDir, "report.md"), report)
  console.log(`Results saved to ${outputDir}`)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
