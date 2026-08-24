import path from "path"

import { expect, spyOn, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { PermissionNext } from "../../src/permission/next"
import { ExperimentTable, ResearchProjectTable } from "../../src/research/research.sql"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { SessionPrompt } from "../../src/session/prompt"
import { Database } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

test("uses Experiment Plan reminders and clears them when manually returning to Experiment", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({
        title: "experiment",
        permission: [{ permission: "edit", pattern: "*", action: "allow" }],
      })
      const research = crypto.randomUUID()
      const plan = path.join(tmp.path, "exp_results", "plan.md")
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
            exp_name: "manual switch",
            exp_session_id: session.id,
            exp_plan_path: plan,
            code_path: tmp.path,
          })
          .run(),
      )

      const calls: Parameters<typeof LLM.stream>[0][] = []
      const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
        if (input.small) {
          return {
            text: Promise.resolve("Experiment Plan"),
            fullStream: (async function* () {})(),
          } as unknown as Awaited<ReturnType<typeof LLM.stream>>
        }
        calls.push(input)
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            }
            yield { type: "finish" }
          })(),
        } as unknown as Awaited<ReturnType<typeof LLM.stream>>
      })

      try {
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "plan",
          model: { providerID: "opencode", modelID: "kimi-k2.5-free" },
          parts: [{ type: "text", text: "plan the current fix" }],
        })
        const planning = calls[0]
        expect(planning.agent.prompt).toContain("user-facing Plan mode for the experiment")
        expect(planning.system.join("\n")).toContain(`exp_plan_path=${JSON.stringify(plan)}`)
        expect(JSON.stringify(planning.messages)).toContain("Experiment Plan mode is active")
        expect(JSON.stringify(planning.messages)).not.toContain("ZERO exceptions")
        const disabled = PermissionNext.disabled(Object.keys(planning.tools), planning.agent.permission)
        expect(planning.tools.plan_exit).toBeDefined()
        expect(planning.tools.plan_exit.description).toContain("plan may remain in the conversation")
        expect(planning.tools.plan_exit.description).not.toContain("switch to build agent")
        expect(planning.agent.prompt).toContain("Do not call `plan_exit`")
        expect(JSON.stringify(planning.messages)).toContain("Do not call plan_exit")
        expect(disabled.has("bash")).toBe(false)
        expect(disabled.has("ssh")).toBe(false)
        expect(disabled.has("experiment_remote_task_get")).toBe(false)
        expect(disabled.has("edit")).toBe(false)
        expect(disabled.has("write")).toBe(false)
        await expect(
          planning.tools.write.execute!({ filePath: path.join(tmp.path, "not-the-plan.md"), content: "denied" }, {
            toolCallId: "outside-plan",
            abortSignal: new AbortController().signal,
            messages: [],
          } as never),
        ).rejects.toThrow()
        expect(await Bun.file(path.join(tmp.path, "not-the-plan.md")).exists()).toBe(false)

        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "experiment",
          model: { providerID: "opencode", modelID: "kimi-k2.5-free" },
          parts: [{ type: "text", text: "continue with the approved scope" }],
        })
        const experiment = calls.at(-1)!
        const experimentDisabled = PermissionNext.disabled(Object.keys(experiment.tools), experiment.agent.permission)
        expect(experiment.agent.name).toBe("experiment")
        expect(experimentDisabled.has("question")).toBe(true)
        expect(JSON.stringify(experiment.messages)).toContain(
          "Your operational mode has changed from Experiment Plan to Experiment",
        )
        expect(JSON.stringify(experiment.messages)).toContain("Do not assume that `exp_plan_path` was updated")
      } finally {
        stream.mockRestore()
      }
    },
  })
})
