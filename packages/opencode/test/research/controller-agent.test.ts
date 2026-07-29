import { describe, expect, test } from "bun:test"

import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { ControllerAgent } from "../../src/research/controller-agent"
import { ResearchProjectTable } from "../../src/research/research.sql"
import { ResearchRoutes } from "../../src/server/routes/research"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Database } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

function seed() {
  const id = crypto.randomUUID()
  const now = Date.now()
  Database.use((db) =>
    db
      .insert(ResearchProjectTable)
      .values({
        research_project_id: id,
        project_id: Instance.project.id,
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  return id
}

describe("research.controller-agent", () => {
  test("creates multiple Controller roots and pins direct prompts", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = seed()
        const controller = await Agent.get("controller")
        expect(controller?.mode).toBe("primary")
        expect(controller?.hidden).toBe(true)
        expect(PermissionNext.evaluate("bash", "*", controller!.permission).action).toBe("deny")
        expect(PermissionNext.evaluate("atom_query", "*", controller!.permission).action).toBe("deny")
        expect(PermissionNext.evaluate("research_path", "*", controller!.permission).action).toBe("allow")
        expect(PermissionNext.evaluate("spawn_agent", "research", controller!.permission).action).toBe("allow")
        expect(PermissionNext.evaluate("spawn_agent", "general", controller!.permission).action).toBe("deny")
        expect(controller?.prompt).toContain("do not perform research")

        const first = await ControllerAgent.create(research)
        const second = await ControllerAgent.create(research)

        expect(first.session.id).not.toBe(second.session.id)
        expect(first.agent.subagent_type).toBe("controller")
        expect(first.agent.parent_agent_id).toBeNull()
        expect(first.agent.root_agent_id).toBe(first.agent.id)
        expect(ControllerAgent.list().map((agent) => agent.session_id)).toEqual([
          first.session.id,
          second.session.id,
        ])

        const message = await SessionPrompt.prompt({
          sessionID: first.session.id,
          agent: "build",
          model: { providerID: "test", modelID: "test" },
          noReply: true,
          parts: [{ type: "text", text: "coordinate this research" }],
        })
        expect(message.info.role).toBe("user")
        if (message.info.role !== "user") throw new Error("expected user message")
        expect(message.info.agent).toBe("controller")

        const tree = await ResearchRoutes.request(`/project/${research}/session-tree`)
        expect(tree.status).toBe(200)
        expect((await tree.json()).controllerSessionIds).toEqual([first.session.id, second.session.id])

        const ordinary = await Session.create({})
        await expect(
          SessionPrompt.prompt({
            sessionID: ordinary.id,
            agent: "controller",
            model: { providerID: "test", modelID: "test" },
            noReply: true,
            parts: [{ type: "text", text: "convert this session" }],
          }),
        ).rejects.toThrow("dedicated Controller session")
        expect(ControllerAgent.get(ordinary.id)).toBeUndefined()
      },
    })
  })

  test("creates a Controller through the dedicated route", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = seed()
        const response = await ResearchRoutes.request(`/project/${research}/controller/session`, { method: "POST" })
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(ControllerAgent.get(body.session_id)?.id).toBe(body.agent_id)
      },
    })
  })
})
