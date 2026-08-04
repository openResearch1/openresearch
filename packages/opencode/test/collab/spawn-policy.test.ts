import { describe, expect, spyOn, test } from "bun:test"

import { Agent } from "../../src/agent/agent"
import { Collab } from "../../src/collab"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { CollabAutoWake } from "../../src/collab/auto-wake"
import { CollabAgentTable } from "../../src/collab/collab.sql"
import { CollabLoop } from "../../src/collab/loop"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Database, eq } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

CollabAutoWake.setEnabled(false)

async function node(input: {
  name: string
  type: string
  parent?: string
  root?: string
  metadata?: Record<string, unknown>
  status?: "idle" | "pending"
}) {
  const session = await Session.create({ title: input.name })
  const id = Identifier.ascending("collab_agent")
  return CollabAgentNode.create({
    id,
    sessionId: session.id,
    parentAgentId: input.parent ?? null,
    name: input.name,
    projectId: Instance.project.id,
    rootAgentId: input.root ?? id,
    subagentType: input.type,
    spec: { initialPrompt: input.name, metadata: input.metadata },
    status: input.status,
  })
}

async function spawn(parent: string, type = "general") {
  return Collab.spawn({
    parentAgentId: parent,
    name: `${type}-${Identifier.ascending("collab_agent")}`,
    subagentType: type,
    spec: { initialPrompt: type },
  })
}

async function tools(session: string, agent: string) {
  return SessionPrompt.resolveTools({
    agent: (await Agent.get(agent))!,
    model: { providerID: "test", api: { id: "test" } } as never,
    session: await Session.get(session),
    processor: { message: { id: "message" } } as never,
    bypassAgentCheck: false,
    messages: [],
  })
}

