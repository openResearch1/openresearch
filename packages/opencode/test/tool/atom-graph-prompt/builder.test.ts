import { test, expect } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { Database } from "../../../src/storage/db"
import { AtomTable, AtomRelationTable, ResearchProjectTable } from "../../../src/research/research.sql"
import { buildPrompt, buildCommunityPrompt } from "../../../src/tool/atom-graph-prompt/builder"
import type { TraversedAtom, Community } from "../../../src/tool/atom-graph-prompt/types"
import path from "path"
import fs from "fs/promises"

function createResearchProject(projectId: string): string {
  const id = crypto.randomUUID()
  const now = Date.now()
  Database.use((db) => {
    db.insert(ResearchProjectTable)
      .values({ research_project_id: id, project_id: projectId, time_created: now, time_updated: now })
      .run()
  })
  return id
}

function mockAtom(
  overrides: Partial<{
    id: string
    name: string
    type: "fact" | "method" | "theorem" | "verification"
    claim: string
    evidence: string
    distance: number
  }>,
): TraversedAtom {
  const now = Date.now()
  return {
    atom: {
      atom_id: overrides.id ?? crypto.randomUUID(),
      research_project_id: "rp-1",
      atom_name: overrides.name ?? "Test Atom",
      atom_type: overrides.type ?? "method",
      atom_claim_path: null,
      atom_evidence_type: "math",
      atom_evidence_status: "pending",
      atom_evidence_path: null,
      atom_evidence_assessment_path: null,
      locked: false,
      article_id: null,
      session_id: null,
      time_created: now,
      time_updated: now,
    },
    claim: overrides.claim ?? "Default test claim",
    evidence: overrides.evidence ?? "Default evidence",
    distance: overrides.distance ?? 0,
    path: [],
    relationChain: [],
  }
}

function mockCommunity(overrides: Partial<Community> & { id: string }): Community {
  return {
    atomIds: [],
    summary: "A test community",
    keywords: ["test"],
    dominantType: "method",
    size: 2,
    density: 0.5,
    timestamp: Date.now(),
    ...overrides,
  }
}

// -------------------------------------------------------------------
// 1. GraphRAG Prompt 基础结构
// -------------------------------------------------------------------
test("buildPrompt graphrag should contain all sections", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      // 插入 atom 和关系到 DB，builder 的 extractRelationships 需要
      const now = Date.now()
      Database.use((db) => {
        db.insert(AtomTable)
          .values([
            {
              atom_id: `${p}-a`,
              research_project_id: rpId,
              atom_name: "Alpha Method",
              atom_type: "method",
              atom_evidence_type: "math",
              time_created: now,
              time_updated: now,
            },
            {
              atom_id: `${p}-b`,
              research_project_id: rpId,
              atom_name: "Beta Theorem",
              atom_type: "theorem",
              atom_evidence_type: "math",
              time_created: now,
              time_updated: now,
            },
          ])
          .run()
        db.insert(AtomRelationTable)
          .values([{ atom_id_source: `${p}-a`, atom_id_target: `${p}-b`, relation_type: "derives" }])
          .run()
      })

      const atoms: TraversedAtom[] = [
        mockAtom({
          id: `${p}-a`,
          name: "Alpha Method",
          type: "method",
          claim: "Alpha method claim",
          evidence: "Alpha evidence",
          distance: 0,
        }),
        mockAtom({ id: `${p}-b`, name: "Beta Theorem", type: "theorem", claim: "Beta theorem claim", distance: 1 }),
      ]

      const prompt = buildPrompt(atoms, { template: "graphrag", includeEvidence: true, includeMetadata: true })

      expect(prompt).toContain("# Research Context Graph")
      expect(prompt).toContain("## Atoms (Knowledge Units)")
      expect(prompt).toContain("Alpha Method")
      expect(prompt).toContain("Beta Theorem")
      expect(prompt).toContain("[method]")
      expect(prompt).toContain("[theorem]")
      expect(prompt).toContain("Alpha method claim")
      expect(prompt).toContain("Alpha evidence")
      expect(prompt).toContain("## Relationships")
      expect(prompt).toContain("Alpha Method --[derives]--> Beta Theorem")
      expect(prompt).toContain("## Instructions")
      expect(prompt).toContain("Distance from query: 0 hops")
      expect(prompt).toContain("Distance from query: 1 hops")
    },
  })
})

