import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./modelscope_search.txt"
import { abortAfterAny } from "../util/abort"

const SEARCH = "https://html.duckduckgo.com/html/"

const Type = z.enum(["auto", "model", "dataset"])

type SearchType = z.infer<typeof Type>

type Item = {
  title: string
  url: string
  snippet?: string
}

function decode(input: string) {
  return input
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-fA-F]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
}

function strip(input: string) {
  return decode(input)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function normalize(url: string) {
  const raw = decode(url)
  if (raw.includes("duckduckgo.com/l/?")) {
    const parsed = new URL(raw.startsWith("http") ? raw : `https:${raw}`)
    const target = parsed.searchParams.get("uddg")
    if (target) return decodeURIComponent(target)
  }
  if (raw.startsWith("//")) return `https:${raw}`
  return raw
}

function parse(html: string, type: Exclude<SearchType, "auto">, limit: number) {
  const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)]
  const snippets = [
    ...html.matchAll(
      /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>(.*?)<\/div>/g,
    ),
  ]
  const seen = new Set<string>()
  const items: Item[] = []
  for (const [idx, match] of links.entries()) {
    const url = normalize(match[1])
    if (!url.startsWith("https://www.modelscope.cn/")) continue
    if (type === "model" && !url.includes("/models/")) continue
    if (type === "dataset" && !url.includes("/datasets/")) continue
    if (seen.has(url)) continue
    seen.add(url)
    items.push({
      title: strip(match[2]),
      url,
      snippet: strip(snippets[idx]?.[1] || snippets[idx]?.[2] || ""),
    })
    if (items.length >= limit) break
  }
  return items
}

async function search(query: string, type: Exclude<SearchType, "auto">, limit: number, signal: AbortSignal) {
  const url = new URL(SEARCH)
  url.searchParams.set("q", `site:modelscope.cn/${type === "model" ? "models" : "datasets"} ${query}`)
  const response = await fetch(url, {
    headers: {
      accept: "text/html",
      "user-agent": "Mozilla/5.0",
    },
    signal,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`ModelScope search error (${response.status}): ${text}`)
  }
  return parse(await response.text(), type, limit)
}

function fmt(label: string, items: Item[]) {
  if (!items.length) return `${label}\nNo candidates found.`
  return [
    label,
    ...items.map((item, idx) =>
      [
        `${idx + 1}. ${item.title || item.url.split("/").pop() || item.url}`,
        `   - url: ${item.url}`,
        ...(item.snippet ? [`   - summary: ${item.snippet.slice(0, 180)}`] : []),
      ].join("\n"),
    ),
  ].join("\n")
}

export const ModelScopeSearchTool = Tool.define("modelscope_search", {
  description: DESCRIPTION,
  parameters: z.object({
    query: z.string().describe("Search query or likely ModelScope repo id"),
    type: Type.default("auto").describe("Search models, datasets, or both"),
    limit: z.number().int().min(1).max(10).default(5).describe("Max results per resource type"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "modelscope_search",
      patterns: [params.query],
      always: ["*"],
      metadata: {
        query: params.query,
        type: params.type,
        limit: params.limit,
      },
    })

    const { signal, clearTimeout } = abortAfterAny(20000, ctx.abort)

    try {
      const [models, datasets] = await Promise.all([
        params.type === "dataset" ? Promise.resolve([] as Item[]) : search(params.query, "model", params.limit, signal),
        params.type === "model" ? Promise.resolve([] as Item[]) : search(params.query, "dataset", params.limit, signal),
      ])
      const output = [
        `Query: ${params.query}`,
        `Type: ${params.type}`,
        params.type !== "dataset" ? `\n${fmt("Models", models)}` : undefined,
        params.type !== "model" ? `\n${fmt("Datasets", datasets)}` : undefined,
      ]
        .filter(Boolean)
        .join("\n")

      return {
        title: `ModelScope search: ${params.query}`,
        output,
        metadata: {},
      }
    } catch (error) {
      clearTimeout()
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("ModelScope search request timed out")
      }
      throw error
    } finally {
      clearTimeout()
    }
  },
})
