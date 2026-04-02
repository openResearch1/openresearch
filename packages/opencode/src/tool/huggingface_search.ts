import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./huggingface_search.txt"
import { abortAfterAny } from "../util/abort"

const API = "https://huggingface.co/api"

const Type = z.enum(["auto", "model", "dataset"])

type ModelItem = {
  id?: string
  downloads?: number
  likes?: number
  private?: boolean
  gated?: boolean
  pipeline_tag?: string
  library_name?: string
  lastModified?: string
  tags?: string[]
}

type DatasetItem = {
  id?: string
  downloads?: number
  likes?: number
  private?: boolean
  gated?: boolean
  lastModified?: string
  description?: string
  tags?: string[]
}

function fmtDate(value?: string) {
  if (!value) return undefined
  return value.slice(0, 10)
}

function fmtNum(value?: number) {
  if (typeof value !== "number") return undefined
  return new Intl.NumberFormat("en-US").format(value)
}

function fmtTags(tags?: string[]) {
  if (!tags?.length) return undefined
  return tags.slice(0, 4).join(", ")
}

function fmtModels(items: ModelItem[]) {
  if (!items.length) return "No model candidates found."
  return items
    .filter((item) => item.id)
    .map((item, idx) => {
      const meta = [
        item.pipeline_tag,
        item.library_name,
        item.gated ? "gated" : undefined,
        item.private ? "private" : undefined,
        fmtDate(item.lastModified) ? `updated ${fmtDate(item.lastModified)}` : undefined,
      ].filter(Boolean)
      const stats = [
        fmtNum(item.likes) ? `likes ${fmtNum(item.likes)}` : undefined,
        fmtNum(item.downloads) ? `downloads ${fmtNum(item.downloads)}` : undefined,
      ].filter(Boolean)
      return [
        `${idx + 1}. ${item.id}`,
        `   - url: https://huggingface.co/${item.id}`,
        ...(meta.length ? [`   - meta: ${meta.join(" | ")}`] : []),
        ...(stats.length ? [`   - stats: ${stats.join(" | ")}`] : []),
        ...(fmtTags(item.tags) ? [`   - tags: ${fmtTags(item.tags)}`] : []),
      ].join("\n")
    })
    .join("\n")
}

function fmtDatasets(items: DatasetItem[]) {
  if (!items.length) return "No dataset candidates found."
  return items
    .filter((item) => item.id)
    .map((item, idx) => {
      const meta = [
        item.gated ? "gated" : undefined,
        item.private ? "private" : undefined,
        fmtDate(item.lastModified) ? `updated ${fmtDate(item.lastModified)}` : undefined,
      ].filter(Boolean)
      const stats = [
        fmtNum(item.likes) ? `likes ${fmtNum(item.likes)}` : undefined,
        fmtNum(item.downloads) ? `downloads ${fmtNum(item.downloads)}` : undefined,
      ].filter(Boolean)
      const desc = item.description?.replace(/\s+/g, " ").trim().slice(0, 160)
      return [
        `${idx + 1}. ${item.id}`,
        `   - url: https://huggingface.co/datasets/${item.id}`,
        ...(meta.length ? [`   - meta: ${meta.join(" | ")}`] : []),
        ...(stats.length ? [`   - stats: ${stats.join(" | ")}`] : []),
        ...(fmtTags(item.tags) ? [`   - tags: ${fmtTags(item.tags)}`] : []),
        ...(desc ? [`   - summary: ${desc}`] : []),
      ].join("\n")
    })
    .join("\n")
}

async function search<T>(path: string, query: string, limit: number, signal: AbortSignal) {
  const url = new URL(`${API}${path}`)
  url.searchParams.set("search", query)
  url.searchParams.set("limit", String(limit))
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
    signal,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Hugging Face search error (${response.status}): ${text}`)
  }
  return (await response.json()) as T[]
}

export const HuggingFaceSearchTool = Tool.define("huggingface_search", {
  description: DESCRIPTION,
  parameters: z.object({
    query: z.string().describe("Search query or likely Hugging Face repo id"),
    type: Type.default("auto").describe("Search models, datasets, or both"),
    limit: z.number().int().min(1).max(10).default(5).describe("Max results per resource type"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "huggingface_search",
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
        params.type === "dataset"
          ? Promise.resolve([] as ModelItem[])
          : search<ModelItem>("/models", params.query, params.limit, signal),
        params.type === "model"
          ? Promise.resolve([] as DatasetItem[])
          : search<DatasetItem>("/datasets", params.query, params.limit, signal),
      ])

      const parts = [
        `Query: ${params.query}`,
        `Type: ${params.type}`,
        params.type !== "dataset" ? `\nModels\n${fmtModels(models)}` : undefined,
        params.type !== "model" ? `\nDatasets\n${fmtDatasets(datasets)}` : undefined,
      ].filter(Boolean)

      return {
        title: `Hugging Face search: ${params.query}`,
        output: parts.join("\n"),
        metadata: {},
      }
    } catch (error) {
      clearTimeout()
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Hugging Face search request timed out")
      }
      throw error
    } finally {
      clearTimeout()
    }
  },
})
