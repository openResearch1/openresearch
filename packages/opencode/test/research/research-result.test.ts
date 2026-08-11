import { describe, expect, test } from "bun:test"

import { Agent } from "../../src/agent/agent"
import { Collab } from "../../src/collab"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { ResearchResult } from "../../src/research/research-result"
import { ResearchResultTable } from "../../src/research/research-result.sql"
import { AtomTable, ResearchProjectTable } from "../../src/research/research.sql"
import { ResearchSessionAgent } from "../../src/research/session-agent"
import { ResearchRoutes } from "../../src/server/routes/research"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Database, eq } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

async function seed() {
  const research = crypto.randomUUID()
  const main = await Session.create({ title: "Research" })
  const review = await Session.create({ title: "Review" })
  const root = await Collab.ensureRootFromSession(main.id, {
    name: "Research",
    subagentType: "research",
    spec: { initialPrompt: "" },
  })
  const atoms = [
    { id: crypto.randomUUID(), name: "Constructive method" },
    { id: crypto.randomUUID(), name: "Verified property" },
  ]
  const node = CollabAgentNode.create({
    id: crypto.randomUUID(),
    sessionId: review.id,
    parentAgentId: root.id,
    name: "Review result",
    projectId: Instance.project.id,
    rootAgentId: root.id,
    subagentType: "reviewer",
    spec: { initialPrompt: `EXACT_REVIEW_ATOM_IDS=${JSON.stringify(atoms.map((atom) => atom.id))}` },
  })
  const now = Date.now()
  Database.use((db) => {
    db.insert(ResearchProjectTable)
      .values({ research_project_id: research, project_id: Instance.project.id, time_created: now, time_updated: now })
      .run()
    db.insert(AtomTable)
      .values(
        atoms.map((atom, index) => ({
          atom_id: atom.id,
          research_project_id: research,
          atom_name: atom.name,
          atom_type: index ? ("verification" as const) : ("method" as const),
          atom_evidence_type: index ? ("experiment" as const) : ("math" as const),
          atom_evidence_status: "proven" as const,
          time_created: now,
          time_updated: now,
        })),
      )
      .run()
  })
  return { research, main, review, root, node, atoms }
}

async function reviewer(parent: Awaited<ReturnType<typeof seed>>["root"], atomIDs: string[]) {
  const session = await Session.create({ title: "Another review" })
  CollabAgentNode.create({
    id: crypto.randomUUID(),
    sessionId: session.id,
    parentAgentId: parent.id,
    name: "Another review",
    projectId: Instance.project.id,
    rootAgentId: parent.id,
    subagentType: "reviewer",
    spec: { initialPrompt: `EXACT_REVIEW_ATOM_IDS=${JSON.stringify(atomIDs)}` },
  })
  return session
}

describe("research.result", () => {
  test("Reviewer submits a proven subset, locks Atoms, and retries idempotently", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const input = {
          sessionID: item.review.id,
          agent: "reviewer",
          atomIDs: item.atoms.map((atom) => atom.id),
          title: "Accepted contribution",
          summary: "## Result\n\nThe reviewed subset forms one contribution.",
          evaluation: "## Evaluation\n\nThe evidence supports both claims.",
        }
        const first = await ResearchResult.submit(input)
        const second = await ResearchResult.submit(input)

        expect(second.research_result_id).toBe(first.research_result_id)
        expect(first.source_session_id).toBe(item.main.id)
        expect(first.reviewer_session_id).toBe(item.review.id)
        expect(first.atoms.map((atom) => atom.atom_id)).toEqual(item.atoms.map((atom) => atom.id))
        expect(
          Database.use((db) =>
            db.select().from(AtomTable).where(eq(AtomTable.research_project_id, item.research)).all(),
          ).every((atom) => atom.locked),
        ).toBe(true)
        expect(Database.use((db) => db.select().from(ResearchResultTable).all())).toHaveLength(1)
        await expect(ResearchResult.submit({ ...input, title: "Different result" })).rejects.toThrow(
          "already submitted a different",
        )

        Database.use((db) =>
          db
            .update(AtomTable)
            .set({ atom_name: "Human revision", locked: false, time_updated: Date.now() })
            .where(eq(AtomTable.atom_id, item.atoms[0].id))
            .run(),
        )
        const current = ResearchResult.get(item.research, first.research_result_id)!
        expect(current.atoms[0]).toMatchObject({ atom_name: "Human revision", locked: false })

        const response = await ResearchRoutes.request(`/project/${item.research}/results`)
        expect(response.status).toBe(200)
        expect(await response.json()).toHaveLength(1)
      },
    })
  })

  test("rejects unproven Atoms and non-Reviewer submissions but allows overlap", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const base = {
          sessionID: item.review.id,
          agent: "reviewer",
          atomIDs: item.atoms.map((atom) => atom.id),
          title: "Result",
          summary: "Supported result.",
          evaluation: "Meaningful contribution.",
        }
        await expect(ResearchResult.submit({ ...base, agent: "research" })).rejects.toThrow("only be submitted")
        await expect(ResearchResult.submit({ ...base, atomIDs: [item.atoms[0].id] })).rejects.toThrow(
          "exact assigned Atom subset",
        )

        Database.use((db) =>
          db
            .update(AtomTable)
            .set({ atom_evidence_status: "in_progress", time_updated: Date.now() })
            .where(eq(AtomTable.atom_id, item.atoms[0].id))
            .run(),
        )
        await expect(ResearchResult.submit(base)).rejects.toThrow("must have proven")
        Database.use((db) =>
          db
            .update(AtomTable)
            .set({ atom_evidence_status: "proven", time_updated: Date.now() })
            .where(eq(AtomTable.atom_id, item.atoms[0].id))
            .run(),
        )

        await ResearchResult.submit(base)
        const subset = [item.atoms[0].id]
        const next = await reviewer(item.root, subset)
        await ResearchResult.submit({
          ...base,
          sessionID: next.id,
          atomIDs: subset,
          title: "Overlapping result",
        })
        expect(ResearchResult.list(item.research)).toHaveLength(2)
      },
    })
  })

  test("Reviewer is read-only and its Collab Session is pinned", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const agent = await Agent.get("reviewer")
        expect(agent?.mode).toBe("subagent")
        expect(agent?.prompt).toContain("exact subset")
        expect(PermissionNext.evaluate("atom_query", "*", agent!.permission).action).toBe("allow")
        expect(PermissionNext.evaluate("research_result_submit", "*", agent!.permission).action).toBe("allow")
        expect(PermissionNext.evaluate("atom_status_update", "*", agent!.permission).action).toBe("deny")
        expect(PermissionNext.evaluate("edit", "*", agent!.permission).action).toBe("deny")
        expect(await ResearchSessionAgent.policy(item.review.id)).toMatchObject({
          kind: "reviewer",
          agents: ["reviewer"],
          default: "reviewer",
          pinned: true,
        })

        const message = await SessionPrompt.prompt({
          sessionID: item.review.id,
          agent: "build",
          model: { providerID: "test", modelID: "test" },
          noReply: true,
          parts: [{ type: "text", text: "change this result" }],
        })
        expect(message.info.role).toBe("user")
        if (message.info.role !== "user") throw new Error("expected user message")
        expect(message.info.agent).toBe("reviewer")
      },
    })
  })
})