// -------------------------------------------------------------------
// 2. Compact Prompt 基础结构
// -------------------------------------------------------------------
test("buildPrompt compact should be concise", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      Database.use((db) => {
        db.insert(AtomTable)
          .values([
            {
              atom_id: `${p}-c1`,
              research_project_id: rpId,
              atom_name: "Compact A",
              atom_type: "fact",
              atom_evidence_type: "math",
              time_created: Date.now(),
              time_updated: Date.now(),
            },
          ])
          .run()
      })

      const atoms: TraversedAtom[] = [
        mockAtom({ id: `${p}-c1`, name: "Compact A", type: "fact", claim: "A compact claim here" }),
      ]

      const prompt = buildPrompt(atoms, { template: "compact", includeEvidence: false, includeMetadata: false })

      expect(prompt).toContain("Research Context:")
      expect(prompt).toContain("[fact]")
      expect(prompt).toContain("Compact A")
      // Compact should NOT contain GraphRAG headers
      expect(prompt).not.toContain("# Research Context Graph")
      expect(prompt).not.toContain("## Instructions")
    },
  })
})

// -------------------------------------------------------------------
// 3. includeEvidence=false 不输出 evidence
// -------------------------------------------------------------------
test("buildPrompt should omit evidence when disabled", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      createResearchProject(Instance.project.id)
      const atoms: TraversedAtom[] = [
        mockAtom({ name: "NoEvidence", claim: "Claim text", evidence: "SECRET_EVIDENCE_DATA" }),
      ]

      const prompt = buildPrompt(atoms, { template: "graphrag", includeEvidence: false, includeMetadata: true })

      expect(prompt).toContain("Claim text")
      expect(prompt).not.toContain("SECRET_EVIDENCE_DATA")
    },
  })
})

// -------------------------------------------------------------------
// 4. includeMetadata=false 不输出 metadata
// -------------------------------------------------------------------
test("buildPrompt should omit metadata when disabled", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      createResearchProject(Instance.project.id)
      const atoms: TraversedAtom[] = [mockAtom({ name: "NoMeta", claim: "Some claim", distance: 3 })]

      const prompt = buildPrompt(atoms, { template: "graphrag", includeEvidence: true, includeMetadata: false })

      expect(prompt).toContain("Some claim")
      expect(prompt).not.toContain("Distance from query")
      expect(prompt).not.toContain("**Metadata:**")
    },
  })
})

// -------------------------------------------------------------------
// 5. buildCommunityPrompt graphrag 模板
// -------------------------------------------------------------------
test("buildCommunityPrompt graphrag should include community structure", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const rpId = createResearchProject(Instance.project.id)
      const p = crypto.randomUUID().slice(0, 8)

      // DB 数据用于 extractRelationships
      const now = Date.now()
      Database.use((db) => {
        db.insert(AtomTable)
          .values([
            {
              atom_id: `${p}-ca1`,
              research_project_id: rpId,
              atom_name: "Comm Atom 1",
              atom_type: "method",
              atom_evidence_type: "math",
              time_created: now,
              time_updated: now,
            },
            {
              atom_id: `${p}-ca2`,
              research_project_id: rpId,
              atom_name: "Comm Atom 2",
              atom_type: "theorem",
              atom_evidence_type: "math",
              time_created: now,
              time_updated: now,
            },
          ])
          .run()
        db.insert(AtomRelationTable)
          .values([{ atom_id_source: `${p}-ca1`, atom_id_target: `${p}-ca2`, relation_type: "analyzes" }])
          .run()
      })

      const communities: Community[] = [
        mockCommunity({
          id: "comm-1",
          atomIds: [`${p}-ca1`, `${p}-ca2`],
          summary: "Optimization methods community",
          keywords: ["SGD", "Adam"],
          dominantType: "method",
          size: 2,
          density: 0.8,
        }),
      ]

      const atomsByCommunity = new Map<string, TraversedAtom[]>()
      atomsByCommunity.set("comm-1", [
        mockAtom({ id: `${p}-ca1`, name: "Comm Atom 1", type: "method", claim: "Method claim" }),
        mockAtom({ id: `${p}-ca2`, name: "Comm Atom 2", type: "theorem", claim: "Theorem claim" }),
      ])

      const prompt = buildCommunityPrompt(communities, atomsByCommunity, {
        template: "graphrag",
        includeEvidence: false,
        includeMetadata: true,
      })

      expect(prompt).toContain("# Research Context Graph (Community View)")
      expect(prompt).toContain("## Communities Overview")
      expect(prompt).toContain("Optimization methods community")
      expect(prompt).toContain("SGD, Adam")
      expect(prompt).toContain("80.0%") // density
      expect(prompt).toContain("## Detailed Community Content")
      expect(prompt).toContain("Comm Atom 1")
      expect(prompt).toContain("Comm Atom 2")
      expect(prompt).toContain("## Relationships")
      expect(prompt).toContain("Comm Atom 1 --[analyzes]--> Comm Atom 2")
      expect(prompt).toContain("## Instructions")
      expect(prompt).toContain("community")
    },
  })
})

