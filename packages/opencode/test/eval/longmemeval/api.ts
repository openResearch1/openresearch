import type { EvalConfig } from "./types"

type Msg = {
  role: "system" | "user"
  content: string
}

function delay(body: string, retryAfter: string | null, attempt: number) {
  const header = Number(retryAfter)
  if (Number.isFinite(header) && header > 0) {
    return Math.ceil(header * 1000) + 500
  }

  const sec = body.match(/Please try again in ([\d.]+)s/i)?.[1]
  if (sec) {
    return Math.ceil(Number(sec) * 1000) + 500
  }

  const ms = body.match(/Please try again in ([\d.]+)ms/i)?.[1]
  if (ms) {
    return Math.ceil(Number(ms)) + 500
  }

  return Math.min(60_000, 2_000 * 2 ** attempt)
}

export async function complete(input: {
  config: EvalConfig
  model: string
  messages: Msg[]
  temperature: number
  maxTokens: number
}) {
  const url = `${input.config.apiBaseUrl}/chat/completions`

  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.config.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        temperature: input.temperature,
        max_tokens: input.maxTokens,
      }),
    })

    if (response.ok) {
      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>
      }
      return data.choices[0]?.message?.content?.trim() ?? ""
    }

    const body = await response.text()
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      const wait = delay(body, response.headers.get("retry-after"), attempt)
      console.warn(`LLM API ${response.status}; retrying in ${Math.ceil(wait / 1000)}s (${attempt + 1}/5)`)
      await Bun.sleep(wait)
      continue
    }

    throw new Error(`LLM API error ${response.status}: ${body}`)
  }

  throw new Error("LLM API retry loop exited unexpectedly")
}
