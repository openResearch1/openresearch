import { afterEach, beforeEach, expect, test } from "bun:test"

import { CollabAgentNode } from "../../src/collab/agent-node"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { AtomAgent } from "../../src/research/atom-agent"
import { AtomTable, ResearchProjectTable } from "../../src/research/research.sql"
import { Session } from "../../src/session"
import { Database, eq } from "../../src/storage/db"
import type { Tool } from "../../src/tool/tool"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

beforeEach(async () => resetDatabase())
afterEach(async () => resetDatabase())

test("atom deletion removes its session and collab peers", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const research = crypto.randomUUID()
      const atom = crypto.randomUUID()
      const now = Date.now()
      Database.use((db) => {
        db.insert(ResearchProjectTable)
          .values({ research_project_id: research, project_id: Instance.project.id, time_created: now, time_updated: now })
          .run()
        db.insert(AtomTable)
          .values({
            atom_id: atom,
            research_project_id: research,
            atom_name: "delete session",
            atom_type: "fact",
            atom_evidence_type: "math",
            atom_evidence_status: "pending",
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      const caller = await Session.create({ title: "research" })
      const owned = await AtomAgent.ensure(atom)
      const peer = await Session.createNext({ directory: tmp.path, title: "peer", collabPeer: true })
      const child = CollabAgentNode.create({
        id: Identifier.ascending("collab_agent"),
        sessionId: peer.id,
        parentAgentId: owned.agent.id,
        name: "peer",
        projectId: Instance.project.id,
        rootAgentId: owned.agent.id,
        subagentType: "general",
        spec: { initialPrompt: "" },
        status: "completed",
      })
      const tool = await import("../../src/tool/atom").then((mod) => mod.AtomDeleteTool.init())
      const ctx = {
        sessionID: caller.id,
        messageID: "message-1",
        callID: "call-1",
        agent: "research",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => {},
        ask: async () => {},
      } satisfies Tool.Context

      const result = await tool.execute({ atomIds: [atom] }, ctx)

      expect(result.metadata).toMatchObject({ deleted: true, deletedCount: 1 })
      expect(Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, atom)).get())).toBeUndefined()
      expect(await Session.get(owned.session.id).catch(() => undefined)).toBeUndefined()
      expect(await Session.get(peer.id).catch(() => undefined)).toBeUndefined()
      expect(CollabAgentNode.tryLoad(owned.agent.id)).toBeUndefined()
      expect(CollabAgentNode.tryLoad(child.id)).toBeUndefined()
      expect(await Session.get(caller.id)).toBeDefined()
    },
  })
})
