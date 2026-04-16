#!/usr/bin/env bun

import fs from "fs/promises"
import os from "os"
import path from "path"
import { spawn } from "child_process"
import { parseArgs } from "util"

import { Instance } from "../../../src/project/instance"
import { detectCommunities } from "../../../src/tool/atom-graph-prompt/community"
import { DEFAULT_PRUNE_OPTIONS, pruneCommunities } from "../../../src/tool/atom-graph-prompt/community-prune"
import { ATOMWISE_PRESETS } from "../../../src/tool/atom-graph-prompt/atom-rerank"

import { ensureResearchProject, ingestInstance, cleanupInstance } from "./adapter"
import { generateAnswer } from "./generation"
import { retrieveContextWithCommunityIds } from "./retrieval"
import { loadDataset } from "./runner"
import { evaluateWithLLM, evaluateWithSubstringMatch } from "./scorer"
import { DEFAULT_CONFIG, type EvalConfig, type EvalResult, type LongMemEvalInstance } from "./types"

type EvalMode = "llm" | "substring"
type Preset = keyof typeof ATOMWISE_PRESETS
type AtomwiseMode = "full" | "filter" | "rerank"

type SampleResult = {
  questionId: string
  questionType: string
  question: string
  beforeNodes: number
  afterNodes: number
  beforeScore: number
  afterScore: number
  beforeAccuracy: string
  afterAccuracy: string
  beforeContextTokens: number
  afterContextTokens: number
}

function env(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]
    if (value) return value
  }
}

function bool(value: string | boolean | undefined) {
  if (typeof value === "boolean") return value
  if (typeof value !== "string") return false
  return value === "1" || value.toLowerCase() === "true"
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
    `longmemeval-atomwise-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  preset: Preset,
  mode: AtomwiseMode,
  useCommunityPrune: boolean,
): Promise<SampleResult> {
  const rpId = ensureResearchProject()
  await ingestInstance(instance, rpId, config)

  await detectCommunities({ minCommunitySize: 1, forceRefresh: true })

  const before = await retrieveContextWithCommunityIds(instance, config, undefined, { enabled: false })
  const beforeAnswer = await generateAnswer(instance, before, config)
  const beforeEval = await judge(instance, beforeAnswer, config, evalMode)

  const communityIds = useCommunityPrune
    ? (await pruneCommunities(DEFAULT_PRUNE_OPTIONS)).kept.map((item) => item.id)
    : undefined
  const atomwise =
    mode === "filter"
      ? {
          ...ATOMWISE_PRESETS[preset],
          baseWeight: 1,
          qualityWeight: 0,
          overlapWeight: 0,
          allowQueryBypass: false,
          allowDistanceBypass: false,
        }
      : mode === "rerank"
        ? {
            ...ATOMWISE_PRESETS[preset],
            minQuality: 0,
          }
        : ATOMWISE_PRESETS[preset]

  const after = await retrieveContextWithCommunityIds(instance, config, communityIds, atomwise)
  const afterAnswer = await generateAnswer(instance, after, config)
  const afterEval = await judge(instance, afterAnswer, config, evalMode)

  await cleanupInstance(instance.question_id)

  return {
    questionId: instance.question_id,
    questionType: instance.question_type,
    question: instance.question,
    beforeNodes: before.metadata?.atomwiseAfterNodes ?? before.totalFound,
    afterNodes: after.metadata?.atomwiseAfterNodes ?? after.totalFound,
    beforeScore: before.metadata?.atomwiseAfterScore ?? 0,
    afterScore: after.metadata?.atomwiseAfterScore ?? 0,
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
      preset: { type: "string" },
      mode: { type: "string" },
      "community-prune": { type: "string" },
      "eval-mode": { type: "string" },
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
LongMemEval atom-wise pruning evaluation

Usage:
  bun test/eval/longmemeval/atomwise-eval.ts --dataset <path> [options]

Options:
  --dataset          Path to LongMemEval JSON dataset file
  --output           Output directory
  --samples          Number of samples to evaluate (default: 10)
  --preset           mild | medium | aggressive (default: medium)
  --mode             full | filter | rerank (default: full)
  --community-prune  true | false (default: false)
  --eval-mode        llm | substring (default: llm)
  --model            Generation model (default: gpt-4o-mini)
  --eval-model       Evaluation model (default: gpt-4o-mini)
  --api-key          OpenAI-compatible API key
  --api-base         API base URL
`)
    process.exit(values.help ? 0 : 1)
  }

  const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined)
  const evalMode = (str(values["eval-mode"]) || "llm") as EvalMode
  const preset = (str(values.preset) || "medium") as Preset
  const mode = (str(values.mode) || "full") as AtomwiseMode
  const useCommunityPrune = bool(values["community-prune"])
  const sampleCount = parseInt(str(values.samples) || "10", 10)
  const outputDir =
    str(values.output) ||
    path.join(__dirname, "output", `atomwise-${preset}${useCommunityPrune ? "-composite" : ""}-${Date.now()}`)

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
  console.log(`Preset: ${preset}`)
  console.log(`Mode: ${mode}`)
  console.log(`Community prune: ${useCommunityPrune}`)

  const tmpDir = path.join(os.tmpdir(), `longmemeval-atomwise-${Date.now()}`)
  await fs.mkdir(tmpDir, { recursive: true })
  await initProject(tmpDir)

  const results = await Instance.provide({
    directory: tmpDir,
    fn: async () => {
      const out: SampleResult[] = []
      for (let i = 0; i < samples.length; i++) {
        const item = samples[i]
        out.push(await evaluatePair(item, config, evalMode, preset, mode, useCommunityPrune))
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
    beforeAvgScore: Number((results.reduce((sum, item) => sum + item.beforeScore, 0) / results.length).toFixed(4)),
    afterAvgScore: Number((results.reduce((sum, item) => sum + item.afterScore, 0) / results.length).toFixed(4)),
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
  await fs.writeFile(
    path.join(outputDir, "atomwise-results.json"),
    JSON.stringify({ preset, mode, useCommunityPrune, summary, results }, null, 2),
  )

  const report = [
    "# LongMemEval Atom-wise Evaluation",
    "",
    `Date: ${new Date().toISOString()}`,
    `Dataset: ${config.datasetPath}`,
    `Samples: ${results.length}`,
    `Eval mode: ${evalMode}`,
    `Atom-wise preset: ${preset}`,
    `Atom-wise mode: ${mode}`,
    `Community prune: ${useCommunityPrune}`,
    "",
    "## Summary",
    "",
    "| Metric | Before | After |",
    "|--------|--------|-------|",
    `| Avg nodes | ${summary.beforeAvgNodes} | ${summary.afterAvgNodes} |`,
    `| Avg atom-wise score | ${summary.beforeAvgScore} | ${summary.afterAvgScore} |`,
    `| Accuracy | ${summary.beforeAccuracy}% | ${summary.afterAccuracy}% |`,
    "",
    "## Samples",
    "",
    "| ID | Type | Nodes Before | Nodes After | Score Before | Score After | Accuracy Before | Accuracy After |",
    "|----|------|--------------|-------------|--------------|-------------|-----------------|----------------|",
    ...results.map(
      (item) =>
        `| ${item.questionId} | ${item.questionType} | ${item.beforeNodes} | ${item.afterNodes} | ${item.beforeScore} | ${item.afterScore} | ${item.beforeAccuracy} | ${item.afterAccuracy} |`,
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