describe("Collab Controller spawn policy", () => {
  test("Controller roles can spawn one leaf level but leaves cannot recurse", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        try {
          const controller = await node({
            name: "Controller",
            type: "controller",
            metadata: { researchProjectId: "research", controllerRole: "controller" },
          })
          expect(CollabAgentNode.role(controller.id)).toBe("controller")
          expect(CollabLoop.timeout(controller)).toBeUndefined()
          expect(CollabAgentNode.canSpawn(controller.session_id)).toBe(true)
          await expect(spawn(controller.id)).rejects.toThrow("Controller may only spawn research agents")
          const blockedController = await Session.create({ title: "blocked Controller child" })
          expect(() =>
            CollabAgentNode.create({
              id: Identifier.ascending("collab_agent"),
              sessionId: blockedController.id,
              parentAgentId: controller.id,
              name: "blocked Controller child",
              projectId: Instance.project.id,
              rootAgentId: controller.id,
              subagentType: "general",
              spec: { initialPrompt: "blocked" },
            }),
          ).toThrow("Controller may only spawn research agents")

          const main = await spawn(controller.id, "research")
          expect(CollabAgentNode.role(main.id)).toBe("research_main")
          expect(CollabLoop.timeout(main)).toBeUndefined()
          expect(main.spec.metadata?.controllerRole).toBe("research_main")

          const leaf = await spawn(main.id)
          expect(CollabAgentNode.role(leaf.id)).toBe("leaf")
          expect(CollabLoop.timeout(leaf)).toBeUndefined()
          expect(CollabAgentNode.canSpawn(leaf.session_id)).toBe(false)
          expect((await tools(main.session_id, "research")).spawn_agent).toBeDefined()
          expect((await tools(leaf.session_id, "build")).spawn_agent).toBeUndefined()
          await expect(spawn(leaf.id)).rejects.toThrow("cannot spawn additional agents")
          const blocked = await Session.create({ title: "transactional spawn" })
          expect(() =>
            CollabAgentNode.create({
              id: Identifier.ascending("collab_agent"),
              sessionId: blocked.id,
              parentAgentId: leaf.id,
              name: "transactional spawn",
              projectId: Instance.project.id,
              rootAgentId: controller.id,
              subagentType: "general",
              spec: { initialPrompt: "blocked" },
              activeParent: true,
              parentGeneration: CollabAgentNode.generation(leaf.spec),
            }),
          ).toThrow("cannot spawn additional agents")
          expect(CollabAgentNode.loadBySessionId(blocked.id)).toBeUndefined()

          const research = await spawn(main.id, "research")
          expect(CollabAgentNode.role(research.id)).toBe("leaf")
          await expect(spawn(research.id)).rejects.toThrow("cannot spawn additional agents")

          const updated = CollabAgentNode.spec(leaf.id, {
            initialPrompt: "updated",
            metadata: { controllerRole: "controller" },
          })
          expect(updated.spec.metadata?.controllerRole).toBe("leaf")
          expect(CollabAgentNode.role(updated.id)).toBe("leaf")
        } finally {
          start.mockRestore()
        }
      },
    })
  })

  test("Atom and Experiment roles may spawn leaves", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        try {
          const controller = await node({ name: "Controller", type: "controller" })
          const main = await node({ name: "Main", type: "research", parent: controller.id, root: controller.id })
          const atom = await node({
            name: "Atom",
            type: "research",
            metadata: { atomId: "atom" },
          })
          CollabAgentNode.lease({ agentId: atom.id, parentAgentId: main.id, prompt: "validate atom" })
          const created = await node({
            name: "Created Experiment",
            type: "experiment",
            parent: atom.id,
            root: controller.id,
            metadata: { atomId: "atom", expId: "experiment" },
            status: "idle",
          })
          const detached = await node({
            name: "Detached Experiment",
            type: "experiment",
            metadata: { atomId: "atom", expId: "detached" },
            status: "idle",
          })
          const attached = CollabAgentNode.attach({
            id: detached.id,
            parentId: atom.id,
            rootId: controller.id,
            name: "Attached Experiment",
            subagentType: "experiment",
            metadata: { atomId: "atom", expId: "detached" },
          })
          CollabAgentNode.activate(created.id)

          expect(CollabAgentNode.role(main.id)).toBe("research_main")
          expect(CollabAgentNode.role(atom.id)).toBe("atom")
          expect(CollabAgentNode.role(created.id)).toBe("experiment")
          expect(CollabAgentNode.role(attached.id)).toBe("experiment")
          expect(CollabLoop.timeout(CollabAgentNode.load(atom.id))).toBeUndefined()
          expect(CollabLoop.timeout(CollabAgentNode.load(created.id))).toBeUndefined()
          expect(CollabLoop.timeout(CollabAgentNode.load(attached.id))).toBeUndefined()
          expect(CollabAgentNode.role((await spawn(atom.id)).id)).toBe("leaf")
          expect(CollabAgentNode.role((await spawn(created.id)).id)).toBe("leaf")

          const blocked = await Session.create({ title: "blocked inactive child" })
          expect(() =>
            CollabAgentNode.create({
              id: Identifier.ascending("collab_agent"),
              sessionId: blocked.id,
              parentAgentId: atom.id,
              name: "blocked inactive child",
              projectId: Instance.project.id,
              rootAgentId: controller.id,
              subagentType: "general",
              spec: { initialPrompt: "blocked" },
              status: "idle",
            }),
          ).toThrow("only Experiment domain nodes")
          const generic = await node({ name: "Generic root", type: "general", status: "idle" })
          expect(() =>
            CollabAgentNode.lease({ agentId: generic.id, parentAgentId: main.id, prompt: "blocked" }),
          ).toThrow("only Research Main may lease Atom agents")
          expect(() =>
            CollabAgentNode.attach({
              id: generic.id,
              parentId: atom.id,
              rootId: controller.id,
              name: "blocked attach",
              subagentType: "general",
              metadata: {},
            }),
          ).toThrow("only Experiments may attach to Atom agents")
        } finally {
          start.mockRestore()
        }
      },
    })
  })

  test("task descendants and legacy leaves cannot bypass the policy", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        try {
          const controller = await node({ name: "Controller", type: "general" })
          const main = await node({ name: "Main", type: "research", parent: controller.id, root: controller.id })
          const leaf = await node({ name: "Legacy leaf", type: "general", parent: main.id, root: controller.id })
          const child = await node({ name: "Existing child", type: "general", parent: leaf.id, root: controller.id })
          Database.use((db) =>
            db
              .update(CollabAgentTable)
              .set({ subagent_type: "controller" })
              .where(eq(CollabAgentTable.id, controller.id))
              .run(),
          )

          expect(leaf.spec.metadata?.controllerRole).toBeUndefined()
          expect(CollabAgentNode.role(leaf.id)).toBe("leaf")
          await expect(spawn(leaf.id)).rejects.toThrow("cannot spawn additional agents")
          expect(CollabAgentNode.load(child.id).parent_agent_id).toBe(leaf.id)
          const updated = CollabAgentNode.spec(leaf.id, {
            initialPrompt: "legacy update",
            metadata: { controllerRole: "atom" },
          })
          expect(updated.spec.metadata?.controllerRole).toBe("leaf")
          expect(CollabAgentNode.role(leaf.id)).toBe("leaf")

          const task = await Session.create({ parentID: main.session_id, title: "task child" })
          expect(CollabAgentNode.spawnContext(task.id)).toEqual({ controller: true, role: "task", allowed: false })
          expect((await tools(task.id, "build")).spawn_agent).toBeUndefined()
          await expect(
            Collab.spawn({
              parentSessionId: task.id,
              name: "task spawn",
              subagentType: "general",
              spec: { initialPrompt: "blocked" },
            }),
          ).rejects.toThrow("task subagents cannot spawn agents")
          await expect(
            Collab.spawn({
              parentAgentId: main.id,
              parentSessionId: task.id,
              name: "ambiguous spawn",
              subagentType: "general",
              spec: { initialPrompt: "blocked" },
            }),
          ).rejects.toThrow("only one parent selector")

          await Collab.ensureRootFromSession(task.id, {
            name: "task",
            subagentType: "research",
            spec: { initialPrompt: "" },
          })
          expect(CollabAgentNode.canSpawn(task.id)).toBe(false)
          await expect(
            Collab.spawn({
              parentSessionId: task.id,
              name: "task root spawn",
              subagentType: "general",
              spec: { initialPrompt: "blocked" },
            }),
          ).rejects.toThrow("task subagents cannot spawn agents")
        } finally {
          start.mockRestore()
        }
      },
    })
  })

  test("agents outside Controller trees keep recursive spawn behavior", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        try {
          const root = await node({ name: "Ordinary root", type: "research" })
          const child = await spawn(root.id)
          const grandchild = await spawn(child.id)
          expect(grandchild.parent_agent_id).toBe(child.id)
          expect(CollabAgentNode.role(child.id)).toBeUndefined()
          expect(CollabAgentNode.canSpawn(child.session_id)).toBe(true)

          const task = await Session.create({ parentID: root.session_id, title: "ordinary task" })
          expect(CollabAgentNode.canSpawn(task.id)).toBe(true)
        } finally {
          start.mockRestore()
        }
      },
    })
  })
})
