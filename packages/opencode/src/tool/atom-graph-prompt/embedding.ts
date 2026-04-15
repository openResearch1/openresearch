import path from "path"
import { Auth } from "../../auth"
import { Config } from "../../config/config"
import { Env } from "../../env"
import { ModelsDev } from "../../provider/models"
import { Instance } from "../../project/instance"
import { Filesystem } from "../../util/filesystem"

/**
 * Embedding 缓存管理（使用文件系统，不改动数据库）
 */

export interface AtomEmbedding {
  atomId: string
  claimEmbedding: number[]
  timestamp: number
}

export interface EmbeddingCache {
  version: string
  model: string
  embeddings: Record<string, AtomEmbedding>
}

const CACHE_FILE = ".atom-embeddings-cache.json"
const CACHE_VERSION = "2.0"
const SIMPLE_DIM = 384
const SIMPLE_MODEL = `simple:${SIMPLE_DIM}`

type Target = {
  model: string
  url: string
  headers: Record<string, string>
  dims?: number
  signature: string
}

const mode = Instance.state(() => ({ simple: false }))

function trim(url: string): string {
  return url.replace(/\/+$/, "")
}

function parse(value: string): { providerID: string; modelID: string } | undefined {
  const [providerID, ...rest] = value.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) return
  return { providerID, modelID }
}

function num(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return
  const parsed = Number(value)
  if (Number.isFinite(parsed)) return parsed
}

function record(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, val]) => {
      if (typeof val !== "string") return []
      return [[key, val]]
    }),
  )
}

function active(target: Target | null) {
  if (mode().simple || !target) return SIMPLE_MODEL
  return target.signature
}

async function target() {
  const cfg = await Config.get()
  const env = Env.get("OPENCODE_EMBEDDING_MODEL")
  if (env) {
    const parsed = parse(env)
    if (parsed) return resolve(parsed.providerID, parsed.modelID, cfg)
  }

  const refs = [cfg.small_model, cfg.model]
    .flatMap((item) => (item ? [parse(item)?.providerID] : []))
    .filter((item): item is string => Boolean(item))

  for (const id of refs) {
    const model = cfg.provider?.[id]?.options?.embeddingModel
    if (typeof model === "string") {
      const next = await resolve(id, model, cfg)
      if (next) return next
    }
  }

  for (const [id, provider] of Object.entries(cfg.provider ?? {})) {
    const model = provider.options?.embeddingModel
    if (typeof model !== "string") continue
    const next = await resolve(id, model, cfg)
    if (next) return next
  }

  return null
}

async function resolve(providerID: string, modelID: string, cfg: Awaited<ReturnType<typeof Config.get>>) {
  const db = (await ModelsDev.get())[providerID]
  const provider = cfg.provider?.[providerID]
  const base =
    Env.get("OPENCODE_EMBEDDING_BASE_URL") ??
    provider?.options?.embeddingBaseURL ??
    provider?.options?.baseURL ??
    provider?.api ??
    db?.api

  if (!base) return null

  const auth = await Auth.get(providerID)
  const envs = provider?.env ?? db?.env ?? []
  const key =
    Env.get("OPENCODE_EMBEDDING_API_KEY") ??
    provider?.options?.embeddingApiKey ??
    provider?.options?.apiKey ??
    (auth?.type === "api" ? auth.key : undefined) ??
    envs.map((name) => Env.get(name)).find(Boolean)

  const headers = {
    ...record(provider?.options?.headers),
    ...record(provider?.options?.embeddingHeaders),
    "Content-Type": "application/json",
  }

  if (!headers.Authorization && key) {
    headers.Authorization = `Bearer ${key}`
  }

  const root = trim(base)
  const url = root.endsWith("/embeddings") ? root : `${root}/embeddings`
  const dims = num(Env.get("OPENCODE_EMBEDDING_DIMENSIONS") ?? provider?.options?.embeddingDimensions)

  return {
    model: modelID,
    url,
    headers,
    dims,
    signature: `${providerID}/${modelID}@${root}`,
  } satisfies Target
}

async function sync(cache: EmbeddingCache) {
  const next = active(await target())
  if (cache.model === next) return
  cache.model = next
  cache.embeddings = {}
}

