import fs from "fs/promises"
import path from "path"
import { expect, test } from "bun:test"

import { Instance } from "../../../src/project/instance"
import { ArticleTable, AtomRelationTable, AtomTable, ResearchProjectTable } from "../../../src/research/research.sql"
import { Database } from "../../../src/storage/db"
import { compareArticleCommunities } from "../../../src/tool/atom-graph-prompt/community"
import { Filesystem } from "../../../src/util/filesystem"
import { tmpdir } from "../../fixture/fixture"

function research(projectId: string) {
  const id = crypto.randomUUID()
  const now = Date.now()
  Database.use((db) => {
    db.insert(ResearchProjectTable)
      .values({ research_project_id: id, project_id: projectId, time_created: now, time_updated: now })
      .run()
  })
  return id
}

type Seed = {
  id: string
  name: string
  type: "fact" | "method" | "theorem" | "verification"
  claim: string
  articleId: string
}

async function graph(
  rpId: string,
  dir: string,
  atoms: Seed[],
  rels: Array<{
    source: string
    target: string
    type: "motivates" | "formalizes" | "derives" | "analyzes" | "validates" | "contradicts" | "other"
  }>,
) {
  const now = Date.now()
  Database.use((db) => {
    const articleIds = [...new Set(atoms.map((atom) => atom.articleId))]

    db.insert(ArticleTable)
      .values(
        articleIds.map((articleId) => ({
          article_id: articleId,
          research_project_id: rpId,
          path: `${articleId}.md`,
          title: articleId,
          status: "parsed" as const,
          time_created: now,
          time_updated: now,
        })),
      )
      .run()

    db.insert(AtomTable)
      .values(
        atoms.map((atom) => ({
          atom_id: atom.id,
          research_project_id: rpId,
          article_id: atom.articleId,
          atom_name: atom.name,
          atom_type: atom.type,
          atom_evidence_type: atom.type === "verification" ? ("experiment" as const) : ("math" as const),
          atom_claim_path: path.join(dir, `${atom.id}-claim.txt`),
          atom_evidence_path: path.join(dir, `${atom.id}-evidence.txt`),
          time_created: now,
          time_updated: now,
        })),
      )
      .run()

    if (rels.length > 0) {
      db.insert(AtomRelationTable)
        .values(rels.map((rel) => ({ atom_id_source: rel.source, atom_id_target: rel.target, relation_type: rel.type })))
        .run()
    }
  })

  for (const atom of atoms) {
    await Filesystem.write(path.join(dir, `${atom.id}-claim.txt`), atom.claim)
    await Filesystem.write(path.join(dir, `${atom.id}-evidence.txt`), `Evidence for ${atom.name}`)
  }
}

test(
  "should score similar articles above unrelated ones",
  async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = research(Instance.project.id)
      const a = crypto.randomUUID().slice(0, 8)
      const b = crypto.randomUUID().slice(0, 8)
      const c = crypto.randomUUID().slice(0, 8)

      await graph(
        rpId,
        dir,
        [
          {
            id: `${a}-m1`,
            articleId: a,
            name: "Stable Gradient Method",
            type: "method",
            claim: "Gradient optimization method for stable neural network training",
          },
          {
            id: `${a}-t1`,
            articleId: a,
            name: "Gradient Convergence Theorem",
            type: "theorem",
            claim: "Convergence theorem for stable gradient optimization",
          },
          {
            id: `${a}-v1`,
            articleId: a,
            name: "Stable Training Benchmark",
            type: "verification",
            claim: "Benchmark validates stable gradient optimization during training",
          },
          {
            id: `${b}-m1`,
            articleId: b,
            name: "Robust Gradient Updates",
            type: "method",
            claim: "Gradient optimization method for stable neural network training",
          },
          {
            id: `${b}-t1`,
            articleId: b,
            name: "Optimization Convergence Analysis",
            type: "theorem",
            claim: "Convergence theorem for stable gradient optimization",
          },
          {
            id: `${b}-v1`,
            articleId: b,
            name: "Training Stability Evaluation",
            type: "verification",
            claim: "Benchmark validates stable gradient optimization during training",
          },
          {
            id: `${c}-f1`,
            articleId: c,
            name: "Gene Sequencing Fact",
            type: "fact",
            claim: "DNA sequencing fact for genome assembly research",
          },
          {
            id: `${c}-m1`,
            articleId: c,
            name: "Cell Imaging Fact",
            type: "fact",
            claim: "Microscope imaging fact for cell membrane biology",
          },
          {
            id: `${c}-v1`,
            articleId: c,
            name: "Protein Assay Fact",
            type: "fact",
            claim: "Protein assay fact for laboratory biology observations",
          },
        ],
        [
          { source: `${a}-m1`, target: `${a}-t1`, type: "derives" },
          { source: `${a}-t1`, target: `${a}-v1`, type: "validates" },
          { source: `${a}-m1`, target: `${a}-v1`, type: "analyzes" },
          { source: `${b}-m1`, target: `${b}-t1`, type: "derives" },
          { source: `${b}-t1`, target: `${b}-v1`, type: "validates" },
          { source: `${b}-m1`, target: `${b}-v1`, type: "analyzes" },
        ],
      )

      const similar = await compareArticleCommunities(a, b, { coverageThreshold: 0.45 })
      const distant = await compareArticleCommunities(a, c)

      expect(similar.similarity).toBeGreaterThan(distant.similarity)
      expect(similar.similarity - distant.similarity).toBeGreaterThan(0.1)
      expect(similar.directional.leftToRight.coverage).toBe(1)
      expect(similar.directional.rightToLeft.coverage).toBe(1)
    },
  })
  },
  { timeout: 30000 },
)

