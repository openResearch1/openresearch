/**
 * Answer generation module for LongMemEval evaluation
 *
 * Uses an OpenAI-compatible API to generate answers from retrieved context.
 * Following the Zep paper (Section 4.3):
 *   - The system reformats retrieved data into a context string
 *   - GPT-4o generates answers based on the provided context
 */

import type { EvalConfig, RetrievedContext, GeneratedAnswer, LongMemEvalInstance } from "./types"
import { complete } from "./api"

/**
 * Generate an answer for a LongMemEval question using retrieved context.
 */
export async function generateAnswer(
  instance: LongMemEvalInstance,
  context: RetrievedContext,
  config: EvalConfig,
): Promise<GeneratedAnswer> {
  const startTime = performance.now()

  const systemPrompt = buildSystemPrompt()
  const userPrompt = buildUserPrompt(instance, context)

  // Estimate context tokens (rough: 1 token ≈ 4 chars)
  const contextTokens = Math.ceil(context.formattedContext.length / 4)

  let hypothesis: string

  try {
    hypothesis = await callLLM(systemPrompt, userPrompt, config)
  } catch (error) {
    console.error(`Failed to generate answer for ${instance.question_id}:`, error)
    hypothesis = "I don't have enough information to answer this question."
  }

  const generationTimeMs = performance.now() - startTime

  return {
    question_id: instance.question_id,
    hypothesis,
    retrieval_time_ms: context.retrievalTimeMs,
    generation_time_ms: generationTimeMs,
    context_tokens: contextTokens,
  }
}

/**
 * Build system prompt for the answer generation LLM.
 */
function buildSystemPrompt(): string {
  return [
    "You are a helpful assistant with access to a user's conversation history.",
    "You will be provided with relevant excerpts from past conversations.",
    "Based on these excerpts, answer the user's question accurately and concisely.",
    "",
    "Guidelines:",
    "- Answer based ONLY on the provided conversation context.",
    "- If the context does not contain enough information, say so clearly.",
    "- Be specific and cite relevant details from the conversations.",
    "- For temporal questions, pay attention to dates and order of events.",
    "- Keep your answer concise but complete.",
  ].join("\n")
}

/**
 * Build user prompt combining the question and retrieved context.
 */
function buildUserPrompt(instance: LongMemEvalInstance, context: RetrievedContext): string {
  const sections: string[] = []

  sections.push("## Retrieved Conversation Context")
  sections.push("")
  sections.push(context.formattedContext)
  sections.push("")
  sections.push("## Question")
  sections.push("")
  sections.push(instance.question)

  if (instance.question_date) {
    sections.push("")
    sections.push(`(Asked on: ${instance.question_date})`)
  }

  sections.push("")
  sections.push("## Your Answer")

  return sections.join("\n")
}

/**
 * Call an OpenAI-compatible LLM API.
 */
async function callLLM(systemPrompt: string, userPrompt: string, config: EvalConfig): Promise<string> {
  return complete({
    config,
    model: config.generationModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: config.temperature,
    maxTokens: 512,
  })
}

/**
 * Batch generate answers for multiple instances.
 * Processes sequentially to respect API rate limits.
 */
export async function batchGenerateAnswers(
  instances: LongMemEvalInstance[],
  contexts: Map<string, RetrievedContext>,
  config: EvalConfig,
  onProgress?: (completed: number, total: number) => void,
): Promise<GeneratedAnswer[]> {
  const answers: GeneratedAnswer[] = []

  for (let i = 0; i < instances.length; i++) {
    const instance = instances[i]
    const context = contexts.get(instance.question_id)

    if (!context) {
      console.warn(`No context found for ${instance.question_id}, skipping`)
      continue
    }

    const answer = await generateAnswer(instance, context, config)
    answers.push(answer)

    onProgress?.(i + 1, instances.length)
  }

  return answers
}
