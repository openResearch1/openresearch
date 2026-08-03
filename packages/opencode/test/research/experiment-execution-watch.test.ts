import { afterEach, beforeEach, expect, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { ExperimentExecutionWatch } from "../../src/research/experiment-execution-watch"
import { ExperimentExecutionWatchTable, ExperimentTable, ResearchProjectTable } from "../../src/research/research.sql"
import { Database, eq } from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

beforeEach(async () => resetDatabase())
afterEach(async () => resetDatabase())

test("projects execution watch transitions onto the experiment", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Database.use((db) =>
        db
          .insert(ResearchProjectTable)
          .values({ research_project_id: "research-1", project_id: Instance.project.id })
          .run(),
      )
      Database.use((db) =>
        db
          .insert(ExperimentTable)
          .values({
            exp_id: "exp-1",
            research_project_id: "research-1",
            exp_name: "status projection",
            code_path: tmp.path,
          })
          .run(),
      )
      const watch = ExperimentExecutionWatch.createOrGet("exp-1", "status projection")
      expect(watch.started_at).toBeNull()

      const check = (
        watchStatus: typeof ExperimentExecutionWatchTable.$inferSelect.status,
        expStatus: typeof ExperimentTable.$inferSelect.status,
      ) => {
        expect(
          Database.use((db) =>
            db
              .select({ status: ExperimentExecutionWatchTable.status })
              .from(ExperimentExecutionWatchTable)
              .where(eq(ExperimentExecutionWatchTable.exp_id, "exp-1"))
              .get(),
          ),
        ).toEqual({ status: watchStatus })
        expect(
          Database.use((db) =>
            db
              .select({ status: ExperimentTable.status })
              .from(ExperimentTable)
              .where(eq(ExperimentTable.exp_id, "exp-1"))
              .get(),
          ),
        ).toEqual({ status: expStatus })
      }

      ExperimentExecutionWatch.update({ expId: "exp-1", status: "running" })
      check("running", "running")
      expect(Database.use((db) => db.select().from(ExperimentTable).get())?.started_at).toEqual(expect.any(Number))

      ExperimentExecutionWatch.update({ expId: "exp-1", status: "finished" })
      check("finished", "done")
      expect(Database.use((db) => db.select().from(ExperimentTable).get())?.finished_at).toEqual(expect.any(Number))

      ExperimentExecutionWatch.update({ expId: "exp-1", status: "failed" })
      check("failed", "failed")

      ExperimentExecutionWatch.update({ expId: "exp-1", status: "canceled" })
      check("canceled", "idle")

      ExperimentExecutionWatch.update({ expId: "exp-1", status: "pending" })
      check("pending", "pending")
      expect(Database.use((db) => db.select().from(ExperimentTable).get())).toMatchObject({
        started_at: null,
        finished_at: null,
      })
    },
  })
})
