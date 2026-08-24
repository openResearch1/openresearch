import path from "path"

import { expect, spyOn, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { ExperimentTable, ResearchProjectTable } from "../../src/research/research.sql"
import { Session } from "../../src/session"
import { Database } from "../../src/storage/db"
import { PlanExitTool } from "../../src/tool/plan"
import type { Tool } from "../../src/tool/tool"
import { Question } from "../../src/question"
import { tmpdir } from "../fixture/fixture"

test("plan_exit returns an Experiment Plan session to the Experiment agent", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "experiment" })
      const research = crypto.randomUUID()
      const now = Date.now()
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
            exp_id: crypto.randomUUID(),
            research_project_id: research,
            exp_name: "plan exit",
            exp_session_id: session.id,
            exp_plan_path: path.join(tmp.path, "exp_results", "plan.md"),
            code_path: tmp.path,
            time_created: now,
            time_updated: now,
          })
          .run(),
      )
      await Session.updateMessage({
        id: "message-plan-user",
        sessionID: session.id,
        role: "user",
        agent: "plan",
        model: { providerID: "test", modelID: "test" },
        time: { created: now },
      })
      const ask = spyOn(Question, "ask").mockResolvedValue([["Yes"]])
      try {
        const tool = await PlanExitTool.init({ sessionID: session.id, agent: { name: "plan" } as never })
        const result = await tool.execute({}, {
          sessionID: session.id,
          messageID: "message-plan-assistant",
          callID: "call-plan-exit",
          agent: "plan",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } satisfies Tool.Context)
        const messages = await Session.messages({ sessionID: session.id })
        const next = messages.findLast((message) => message.info.role === "user")

        expect(result.title).toBe("Switching to Experiment agent")
        expect(tool.description).toContain("plan may remain in the conversation")
        expect(next?.info.role === "user" && next.info.agent).toBe("experiment")
        expect(next?.parts.some((part) => part.type === "text" && part.text.includes("preceding conversation"))).toBe(
          true,
        )
      } finally {
        ask.mockRestore()
      }
    },
  })
})
