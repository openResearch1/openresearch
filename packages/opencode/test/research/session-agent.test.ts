import { describe, expect, spyOn, test } from "bun:test"

import { Agent } from "../../src/agent/agent"
import { Collab } from "../../src/collab"
import { CollabLoop } from "../../src/collab/loop"
import { PermissionNext } from "../../src/permission/next"
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
  test("treats a Controller Research Main as an owning Main session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const controller = await ControllerAgent.create(item.research)
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        try {
          const main = await Collab.spawn({
            parentAgentId: controller.agent.id,
            name: "Research Main",
            subagentType: "research",
            spec: { initialPrompt: "research" },
            permission: [{ permission: "research_doc_edit", pattern: "*", action: "ask" }],
          })
          const leaf = await Collab.spawn({
            parentAgentId: main.id,
            name: "Research leaf",
            subagentType: "research",
            spec: { initialPrompt: "focused work" },
          })
          const task = await Session.create({ parentID: main.session_id, title: "Research task" })
          const research = (await Agent.get("research"))!
          await SessionPrompt.prompt({
            sessionID: task.id,
            agent: "general",
            model: { providerID: "test", modelID: "test" },
            noReply: true,
            parts: [{ type: "text", text: "focused task" }],
          })

          expect((await Session.get(main.session_id)).collabPeer).toBe(true)
          expect(await ResearchSessionAgent.policy(main.session_id)).toMatchObject({
            kind: "main",
            default: "research",
          })
          expect(await ResearchSessionAgent.resolve({ sessionID: main.session_id })).toBe("research")
          expect(await ResearchSessionAgent.resolve({ sessionID: main.session_id, agent: "plan" })).toBe("plan")
          expect(await ResearchSessionAgent.resolve({ sessionID: main.session_id, agent: "build" })).toBe("build")
          await expect(
            ResearchSessionAgent.resolve({ sessionID: main.session_id, agent: "experiment" }),
          ).rejects.toThrow("Controller research_main sessions")
          for (const agent of ["deep_research", "research_idea", "research_project_init"]) {
            await expect(ResearchSessionAgent.resolve({ sessionID: main.session_id, agent })).rejects.toThrow(
              "Controller research_main sessions",
            )
          }

          const prompt = await ResearchSessionAgent.compose({ sessionID: main.session_id, agent: research })
          expect(prompt.prompt).toContain("## Main Research mode")
          expect(prompt.prompt).not.toContain("## Delegated Research constraint")
          expect(
            ResearchSessionAgent.approval({
              sessionID: main.session_id,
              permission: "research_doc_edit",
              actions: ["ask"],
            }),
          ).toBe("allow")
          expect(
            ResearchSessionAgent.approval({
              sessionID: main.session_id,
              permission: "research_doc_edit",
              actions: ["deny"],
            }),
          ).toBe("deny")
          expect(
            ResearchSessionAgent.approval({
              sessionID: main.session_id,
              permission: "bash",
              actions: ["ask"],
            }),
          ).toBeUndefined()
          const tools = await SessionPrompt.resolveTools({
            agent: research,
            model: { providerID: "test", api: { id: "test" } } as never,
            session: await Session.get(main.session_id),
            processor: { message: { id: "message" } } as never,
            bypassAgentCheck: false,
            messages: [],
          })
          const goal = tools.research_goal_edit
          expect(goal?.execute).toBeDefined()
          expect(tools.question).toBeUndefined()
          expect(
            await goal.execute!(
              { oldString: "", newString: "# Controller Research Goal" },
              {
                toolCallId: "goal-allow",
                abortSignal: new AbortController().signal,
                messages: [],
              } as never,
            ),
          ).toMatchObject({ output: "goal file created successfully." })

          const approval = PermissionNext.ask({
            id: "permission_controller_research_doc",
            sessionID: main.session_id,
            permission: "research_doc_edit",
            patterns: ["goal.md"],
            always: ["*"],
            metadata: {},
            ruleset: [],
          })
          await PermissionNext.reply({ requestID: "permission_controller_research_doc", reply: "always" })
          await approval

          const denied = await Collab.spawn({
            parentAgentId: controller.agent.id,
            name: "Denied Research Main",
            subagentType: "research",
            spec: { initialPrompt: "research" },
            permission: [{ permission: "research_doc_edit", pattern: "*", action: "deny" }],
          })
          const deniedTools = await SessionPrompt.resolveTools({
            agent: research,
            model: { providerID: "test", api: { id: "test" } } as never,
            session: await Session.get(denied.session_id),
            processor: { message: { id: "message" } } as never,
            bypassAgentCheck: false,
            messages: [],
          })
          await expect(
            deniedTools.research_goal_edit.execute!(
              { oldString: "", newString: "# Denied Goal" },
              {
                toolCallId: "goal-deny",
                abortSignal: new AbortController().signal,
                messages: [],
              } as never,
            ),
          ).rejects.toThrow()
          expect(await ResearchSessionAgent.policy(leaf.session_id)).toBeUndefined()
          expect(await ResearchSessionAgent.resolve({ sessionID: leaf.session_id })).toBe("research")
          await expect(
            ResearchSessionAgent.resolve({ sessionID: leaf.session_id, agent: "deep_research" }),
          ).rejects.toThrow("Controller leaf sessions")
          expect(
            ResearchSessionAgent.approval({
              sessionID: leaf.session_id,
              permission: "research_doc_edit",
              actions: ["ask"],
            }),
          ).toBeUndefined()
          expect((await ResearchSessionAgent.compose({ sessionID: leaf.session_id, agent: research })).prompt).toContain(
            "## Delegated Research constraint",
          )
          expect(await ResearchSessionAgent.policy(task.id)).toBeUndefined()
          expect(await ResearchSessionAgent.resolve({ sessionID: task.id })).toBe("general")
          await expect(
            ResearchSessionAgent.resolve({ sessionID: task.id, agent: "deep_research" }),
          ).rejects.toThrow("Controller task sessions")
          expect((await ResearchSessionAgent.compose({ sessionID: task.id, agent: research })).prompt).toContain(
            "## Delegated Research constraint",
          )
        } finally {
          start.mockRestore()
        }
      },
    })
  })

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
        await expect(ResearchSessionAgent.resolve({ sessionID: item.main.id, agent: "experiment" })).rejects.toThrow(
          "not available in main sessions",
        )

        for (const agent of ["plan", "build", "research"]) {
          expect(await ResearchSessionAgent.resolve({ sessionID: item.atom.id, agent })).toBe(agent)
        }
        await expect(ResearchSessionAgent.resolve({ sessionID: item.atom.id, agent: "deep_research" })).rejects.toThrow(
          "not available in atom sessions",
        )

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

  test("composes shared graph rules with session-specific Research work", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const research = (await Agent.get("research"))!
        const build = (await Agent.get("build"))!
        const main = await ResearchSessionAgent.compose({ sessionID: item.main.id, agent: research })
        const atom = await ResearchSessionAgent.compose({ sessionID: item.atom.id, agent: research })
        const delegated = await ResearchSessionAgent.compose({ sessionID: item.child.id, agent: research })
        const custom = await ResearchSessionAgent.compose({
          sessionID: item.main.id,
          agent: { ...research, prompt: "custom research base" },
        })

        expect(research.prompt).toContain("## Atom model")
        expect(research.prompt).toContain("`evaluated_by`")
        expect(research.prompt).not.toContain("## Main Research mode")
        expect(research.prompt).not.toContain("## Atom Research mode")

        expect(main.prompt).toContain("## Atom model")
        expect(main.prompt).toContain("## Interaction and response style")
        expect(main.prompt).toContain("## Workspace safety")
        expect(main.prompt).not.toContain("## Code editing")
        expect(main.prompt).toContain("## Main Research mode")
        expect(main.prompt).toContain("research_path")
        expect(main.prompt).toContain("Turn the user's objective and ideas")
        expect(main.prompt).toContain("must not create, run, monitor, or manage experiments")
        expect(main.prompt).toContain("spawn a `reviewer` Agent")
        expect(main.prompt).toContain("Only the Reviewer may call `research_result_submit`")
        expect(main.prompt).not.toContain("expectedHeadSha")
        expect(main.prompt).not.toContain("## Atom Research mode")

        expect(atom.prompt).toContain("## Atom model")
        expect(atom.prompt).toContain("## Interaction and response style")
        expect(atom.prompt).toContain("## Workspace safety")
        expect(atom.prompt).not.toContain("## Code editing")
        expect(atom.prompt).toContain("## Atom Research mode")
        expect(atom.prompt).toContain("directly supports assessment")
        expect(atom.prompt).not.toContain("research_path")
        expect(atom.prompt).toContain("or call `delegate_atom`")
        expect(atom.prompt).not.toContain("## Main Research mode")

        expect(delegated.prompt).toContain("## Main Research mode")
        expect(delegated.prompt).toContain("## Delegated Research constraint")
        expect(custom.prompt).toStartWith("custom research base")
        expect(custom.prompt).toContain("## Main Research mode")
        expect(await ResearchSessionAgent.compose({ sessionID: item.main.id, agent: build })).toBe(build)
      },
    })
  })
})