test(
  "should handle split and merged communities with directional best match",
  async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = research(Instance.project.id)
      const left = crypto.randomUUID().slice(0, 8)
      const right = crypto.randomUUID().slice(0, 8)

      await graph(
        rpId,
        dir,
        [
          {
            id: `${left}-1`,
            articleId: left,
            name: "Context Memory Method",
            type: "method",
            claim: "Context memory retrieval method for long context reasoning",
          },
          {
            id: `${left}-2`,
            articleId: left,
            name: "Memory Compression Theorem",
            type: "theorem",
            claim: "Theorem about memory compression for long context retrieval",
          },
          {
            id: `${left}-3`,
            articleId: left,
            name: "Retrieval Verification",
            type: "verification",
            claim: "Verification benchmark for long context retrieval memory",
          },
          {
            id: `${left}-4`,
            articleId: left,
            name: "Context Distillation Fact",
            type: "fact",
            claim: "Fact about context distillation and memory retrieval",
          },
          {
            id: `${right}-1`,
            articleId: right,
            name: "Memory Retrieval Method",
            type: "method",
            claim: "Long context memory retrieval method",
          },
          {
            id: `${right}-2`,
            articleId: right,
            name: "Retrieval Proof",
            type: "theorem",
            claim: "Proof for long context memory retrieval quality",
          },
          {
            id: `${right}-3`,
            articleId: right,
            name: "Compression Verification",
            type: "verification",
            claim: "Verification for context compression and retrieval memory",
          },
          {
            id: `${right}-4`,
            articleId: right,
            name: "Context Compression Fact",
            type: "fact",
            claim: "Fact about context compression for long context retrieval",
          },
        ],
        [
          { source: `${left}-1`, target: `${left}-2`, type: "derives" },
          { source: `${left}-2`, target: `${left}-3`, type: "validates" },
          { source: `${left}-3`, target: `${left}-4`, type: "analyzes" },
          { source: `${left}-4`, target: `${left}-1`, type: "motivates" },
          { source: `${left}-1`, target: `${left}-3`, type: "analyzes" },
          { source: `${left}-2`, target: `${left}-4`, type: "formalizes" },
          { source: `${right}-1`, target: `${right}-2`, type: "derives" },
          { source: `${right}-2`, target: `${right}-1`, type: "analyzes" },
          { source: `${right}-3`, target: `${right}-4`, type: "validates" },
          { source: `${right}-4`, target: `${right}-3`, type: "motivates" },
        ],
      )

      const report = await compareArticleCommunities(left, right, { coverageThreshold: 0.45 })

      expect(report.articles.left.communityCount).toBe(1)
      expect(report.articles.right.communityCount).toBe(2)
      expect(report.similarity).toBeGreaterThan(0.45)
      expect(report.directional.leftToRight.coverage).toBe(1)
      expect(report.directional.rightToLeft.coverage).toBe(1)
      expect(report.similarity).toBeCloseTo(
        (report.directional.leftToRight.score + report.directional.rightToLeft.score) / 2,
        4,
      )
    },
  })
  },
  { timeout: 30000 },
)

test(
  "should return zero similarity when one article has no atoms",
  async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dir = path.join(tmp.path, "atom_list")
      await fs.mkdir(dir, { recursive: true })

      const rpId = research(Instance.project.id)
      const left = crypto.randomUUID().slice(0, 8)
      const right = crypto.randomUUID().slice(0, 8)

      await graph(rpId, dir, [
        {
          id: `${left}-1`,
          articleId: left,
          name: "Optimization Method",
          type: "method",
          claim: "Optimization method for stable training",
        },
      ], [])

      const report = await compareArticleCommunities(left, right)

      expect(report.similarity).toBe(0)
      expect(report.articles.left.atomCount).toBe(1)
      expect(report.articles.right.atomCount).toBe(0)
      expect(report.directional.leftToRight.score).toBe(0)
      expect(report.directional.rightToLeft.score).toBe(0)
    },
  })
  },
  { timeout: 30000 },
)