async function remote(texts: string[], target: Target) {
  const body: Record<string, unknown> = {
    model: target.model,
    input: texts,
  }

  if (target.dims) body.dimensions = target.dims

  const response = await fetch(target.url, {
    method: "POST",
    headers: target.headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    throw new Error(`Embedding API error ${response.status}: ${await response.text()}`)
  }

  const data = (await response.json()) as {
    data?: Array<{
      embedding?: number[]
    }>
  }

  const embeddings = data.data?.map((item) => item.embedding).filter((item): item is number[] => Array.isArray(item))
  if (!embeddings || embeddings.length !== texts.length) {
    throw new Error("Embedding API returned an unexpected payload")
  }

  return embeddings
}

async function generate(texts: string[], cache: EmbeddingCache) {
  await sync(cache)
  const next = await target()
  if (next && cache.model !== SIMPLE_MODEL) {
    try {
      return await remote(texts, next)
    } catch (err) {
      console.warn("Embedding API failed, falling back to simple embedding:", err)
      mode().simple = true
      cache.model = SIMPLE_MODEL
      cache.embeddings = {}
    }
  }

  return Promise.all(texts.map((text) => generateSimpleEmbedding(text)))
}

/**
 * 获取缓存文件路径
 */
function getCachePath(): string {
  return path.join(Instance.directory, "atom_list", CACHE_FILE)
}

/**
 * 读取缓存
 */
export async function loadEmbeddingCache(): Promise<EmbeddingCache> {
  const cachePath = getCachePath()
  const next = active(await target())

  try {
    if (await Filesystem.exists(cachePath)) {
      const content = await Filesystem.readText(cachePath)
      const cache = JSON.parse(content) as EmbeddingCache

      // 版本检查
      if (cache.version === CACHE_VERSION && cache.model === next) {
        return cache
      }
    }
  } catch (error) {
    console.warn("Failed to load embedding cache:", error)
  }

  // 返回空缓存
  return {
    version: CACHE_VERSION,
    model: next,
    embeddings: {},
  }
}

/**
 * 保存缓存
 */
export async function saveEmbeddingCache(cache: EmbeddingCache): Promise<void> {
  const cachePath = getCachePath()

  try {
    await Filesystem.write(cachePath, JSON.stringify(cache, null, 2))
  } catch (error) {
    console.warn("Failed to save embedding cache:", error)
  }
}

/**
 * 获取 atom 的 embedding（从缓存或生成新的）
 */
export async function getAtomEmbedding(atomId: string, claimText: string, cache: EmbeddingCache): Promise<number[]> {
  await sync(cache)

  // 检查缓存
  const cached = cache.embeddings[atomId]
  if (cached) {
    return cached.claimEmbedding
  }

  // 生成新的 embedding
  const [embedding] = await generate([claimText], cache)

  // 更新缓存
  cache.embeddings[atomId] = {
    atomId,
    claimEmbedding: embedding,
    timestamp: Date.now(),
  }

  return embedding
}

/**
 * 生成文本的 embedding
 *
 * 默认 fallback 返回 384 维向量
 */
async function generateSimpleEmbedding(text: string): Promise<number[]> {
  // 1. 文本预处理
  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  // 2. 分词
  const words = normalized.split(" ")

  // 3. 生成固定维度的向量
  const dimension = SIMPLE_DIM
  const vector = new Array(dimension).fill(0)

  // 4. 简单的哈希映射到向量空间
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const hash = simpleHash(word)

    // 将单词映射到多个维度
    for (let j = 0; j < 3; j++) {
      const idx = (hash + j * 127) % dimension
      vector[idx] += 1.0 / Math.sqrt(words.length)
    }
  }

  // 5. L2 归一化
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0))
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] /= norm
    }
  }
  return vector
}

/**
 * 简单的字符串哈希函数
 */
function simpleHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash)
}

/**
 * 计算两个向量的余弦相似度
 */
export function cosineSimilarity(vec1: number[], vec2: number[]): number {
  if (vec1.length !== vec2.length) {
    throw new Error("Vectors must have the same dimension")
  }

  let dotProduct = 0
  let norm1 = 0
  let norm2 = 0

  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i]
    norm1 += vec1[i] * vec1[i]
    norm2 += vec2[i] * vec2[i]
  }

  const denominator = Math.sqrt(norm1) * Math.sqrt(norm2)
  if (denominator === 0) return 0

  return dotProduct / denominator
}

/**
 * 批量生成 embeddings
 */
export async function batchGenerateEmbeddings(
  items: Array<{ atomId: string; claimText: string }>,
  cache: EmbeddingCache,
): Promise<void> {
  await sync(cache)

  const needsEmbedding = items.filter((item) => !cache.embeddings[item.atomId])

  if (needsEmbedding.length === 0) {
    return
  }

  const size = 10

  for (let i = 0; i < needsEmbedding.length; i += size) {
    const batch = needsEmbedding.slice(i, i + size)
    const embeddings = await generate(
      batch.map((item) => item.claimText),
      cache,
    )

    for (const [idx, item] of batch.entries()) {
      cache.embeddings[item.atomId] = {
        atomId: item.atomId,
        claimEmbedding: embeddings[idx],
        timestamp: Date.now(),
      }
    }
  }

  await saveEmbeddingCache(cache)
}
