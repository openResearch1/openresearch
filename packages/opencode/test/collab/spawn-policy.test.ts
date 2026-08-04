import { describe, expect, spyOn, test } from "bun:test"

import { Agent } from "../../src/agent/agent"
import { Collab } from "../../src/collab"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { CollabAutoWake } from "../../src/collab/auto-wake"
import { CollabAgentTable } from "../../src/collab/collab.sql"
import { CollabLoop } from "../../src/collab/loop"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { ResearchSessionAgent } from "../../src/research/session-agent"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Database, eq } from "../../src/storage/db"
import { TaskTool } from "../../src/tool/task"
import { WorkflowTool } from "../../src/tool/workflow"
import { tmpdir } from "../fixture/fixture"

CollabAutoWake.setEnabled(false)

async function node(input: {
  name: string
  type: string
  parent?: string
  root?: string
  sessionParent?: string
  metadata?: Record<string, unknown>
  status?: "idle" | "pending" | "completed"
}) {
  const session = await Session.create({ title: input.name, parentID: input.sessionParent })
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
  test("hard allowlists block unrelated agents across task, spawn, and workflow channels", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        try {
          const controller = await node({ name: "Controller", type: "controller" })
          const main = await spawn(controller.id, "research")
          await expect(
            ResearchSessionAgent.resolve({ sessionID: main.session_id, agent: "deep_research" }),
          ).rejects.toThrow("Controller research_main sessions")
          expect(CollabAgentNode.targets(main.session_id, "direct")).toEqual(["research", "plan", "build"])
          expect(CollabAgentNode.targets(main.session_id, "spawn")).toEqual([
            "research",
            "explore",
            "general",
            "reviewer",
          ])
          expect(CollabAgentNode.targets(main.session_id, "task")).toEqual(["research", "explore", "general"])

          for (const target of [
            "deep_research",
            "deep_research_plan",
            "research_idea",
            "research_project_init",
            "research_article_tree_build",
          ]) {
            await expect(spawn(main.id, target)).rejects.toThrow(`research_main cannot spawn ${target}`)
          }
          const forged = await Session.create({ title: "forged root" })
          expect(() =>
            CollabAgentNode.create({
              id: Identifier.ascending("collab_agent"),
              sessionId: forged.id,
              parentAgentId: main.id,
              name: "forged root",
              projectId: Instance.project.id,
              rootAgentId: Identifier.ascending("collab_agent"),
              subagentType: "general",
              spec: { initialPrompt: "forged" },
            }),
          ).toThrow("does not match the requested root")

          const available = await tools(main.session_id, "research")
          expect(available.spawn_agent.description).toContain("`reviewer`")
          expect(available.spawn_agent.description).not.toContain("`deep_research`")
          expect(available.task.description).toContain("research:")
          expect(available.task.description).toContain("explore:")
          expect(available.task.description).toContain("general:")
          expect(available.task.description).not.toContain("deep_research")
          expect(available.task.description).not.toContain("research_project_init")
          expect(available.workflow).toBeUndefined()
          const reviewer = await spawn(main.id, "reviewer")
          expect(CollabAgentNode.canTask(reviewer.session_id)).toBe(false)
          expect((await tools(reviewer.session_id, "reviewer")).task).toBeUndefined()

          let asked = false
          const context = {
            sessionID: main.session_id,
            messageID: "message",
            agent: "research",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => {},
            ask: async () => {
              asked = true
            },
            extra: { bypassAgentCheck: true },
          }
          const task = await TaskTool.init({ agent: (await Agent.get("research"))!, sessionID: main.session_id })
          await expect(
            task.execute(
              { subagent_type: "deep_research_plan", description: "blocked task", prompt: "blocked" },
              context,
            ),
          ).rejects.toThrow("research_main cannot invoke deep_research_plan")
          expect(asked).toBe(false)

          const workflow = await WorkflowTool.init()
          await expect(
            workflow.execute({ action: "start", template_id: "deep_research_v1" }, context),
          ).rejects.toThrow("workflows are unavailable")

          const child = await Session.create({ parentID: main.session_id, title: "task child" })
          const childTask = await TaskTool.init({ agent: (await Agent.get("build"))!, sessionID: child.id })
          await expect(
            childTask.execute(
              { subagent_type: "general", description: "nested task", prompt: "blocked" },
              { ...context, sessionID: child.id },
            ),
          ).rejects.toThrow("task cannot invoke general")
          const raw = await Session.create({ parentID: main.session_id, title: "raw task child" })
          await expect(
            ResearchSessionAgent.resolve({ sessionID: raw.id, agent: "deep_research" }),
          ).rejects.toThrow("Controller task sessions")

          const foreign = await Session.create({ parentID: controller.session_id, title: "foreign task" })
          await expect(
            task.execute(
              {
                subagent_type: "general",
                description: "foreign task",
                prompt: "blocked",
                task_id: foreign.id,
              },
              context,
            ),
          ).rejects.toThrow("does not belong to this session")
        } finally {
          start.mockRestore()
        }
      },
    })
  })

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
          await expect(spawn(controller.id)).rejects.toThrow("controller cannot spawn general")
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
          ).toThrow("controller cannot spawn general")

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
          expect((await tools(leaf.session_id, "general")).task).toBeDefined()
          await expect(spawn(leaf.id)).rejects.toThrow("leaf cannot spawn general")
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
          ).toThrow("leaf cannot spawn general")
          expect(CollabAgentNode.loadBySessionId(blocked.id)).toBeUndefined()

          const research = await spawn(main.id, "research")
          expect(CollabAgentNode.role(research.id)).toBe("leaf")
          await expect(spawn(research.id)).rejects.toThrow("leaf cannot spawn general")

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
          expect(CollabAgentNode.targets(atom.session_id, "spawn")).toEqual(["research", "explore", "general"])
          expect(CollabAgentNode.targets(atom.session_id, "task")).toEqual(["research", "explore", "general"])
          expect(CollabAgentNode.targets(created.session_id, "spawn")).toEqual([
            "project_runtime_env_setup",
            "experiment_resource_prepare",
          ])
          expect(CollabAgentNode.targets(created.session_id, "task")).toEqual([
            "experiment_plan",
            "experiment_commit",
          ])
          expect(CollabLoop.timeout(CollabAgentNode.load(atom.id))).toBeUndefined()
          expect(CollabLoop.timeout(CollabAgentNode.load(created.id))).toBeUndefined()
          expect(CollabLoop.timeout(CollabAgentNode.load(attached.id))).toBeUndefined()
          expect(CollabAgentNode.role((await spawn(atom.id)).id)).toBe("leaf")
          expect(CollabAgentNode.role((await spawn(created.id, "project_runtime_env_setup")).id)).toBe("leaf")
          await expect(spawn(atom.id, "reviewer")).rejects.toThrow("atom cannot spawn reviewer")
          await expect(spawn(created.id, "general")).rejects.toThrow("experiment cannot spawn general")

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

          const badAtom = await node({ name: "Bad Atom", type: "research", metadata: { atomId: "bad" } })
          await node({
            name: "Bad Atom child",
            type: "deep_research",
            parent: badAtom.id,
            root: badAtom.id,
            sessionParent: badAtom.session_id,
            status: "completed",
          })
          CollabAgentNode.lease({ agentId: badAtom.id, parentAgentId: main.id, prompt: "import history" })
          const legacy = CollabAgentNode.loadChildren(badAtom.id)[0]
          expect(CollabAgentNode.role(legacy.id)).toBe("blocked")
          expect(CollabAgentNode.spawnContext(legacy.session_id).role).toBe("blocked")
          await expect(SessionPrompt.loop({ sessionID: legacy.session_id })).rejects.toThrow(
            "blocked by an invalid legacy agent topology",
          )

          const badExperiment = await node({
            name: "Bad Experiment",
            type: "experiment",
            metadata: { atomId: "atom", expId: "bad" },
            status: "idle",
          })
          await node({
            name: "Bad Experiment child",
            type: "general",
            parent: badExperiment.id,
            root: badExperiment.id,
            status: "idle",
          })
          expect(() =>
            CollabAgentNode.attach({
              id: badExperiment.id,
              parentId: atom.id,
              rootId: controller.id,
              name: "Bad Experiment",
              subagentType: "experiment",
              metadata: { atomId: "atom", expId: "bad" },
            }),
          ).toThrow("experiment cannot contain general")
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
          const stale = await node({ name: "Stale root", type: "general", parent: main.id, root: controller.id })
          Database.use((db) =>
            db
              .update(CollabAgentTable)
              .set({ subagent_type: "controller" })
              .where(eq(CollabAgentTable.id, controller.id))
              .run(),
          )
          Database.use((db) =>
            db
              .update(CollabAgentTable)
              .set({ root_agent_id: stale.id })
              .where(eq(CollabAgentTable.id, stale.id))
              .run(),
          )

          expect(leaf.spec.metadata?.controllerRole).toBeUndefined()
          expect(CollabAgentNode.role(leaf.id)).toBe("leaf")
          await expect(spawn(leaf.id)).rejects.toThrow("leaf cannot spawn general")
          expect(CollabAgentNode.load(child.id).parent_agent_id).toBe(leaf.id)
          expect(CollabAgentNode.role(child.id)).toBe("blocked")
          await expect(
            ResearchSessionAgent.resolve({ sessionID: child.session_id, agent: "general" }),
          ).rejects.toThrow("blocked by an invalid legacy agent topology")
          await expect(ResearchSessionAgent.resolve({ sessionID: child.session_id })).rejects.toThrow(
            "blocked by an invalid legacy agent topology",
          )
          await expect(SessionPrompt.loop({ sessionID: child.session_id })).rejects.toThrow(
            "blocked by an invalid legacy agent topology",
          )
          expect(CollabAgentNode.role(stale.id)).toBe("blocked")
          await expect(ResearchSessionAgent.resolve({ sessionID: stale.session_id })).rejects.toThrow(
            "blocked by an invalid legacy agent topology",
          )
          const blockedSession = await Session.create({ title: "blocked stale child" })
          expect(() =>
            CollabAgentNode.create({
              id: Identifier.ascending("collab_agent"),
              sessionId: blockedSession.id,
              parentAgentId: stale.id,
              name: "blocked stale child",
              projectId: Instance.project.id,
              rootAgentId: stale.id,
              subagentType: "general",
              spec: { initialPrompt: "blocked" },
            }),
          ).toThrow("parent " + stale.id + " is blocked")
          const updated = CollabAgentNode.spec(leaf.id, {
            initialPrompt: "legacy update",
            metadata: { controllerRole: "atom" },
          })
          expect(updated.spec.metadata?.controllerRole).toBe("leaf")
          expect(CollabAgentNode.role(leaf.id)).toBe("leaf")

          const task = await Session.create({ parentID: main.session_id, title: "task child" })
          expect(CollabAgentNode.spawnContext(task.id)).toEqual({ controller: true, role: "task", agent: undefined })
          expect((await tools(task.id, "build")).spawn_agent).toBeUndefined()
          expect((await tools(task.id, "build")).task).toBeUndefined()
          await expect(
            Collab.spawn({
              parentSessionId: task.id,
              name: "task spawn",
              subagentType: "general",
              spec: { initialPrompt: "blocked" },
            }),
          ).rejects.toThrow("task cannot spawn general")
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
          ).rejects.toThrow("task cannot spawn general")
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
