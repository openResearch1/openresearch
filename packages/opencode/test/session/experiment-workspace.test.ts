import path from "path"
import { describe, expect, test } from "bun:test"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { ExperimentExecutionWatch } from "../../src/research/experiment-execution-watch"
import { AtomTable, ExperimentTable, ResearchProjectTable } from "../../src/research/research.sql"
import { ResearchRoutes } from "../../src/server/routes/research"
import { ExperimentWorkspace } from "../../src/session/experiment-workspace"
import { SessionTable } from "../../src/session/session.sql"
import { Database } from "../../src/storage/db"
import { AtomQueryTool } from "../../src/tool/atom"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

describe("session.experiment-workspace", () => {
  test("resolves code context and policy for sessions, tasks, and collab peers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = Identifier.descending("session")
        const child = Identifier.descending("session")
        const peer = Identifier.descending("session")
        const nested = Identifier.descending("session")
        const research = crypto.randomUUID()
        const atom = crypto.randomUUID()
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
            .insert(AtomTable)
            .values({
              atom_id: atom,
              research_project_id: research,
              atom_name: "workspace atom",
              atom_type: "verification",
              atom_evidence_type: "experiment",
            })
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
              atom_id: atom,
              code_path: code,
              remote_code_path: "/remote/experiments/workspace-test",
            })
            .run(),
        )
        ExperimentExecutionWatch.createOrGet(exp, "workspace test")
        ExperimentExecutionWatch.update({ expId: exp, status: "finished" })
        expect(Database.use((db) => db.select().from(ExperimentTable).all())[0]).toMatchObject({
          exp_id: exp,
          status: "done",
          finished_at: expect.any(Number),
        })

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

        const workspace = `<experiment-workspace code_path=${JSON.stringify(code)}>Use code_path for experiment code operations. Other workspace files may be read for context.</experiment-workspace>`
        const prompts = [
          ExperimentWorkspace.prompt(root, "experiment"),
          ExperimentWorkspace.prompt(child, "experiment_plan"),
          ExperimentWorkspace.prompt(peer, "general"),
          ExperimentWorkspace.prompt(nested, "explore"),
        ]
        expect(new Set(prompts).size).toBe(1)
        expect(prompts[0]).toContain(workspace)
        expect(prompts[0]).toContain("## Experiment code editing")
        expect(prompts[0]).toContain("Treat each request as a delta over the inherited baseline")
        expect(prompts[0]).toContain("Treat values and choices specific to one run as runtime inputs")
        expect(prompts[0]).toContain("Do not create or run local unit or integration tests")
        expect(ExperimentWorkspace.prompt(root, "project_runtime_env_setup")).toBe(workspace)
        expect(ExperimentWorkspace.prompt(root, "experiment_resource_prepare")).toBe(workspace)
        expect(ExperimentWorkspace.prompt(Identifier.descending("session"), "experiment")).toBeUndefined()
        expect(ExperimentWorkspace.resolve(peer)).toMatchObject({
          exp_id: exp,
          remote_code_path: "/remote/experiments/workspace-test",
        })

        for (const id of [root, child, peer, nested]) {
          const response = await ResearchRoutes.request(`/experiment/session/${id}`)
          expect(response.status).toBe(200)
          expect(await response.json()).toMatchObject({ exp_id: exp, status: "done", atom: { atom_id: atom } })
        }

        const tool = await AtomQueryTool.init()
        const result = await tool.execute(
          {},
          {
            sessionID: nested,
            messageID: "message-1",
            callID: "call-1",
            agent: "general",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            ask: async () => {},
          } satisfies Tool.Context,
        )
        expect(result.metadata).toMatchObject({ count: 1 })
        expect(result.output).toContain(`atom_id: ${atom}`)
      },
    })
  })
})
