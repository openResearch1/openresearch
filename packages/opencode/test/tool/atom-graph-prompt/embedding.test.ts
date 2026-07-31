import path from "path"
import fs from "fs/promises"

import { test, expect } from "bun:test"

import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import {
  loadEmbeddingCache,
  saveEmbeddingCache,
  getAtomEmbedding,
  cosineSimilarity,
  batchGenerateEmbeddings,
  pruneEmbeddingCache,
} from "../../../src/tool/atom-graph-prompt/embedding"

test("should generate and cache embeddings", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fs.mkdir(path.join(tmp.path, "atom_list"), { recursive: true })

      const cache = await loadEmbeddingCache()
      expect(cache.version).toBe("3.0")
      expect(Object.keys(cache.embeddings)).toHaveLength(0)

      // Generate embedding
      const embedding = await getAtomEmbedding("atom-1", "machine learning optimization", cache)

      // Verify dimension
      expect(embedding).toHaveLength(384)

      // Verify cached
      expect(cache.embeddings["atom-1"]).toBeDefined()
      expect(cache.embeddings["atom-1"].claimEmbedding).toEqual(embedding)
      const hash = cache.embeddings["atom-1"].contentHash

      // Changed text should replace the stale cached embedding.
      const updated = await getAtomEmbedding("atom-1", "different text", cache)
      expect(updated).not.toEqual(embedding)
      expect(cache.embeddings["atom-1"].contentHash).not.toBe(hash)
    },
  })
})

test("should calculate cosine similarity correctly", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fs.mkdir(path.join(tmp.path, "atom_list"), { recursive: true })

      const cache = await loadEmbeddingCache()

      // Similar texts
      const emb1 = await getAtomEmbedding("a1", "deep learning neural network training", cache)
      const emb2 = await getAtomEmbedding("a2", "neural network deep learning model", cache)
      const similarity = cosineSimilarity(emb1, emb2)

      expect(similarity).toBeGreaterThan(0)
      expect(similarity).toBeLessThanOrEqual(1)

      // Identical text should have similarity 1
      const self = cosineSimilarity(emb1, emb1)
      expect(self).toBeCloseTo(1.0, 5)

      // Different dimension vectors should throw
      expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow("Vectors must have the same dimension")
    },
  })
})

test("should distinguish different topics", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fs.mkdir(path.join(tmp.path, "atom_list"), { recursive: true })

      const cache = await loadEmbeddingCache()

      const emb1 = await getAtomEmbedding("t1", "machine learning gradient descent optimization algorithm", cache)
      const emb2 = await getAtomEmbedding("t2", "quantum physics wave function entanglement experiment", cache)

      const crossSim = cosineSimilarity(emb1, emb2)
      const selfSim = cosineSimilarity(emb1, emb1)

      // Different topics should have lower similarity than self
      expect(crossSim).toBeLessThan(selfSim)
    },
  })
})

test("should persist cache to file", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fs.mkdir(path.join(tmp.path, "atom_list"), { recursive: true })

      // Generate and save
      const cache = await loadEmbeddingCache()
      await getAtomEmbedding("persist-1", "test text for persistence", cache)
      await saveEmbeddingCache(cache)

      // Reload and verify
      const loaded = await loadEmbeddingCache()
      expect(loaded.version).toBe("3.0")
      expect(loaded.embeddings["persist-1"]).toBeDefined()
      expect(loaded.embeddings["persist-1"].claimEmbedding).toHaveLength(384)
      expect(loaded.embeddings["persist-1"].dimensions).toBe(384)
      expect(loaded.embeddings["persist-1"].contentHash).toBeString()
    },
  })
})

test("should handle empty and special text", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fs.mkdir(path.join(tmp.path, "atom_list"), { recursive: true })

      const cache = await loadEmbeddingCache()

      // Empty text
      const emptyEmb = await getAtomEmbedding("empty", "", cache)
      expect(emptyEmb).toHaveLength(384)

      // Chinese text
      const zhEmb = await getAtomEmbedding("zh", "深度学习模型训练优化方法", cache)
      expect(zhEmb).toHaveLength(384)

      // Mixed text
      const mixedEmb = await getAtomEmbedding("mixed", "Transformer 架构的改进方法 with attention", cache)
      expect(mixedEmb).toHaveLength(384)
    },
  })
})

test("should batch generate embeddings", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fs.mkdir(path.join(tmp.path, "atom_list"), { recursive: true })

      const cache = await loadEmbeddingCache()

      await batchGenerateEmbeddings(
        [
          { atomId: "batch-1", claimText: "first claim" },
          { atomId: "batch-2", claimText: "second claim" },
          { atomId: "batch-3", claimText: "third claim" },
        ],
        cache,
      )

      expect(cache.embeddings["batch-1"]).toBeDefined()
      expect(cache.embeddings["batch-2"]).toBeDefined()
      expect(cache.embeddings["batch-3"]).toBeDefined()

      // Verify saved to file
      const loaded = await loadEmbeddingCache()
      expect(loaded.embeddings["batch-1"]).toBeDefined()
    },
  })
})

test("should not persist query embeddings", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cache = await loadEmbeddingCache()
      const embedding = await getAtomEmbedding("query:test", "test query", cache, { persist: false })
      await saveEmbeddingCache(cache)

      expect(embedding).toHaveLength(384)
      expect(cache.embeddings["query:test"]).toBeUndefined()
      expect((await loadEmbeddingCache()).embeddings["query:test"]).toBeUndefined()
    },
  })
})

test("should prune embeddings for deleted atoms", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cache = await loadEmbeddingCache()
      await getAtomEmbedding("kept", "active claim", cache)
      await getAtomEmbedding("removed", "deleted claim", cache)
      pruneEmbeddingCache(cache, ["kept"])
      await saveEmbeddingCache(cache)

      const loaded = await loadEmbeddingCache()
      expect(loaded.embeddings.kept).toBeDefined()
      expect(loaded.embeddings.removed).toBeUndefined()
    },
  })
})

test("should merge concurrent cache updates", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const left = await loadEmbeddingCache()
      const right = await loadEmbeddingCache()
      await getAtomEmbedding("left", "left claim", left)
      await getAtomEmbedding("right", "right claim", right)
      await Promise.all([saveEmbeddingCache(left), saveEmbeddingCache(right)])

      const loaded = await loadEmbeddingCache()
      expect(loaded.embeddings.left).toBeDefined()
      expect(loaded.embeddings.right).toBeDefined()
    },
  })
})