// -------------------------------------------------------------------
// 6. buildCommunityPrompt compact 模板
// -------------------------------------------------------------------
test("buildCommunityPrompt compact should be concise", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      createResearchProject(Instance.project.id)

      const communities: Community[] = [
        mockCommunity({
          id: "cc-1",
          summary: "Compact community summary",
          dominantType: "fact",
          size: 3,
        }),
      ]

      const atomsByCommunity = new Map<string, TraversedAtom[]>()
      atomsByCommunity.set("cc-1", [mockAtom({ name: "Compact C1", type: "fact", claim: "Compact claim text here" })])

      const prompt = buildCommunityPrompt(communities, atomsByCommunity, {
        template: "compact",
        includeEvidence: false,
        includeMetadata: false,
      })

      expect(prompt).toContain("Research Context (1 communities):")
      expect(prompt).toContain("Community 1 [fact, 3 atoms]:")
      expect(prompt).toContain("Compact community summary")
      expect(prompt).toContain("[fact] Compact C1")
      // Should NOT have graphrag headers
      expect(prompt).not.toContain("# Research Context Graph")
    },
  })
})

// -------------------------------------------------------------------
// 7. buildCommunityPrompt 多社区
// -------------------------------------------------------------------
test("buildCommunityPrompt should handle multiple communities", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      createResearchProject(Instance.project.id)

      const communities: Community[] = [
        mockCommunity({ id: "mc-1", summary: "First community", dominantType: "method", size: 2 }),
        mockCommunity({ id: "mc-2", summary: "Second community", dominantType: "theorem", size: 3 }),
      ]

      const atomsByCommunity = new Map<string, TraversedAtom[]>()
      atomsByCommunity.set("mc-1", [mockAtom({ name: "M1 Atom", type: "method", claim: "M1 claim" })])
      atomsByCommunity.set("mc-2", [mockAtom({ name: "T1 Atom", type: "theorem", claim: "T1 claim" })])

      const prompt = buildCommunityPrompt(communities, atomsByCommunity, {
        template: "graphrag",
        includeEvidence: false,
        includeMetadata: false,
      })

      expect(prompt).toContain("2 communities")
      expect(prompt).toContain("Community 1:")
      expect(prompt).toContain("Community 2:")
      expect(prompt).toContain("First community")
      expect(prompt).toContain("Second community")
      expect(prompt).toContain("M1 Atom")
      expect(prompt).toContain("T1 Atom")
    },
  })
})

// -------------------------------------------------------------------
// 8. buildCommunityPrompt 空社区内容
// -------------------------------------------------------------------
test("buildCommunityPrompt should skip communities with no atoms", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      createResearchProject(Instance.project.id)

      const communities: Community[] = [mockCommunity({ id: "empty-c", summary: "Empty community", size: 0 })]

      const atomsByCommunity = new Map<string, TraversedAtom[]>()
      // 不为 empty-c 添加 atoms

      const prompt = buildCommunityPrompt(communities, atomsByCommunity, {
        template: "graphrag",
        includeEvidence: false,
        includeMetadata: false,
      })

      // 应该有概览但没有详细 atom 内容
      expect(prompt).toContain("Empty community")
      expect(prompt).not.toContain("#### Atom")
    },
  })
})

// -------------------------------------------------------------------
// 9. buildPrompt 空 atoms 列表
// -------------------------------------------------------------------
test("buildPrompt should handle empty atom list gracefully", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      createResearchProject(Instance.project.id)

      const prompt = buildPrompt([], { template: "graphrag", includeEvidence: true, includeMetadata: true })

      expect(prompt).toContain("# Research Context Graph")
      expect(prompt).not.toContain("### Atom 1:")
    },
  })
})
