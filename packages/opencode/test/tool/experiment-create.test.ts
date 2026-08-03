import { $ } from "bun"
import { afterEach, beforeEach, expect, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { CodeBranch } from "../../src/research/code-branch"
import { ExperimentExecutionWatch } from "../../src/research/experiment-execution-watch"
import { AtomTable, ExperimentTable, ResearchProjectTable } from "../../src/research/research.sql"
import { Session } from "../../src/session"
import { Database, eq } from "../../src/storage/db"
import type { Tool } from "../../src/tool/tool"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

beforeEach(async () => resetDatabase())
afterEach(async () => resetDatabase())

test("experiment creation locks and persists the selected branch head", async () => {
  await using tmp = await tmpdir({ git: true })
  await $`git branch -m main`.cwd(tmp.path).quiet()
  const selected = (await $`git rev-parse HEAD`.cwd(tmp.path).text()).trim()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({ title: "atom" })
      Database.use((db) =>
        db
          .insert(ResearchProjectTable)
          .values({ research_project_id: "research-1", project_id: Instance.project.id })
          .run(),
      )
      Database.use((db) =>
        db
          .insert(AtomTable)
          .values({
            atom_id: "atom-1",
            research_project_id: "research-1",
            atom_name: "claim",
            atom_type: "verification",
            atom_evidence_type: "experiment",
            atom_evidence_status: "pending",
            session_id: root.id,
          })
          .run(),
      )

      const tool = await import("../../src/tool/experiment").then((mod) => mod.ExperimentCreateTool.init())
      const ctx = {
        sessionID: root.id,
        messageID: "message-1",
        callID: "call-1",
        agent: "research",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => {},
        ask: async () => {},
      } satisfies Tool.Context
      const query = await import("../../src/tool/research-code-branch").then((mod) =>
        mod.ResearchCodeBranchQueryTool.init(),
      )
      const listed = await query.execute({ codeRoot: tmp.path }, ctx)
      expect(listed.metadata.branches).toContainEqual(
        expect.objectContaining({ branch: "main", headSha: selected, subject: expect.any(String) }),
      )

      const moved = await tool.execute(
        {
          atomId: "atom-1",
          expName: "stale baseline",
          baselineBranch: "main",
          expectedHeadSha: "0".repeat(40),
          codePath: tmp.path,
        },
        ctx,
      )
      expect(moved.title).toBe("Failed")
      expect(moved.output).toContain("moved from")
      expect(Database.use((db) => db.select().from(ExperimentTable).all())).toHaveLength(0)

      const result = await tool.execute(
        {
          atomId: "atom-1",
          expName: "locked baseline",
          baselineBranch: "main",
          expectedHeadSha: selected,
          codePath: tmp.path,
        },
        ctx,
      )
      const row = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, result.metadata.expId!)).get(),
      )!
      expect(result.title).toContain("Created experiment")
      expect(row.baseline_branch_name).toBe("main")
      expect(row.baseline_commit_sha).toBe(selected)
      expect((await $`git rev-parse ${row.exp_branch_name!}`.cwd(tmp.path).text()).trim()).toBe(selected)
      const branches = CodeBranch.experiments(await CodeBranch.list(tmp.path), "research-1")
      expect(branches.branches.find((branch) => branch.branch === row.exp_branch_name)).toMatchObject({
        experimentId: row.exp_id,
        experimentName: "locked baseline",
        experimentStatus: "pending",
      })

      ExperimentExecutionWatch.update({ expId: row.exp_id, status: "finished" })
      const finished = await query.execute({ codeRoot: tmp.path }, ctx)
      expect(finished.metadata.branches.find((branch) => branch.branch === row.exp_branch_name)).toMatchObject({
        experimentId: row.exp_id,
        experimentStatus: "done",
      })
      expect(
        Database.use((db) => db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, row.exp_id)).get())
          ?.status,
      ).toBe("done")

      const expQuery = await import("../../src/tool/experiment-query").then((mod) => mod.ExperimentQueryTool.init())
      const queried = await expQuery.execute({ expId: row.exp_id }, ctx)
      expect(queried.output).toContain("status: done")
    },
  })
})
