import { describe, expect, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { ControllerAgent } from "../../src/research/controller-agent"
import { AtomTable, ExperimentTable, ResearchProjectTable } from "../../src/research/research.sql"
import { ResearchSessionAgent } from "../../src/research/session-agent"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Database } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

async function seed() {
  const main = await Session.create({ title: "main" })
  const atom = await Session.create({ title: "atom" })
  const experiment = await Session.create({ title: "experiment" })
  const child = await Session.create({ parentID: main.id, title: "child" })
  const research = crypto.randomUUID()
  const atomId = crypto.randomUUID()
  const now = Date.now()

  Database.use((db) => {
    db.insert(ResearchProjectTable)
      .values({ research_project_id: research, project_id: Instance.project.id, time_created: now, time_updated: now })
      .run()
    db.insert(AtomTable)
      .values({
        atom_id: atomId,
        research_project_id: research,
        atom_name: "test",
        atom_type: "verification",
        atom_evidence_type: "experiment",
        atom_evidence_status: "pending",
        session_id: atom.id,
        time_created: now,
        time_updated: now,
      })
      .run()
    db.insert(ExperimentTable)
      .values({
        exp_id: crypto.randomUUID(),
        research_project_id: research,
        exp_name: "test",
        atom_id: atomId,
        exp_session_id: experiment.id,
        code_path: Instance.directory,
        time_created: now,
        time_updated: now,
      })
      .run()
  })

  return { main, atom, experiment, child, research }
}

describe("research.session-agent", () => {
  test("classifies research sessions with exact selectable agents", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const controller = await ControllerAgent.create(item.research)

        expect(await ResearchSessionAgent.policy(item.main.id)).toMatchObject({
          kind: "main",
          agents: ["research", "deep_research", "plan", "build"],
          default: "research",
        })
        expect(await ResearchSessionAgent.policy(item.atom.id)).toMatchObject({
          kind: "atom",
          agents: ["plan", "build", "research"],
          default: "research",
        })
        expect(await ResearchSessionAgent.policy(item.experiment.id)).toMatchObject({
          kind: "experiment",
          agents: ["experiment", "plan", "build"],
          default: "experiment",
        })
        expect(await ResearchSessionAgent.policy(controller.session.id)).toMatchObject({
          kind: "controller",
          agents: ["controller"],
          pinned: true,
        })
        expect(await ResearchSessionAgent.policy(item.child.id)).toBeUndefined()
      },
    })
  })

  test("rejects disallowed visible agents and preserves hidden workflows", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const controller = await ControllerAgent.create(item.research)

        expect(await ResearchSessionAgent.resolve({ sessionID: item.main.id })).toBe("research")
        expect(await ResearchSessionAgent.resolve({ sessionID: item.main.id, agent: "deep_research" })).toBe(
          "deep_research",
        )
        await expect(
          ResearchSessionAgent.resolve({ sessionID: item.main.id, agent: "experiment" }),
        ).rejects.toThrow("not available in main sessions")

        for (const agent of ["plan", "build", "research"]) {
          expect(await ResearchSessionAgent.resolve({ sessionID: item.atom.id, agent })).toBe(agent)
        }
        await expect(
          ResearchSessionAgent.resolve({ sessionID: item.atom.id, agent: "deep_research" }),
        ).rejects.toThrow("not available in atom sessions")

        for (const agent of ["experiment", "plan", "build"]) {
          expect(await ResearchSessionAgent.resolve({ sessionID: item.experiment.id, agent })).toBe(agent)
        }
        for (const agent of ["research", "deep_research"]) {
          await expect(ResearchSessionAgent.resolve({ sessionID: item.experiment.id, agent })).rejects.toThrow(
            "not available in experiment sessions",
          )
        }

        expect(await ResearchSessionAgent.resolve({ sessionID: item.main.id, agent: "research_idea" })).toBe(
          "research_idea",
        )
        expect(await ResearchSessionAgent.resolve({ sessionID: controller.session.id, agent: "build" })).toBe(
          "controller",
        )

        const message = await SessionPrompt.prompt({
          sessionID: item.main.id,
          model: { providerID: "test", modelID: "test" },
          noReply: true,
          parts: [{ type: "text", text: "start research" }],
        })
        expect(message.info.role).toBe("user")
        if (message.info.role !== "user") throw new Error("expected user message")
        expect(message.info.agent).toBe("research")

        await expect(
          SessionPrompt.prompt({
            sessionID: item.atom.id,
            agent: "deep_research",
            model: { providerID: "test", modelID: "test" },
            noReply: true,
            parts: [{ type: "text", text: "invalid atom agent" }],
          }),
        ).rejects.toThrow("not available in atom sessions")
        await expect(
          SessionPrompt.shell({ sessionID: item.experiment.id, agent: "research", command: "true" }),
        ).rejects.toThrow("not available in experiment sessions")
      },
    })
  })
})
