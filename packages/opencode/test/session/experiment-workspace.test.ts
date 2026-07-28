import path from "path"
import { describe, expect, test } from "bun:test"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { ExperimentTable, ResearchProjectTable } from "../../src/research/research.sql"
import { ExperimentWorkspace } from "../../src/session/experiment-workspace"
import { SessionTable } from "../../src/session/session.sql"
import { Database } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

describe("session.experiment-workspace", () => {
  test("resolves compact code context for sessions, tasks, and collab peers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = Identifier.descending("session")
        const child = Identifier.descending("session")
        const peer = Identifier.descending("session")
        const nested = Identifier.descending("session")
        const research = crypto.randomUUID()
        const exp = crypto.randomUUID()
        const code = path.join(tmp.path, ".openresearch_worktrees", exp)
        const now = Date.now()

        Database.use((db) =>
          db
            .insert(SessionTable)
            .values([
              {
                id: root,
                project_id: Instance.project.id,
                slug: "experiment",
                directory: tmp.path,
                title: "experiment",
                version: "test",
                time_created: now,
                time_updated: now,
              },
              {
                id: child,
                project_id: Instance.project.id,
                parent_id: root,
                slug: "task",
                directory: tmp.path,
                title: "task",
                version: "test",
                time_created: now,
                time_updated: now,
              },
              {
                id: peer,
                project_id: Instance.project.id,
                slug: "peer",
                directory: tmp.path,
                title: "peer",
                version: "test",
                time_created: now,
                time_updated: now,
              },
              {
                id: nested,
                project_id: Instance.project.id,
                parent_id: peer,
                slug: "nested-task",
                directory: tmp.path,
                title: "nested task",
                version: "test",
                time_created: now,
                time_updated: now,
              },
            ])
            .run(),
        )

        Database.use((db) =>
          db
            .insert(ResearchProjectTable)
            .values({ research_project_id: research, project_id: Instance.project.id })
            .run(),
        )
        Database.use((db) =>
          db
            .insert(ExperimentTable)
            .values({
              exp_id: exp,
              research_project_id: research,
              exp_name: "workspace test",
              exp_session_id: root,
              code_path: code,
              remote_code_path: "/remote/experiments/workspace-test",
            })
            .run(),
        )

        const rootID = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: rootID,
          sessionId: root,
          parentAgentId: null,
          name: "root",
          projectId: Instance.project.id,
          rootAgentId: rootID,
          subagentType: "experiment",
          spec: { initialPrompt: "" },
        })
        CollabAgentNode.create({
          id: Identifier.ascending("collab_agent"),
          sessionId: peer,
          parentAgentId: rootID,
          name: "peer",
          projectId: Instance.project.id,
          rootAgentId: rootID,
          subagentType: "general",
          spec: { initialPrompt: "" },
        })

        const expected = `<experiment-workspace code_path=${JSON.stringify(code)}>Use code_path for experiment code operations. Other workspace files may be read for context.</experiment-workspace>`
        expect(ExperimentWorkspace.prompt(root)).toBe(expected)
        expect(ExperimentWorkspace.prompt(child)).toBe(expected)
        expect(ExperimentWorkspace.prompt(peer)).toBe(expected)
        expect(ExperimentWorkspace.prompt(nested)).toBe(expected)
        expect(expected.split("\n")).toHaveLength(1)
        expect(ExperimentWorkspace.resolve(peer)).toMatchObject({
          exp_id: exp,
          remote_code_path: "/remote/experiments/workspace-test",
        })
      },
    })
  })
})
