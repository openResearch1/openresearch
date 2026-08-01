import fs from "fs/promises"
import path from "path"

import { describe, expect, spyOn, test } from "bun:test"
import { eq } from "drizzle-orm"

import { Bus } from "../../src/bus"
import { Collab } from "../../src/collab"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { CollabAutoWake } from "../../src/collab/auto-wake"
import { CollabEvent } from "../../src/collab/events"
import { CollabLoop } from "../../src/collab/loop"
import { CollabMessage } from "../../src/collab/message"
import { CollabRecovery } from "../../src/collab/recovery"
import { CollabRuntime } from "../../src/collab/runtime"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ExperimentAgent } from "../../src/research/experiment-agent"
import { ExperimentRemoteTask } from "../../src/research/experiment-remote-task"
import { ExperimentRemoteTaskListener } from "../../src/research/experiment-remote-task-listener"
import { ResearchSessionControl } from "../../src/research/session-control"
import { AtomTable, ExperimentTable, RemoteTaskTable, ResearchProjectTable } from "../../src/research/research.sql"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { SessionOwnership } from "../../src/session/ownership"
import { Database } from "../../src/storage/db"
import { SpawnAgentTool } from "../../src/tool/spawn-agent"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

CollabAutoWake.setEnabled(false)

async function seed(input?: { session?: boolean }) {
  const atom = await Session.create({ title: "Atom: test" })
  const exp = input?.session === false ? undefined : await Session.create({ title: "Exp: test" })
  const research = crypto.randomUUID()
  const atomId = crypto.randomUUID()
  const expId = crypto.randomUUID()
  const now = Date.now()

  Database.use((db) =>
    db
      .insert(ResearchProjectTable)
      .values({ research_project_id: research, project_id: Instance.project.id, time_created: now, time_updated: now })
      .run(),
  )
  Database.use((db) =>
    db
      .insert(AtomTable)
      .values({
        atom_id: atomId,
        research_project_id: research,
        atom_name: "test atom",
        atom_type: "verification",
        atom_evidence_type: "experiment",
        atom_evidence_status: "pending",
        session_id: atom.id,
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  Database.use((db) =>
    db
      .insert(ExperimentTable)
      .values({
        exp_id: expId,
        research_project_id: research,
        exp_name: "test experiment",
        atom_id: atomId,
        exp_session_id: exp?.id,
        code_path: Instance.directory,
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  return { atom, exp, atomId, expId }
}

describe("research.experiment-agent", () => {
  test("attaches existing experiments as idle children idempotently", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const first = await ExperimentAgent.attach(item.expId)
        const second = await ExperimentAgent.attach(item.expId)
        expect(first.status).toBe("attached")
        expect(second).toEqual(first)

        const child = CollabAgentNode.load(first.agentId!)
        const parent = CollabAgentNode.load(child.parent_agent_id!)
        expect(child.session_id).toBe(item.exp!.id)
        expect(child.status).toBe("idle")
        expect(child.subagent_type).toBe("experiment")
        expect(child.root_agent_id).toBe(parent.id)
        expect(child.spec.metadata).toEqual({ expId: item.expId, atomId: item.atomId })
        expect(parent.session_id).toBe(item.atom.id)
        expect(parent.active_children).toBe(0)
        expect(parent.spawned_total).toBe(1)
        expect(CollabAgentNode.loadPeerSessionIdsByDirectory(Instance.project.id, Instance.directory)).not.toContain(
          item.exp!.id,
        )
        expect(() => ExperimentAgent.assertHuman(item.exp!.id)).not.toThrow()
      },
    })
  })

  test("delivers human remote task completion without activating the experiment or notifying Atom", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const attached = await ExperimentAgent.attach(item.expId)
        const child = CollabAgentNode.load(attached.agentId!)
        const task = ExperimentRemoteTask.create({
          expId: item.expId,
          kind: "experiment_run",
          title: "Train model",
          server: "{}",
          remoteRoot: "/tmp",
          screenName: "train",
          command: "python train.py",
        })
        const release = SessionOwnership.claim(child.session_id, "collab")
        expect(release).toBeDefined()
        ExperimentRemoteTaskListener.register({ taskId: task.task_id, agentId: child.id })
        release?.()
        expect(ExperimentRemoteTaskListener.has(child.id, "direct")).toBeDefined()

        await expect(Collab.resume({ agentId: child.id, prompt: "inspect" })).rejects.toThrow("human session")
        ExperimentRemoteTask.update({ taskId: task.task_id, status: "finished" })

        const parent = CollabAgentNode.load(child.parent_agent_id!)
        expect(CollabMessage.list(parent.id, { kind: "remote_task_terminal" })).toHaveLength(0)
        expect(CollabMessage.list(child.id, { kind: "session_remote_task_terminal" })).toHaveLength(1)
        expect(CollabAgentNode.load(child.id).status).toBe("idle")
        expect(CollabAgentNode.load(parent.id).active_children).toBe(0)
        await expect(Collab.resume({ agentId: child.id, prompt: "inspect" })).rejects.toThrow("human session")

        const prompt = spyOn(SessionPrompt, "prompt").mockRejectedValue(new Error("provider unavailable"))
        CollabAutoWake.setEnabled(true)
        try {
          SessionStatus.set(child.session_id, { type: "busy" })
          await Bun.sleep(20)
          SessionStatus.set(child.session_id, { type: "idle" })
          await Bun.sleep(20)
          expect(prompt).toHaveBeenCalledTimes(1)
          expect(CollabMessage.hasPendingKind(child.id, "session_remote_task_terminal")).toBe(true)
          expect(() => ResearchSessionControl.assertHuman(parent.session_id)).not.toThrow()
          expect(ResearchSessionControl.branchSettled(parent.id)).toBe(false)
        } finally {
          CollabAutoWake.setEnabled(false)
          prompt.mockRestore()
        }

        let turns = 0
        CollabAutoWake.setDriveTurnOverrideForTesting(async (id) => {
          turns++
          CollabMessage.drain(id, "direct")
        })
        CollabAutoWake.setEnabled(true)
        try {
          SessionStatus.set(child.session_id, { type: "idle" })
          await Bun.sleep(20)
          expect(turns).toBe(1)
          expect(CollabMessage.hasPendingKind(child.id, "session_remote_task_terminal")).toBe(false)
          expect(CollabAgentNode.load(child.id).status).toBe("idle")
          expect(CollabMessage.list(parent.id, { kind: "remote_task_terminal" })).toHaveLength(0)
        } finally {
          CollabAutoWake.setEnabled(false)
          CollabAutoWake.setDriveTurnOverrideForTesting(undefined)
        }
      },
    })
  })

  test("drives a remote task listener in the experiment session directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const attached = await ExperimentAgent.attach(item.expId)
        const child = CollabAgentNode.load(attached.agentId!)
        const task = ExperimentRemoteTask.create({
          expId: item.expId,
          kind: "experiment_run",
          title: "Train model",
          server: "{}",
          remoteRoot: "/tmp",
          screenName: "train",
          command: "python train.py",
        })
        ExperimentRemoteTaskListener.register({ taskId: task.task_id, agentId: child.id })

        const other = path.join(tmp.path, "other")
        await fs.mkdir(other)
        let directory: string | undefined
        CollabAutoWake.setDriveTurnOverrideForTesting(async (id) => {
          directory = Instance.directory
          CollabMessage.drain(id, "direct")
        })
        CollabAutoWake.setEnabled(true)
        try {
          await Instance.provide({
            directory: other,
            fn: async () => {
              CollabAutoWake.ensure()
              ExperimentRemoteTask.update({ taskId: task.task_id, status: "finished" })
              await Bun.sleep(20)
            },
          })
          await Bun.sleep(20)
          expect(directory).toBe(tmp.path)
          expect(CollabMessage.hasPendingKind(child.id, "session_remote_task_terminal")).toBe(false)
        } finally {
          CollabAutoWake.setEnabled(false)
          CollabAutoWake.setDriveTurnOverrideForTesting(undefined)
        }
      },
    })
  })

  test("recovers a terminal listener left behind by a restart", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const attached = await ExperimentAgent.attach(item.expId)
        const child = CollabAgentNode.load(attached.agentId!)
        const task = ExperimentRemoteTask.create({
          expId: item.expId,
          kind: "experiment_run",
          title: "Recovered task",
          server: "{}",
          remoteRoot: "/tmp",
          screenName: "recovered",
          command: "python train.py",
        })
        ExperimentRemoteTaskListener.register({ taskId: task.task_id, agentId: child.id })
        Database.use((db) =>
          db
            .update(RemoteTaskTable)
            .set({ status: "finished", time_updated: Date.now() })
            .where(eq(RemoteTaskTable.task_id, task.task_id))
            .run(),
        )
        CollabMessage.post({
          recipientAgentId: child.id,
          runId: null,
          kind: "remote_task_terminal",
          payload: {
            taskId: task.task_id,
            expId: item.expId,
            kind: task.kind,
            title: task.title,
            status: "finished",
            logPath: task.log_path,
            errorMessage: null,
          },
        })

        CollabRecovery.reconcile()
        CollabRecovery.reconcile()

        expect(ExperimentRemoteTaskListener.has(child.id)).toBeUndefined()
        expect(CollabMessage.list(child.id, { kind: "session_remote_task_terminal" })).toMatchObject([
          { status: "pending", run_id: null },
        ])
      },
    })
  })

  test("delivers a new callback when a resource task id is reused", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const attached = await ExperimentAgent.attach(item.expId)
        const child = CollabAgentNode.load(attached.agentId!)
        const input = {
          expId: item.expId,
          kind: "resource_download" as const,
          resourceKey: "dataset",
          title: "Dataset",
          server: "{}",
          remoteRoot: "/tmp",
          screenName: "dataset",
          command: "download dataset",
        }
        const first = ExperimentRemoteTask.create(input)
        ExperimentRemoteTaskListener.register({ taskId: first.task_id, agentId: child.id })
        Database.use((db) =>
          db
            .update(RemoteTaskTable)
            .set({ status: "finished", time_updated: Date.now() })
            .where(eq(RemoteTaskTable.task_id, first.task_id))
            .run(),
        )
        CollabMessage.post({
          recipientAgentId: child.id,
          runId: null,
          kind: "session_remote_task_terminal",
          payload: {
            taskId: first.task_id,
            expId: item.expId,
            kind: first.kind,
            title: first.title,
            status: "finished",
            logPath: first.log_path,
            errorMessage: null,
          },
        })
        CollabMessage.ack(CollabMessage.drain(child.id, "direct"))
        await Bun.sleep(2)

        const second = ExperimentRemoteTask.create(input)
        expect(second.task_id).toBe(first.task_id)
        ExperimentRemoteTaskListener.register({ taskId: second.task_id, agentId: child.id })
        ExperimentRemoteTask.update({ taskId: second.task_id, status: "finished" })

        expect(CollabMessage.list(child.id, { kind: "session_remote_task_terminal" })).toMatchObject([
          { status: "consumed" },
          { status: "pending" },
        ])
      },
    })
  })

  test("does not consume a new listener from a stale terminal snapshot", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const attached = await ExperimentAgent.attach(item.expId)
        const child = CollabAgentNode.load(attached.agentId!)
        const task = ExperimentRemoteTask.create({
          expId: item.expId,
          kind: "experiment_run",
          title: "Restarted task",
          server: "{}",
          remoteRoot: "/tmp",
          screenName: "restarted",
          command: "python train.py",
        })
        ExperimentRemoteTaskListener.register({ taskId: task.task_id, agentId: child.id })
        Database.use((db) =>
          db
            .update(RemoteTaskTable)
            .set({ status: "finished", time_updated: Date.now() })
            .where(eq(RemoteTaskTable.task_id, task.task_id))
            .run(),
        )
        const stale = ExperimentRemoteTask.get(task.task_id)!
        Database.use((db) =>
          db
            .update(RemoteTaskTable)
            .set({ status: "pending", time_updated: Date.now() })
            .where(eq(RemoteTaskTable.task_id, task.task_id))
            .run(),
        )

        ExperimentRemoteTaskListener.notify(stale)

        expect(ExperimentRemoteTaskListener.has(child.id)).toBeDefined()
        expect(CollabMessage.list(child.id, { kind: "session_remote_task_terminal" })).toHaveLength(0)
      },
    })
  })

  test("wakes a blocked experiment when another instance detects remote task completion", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const attached = await ExperimentAgent.attach(item.expId)
        const child = CollabAgentNode.activate(attached.agentId!)
        const parent = CollabAgentNode.load(child.parent_agent_id!)
        const task = ExperimentRemoteTask.create({
          expId: item.expId,
          kind: "experiment_run",
          title: "Train model",
          server: "{}",
          remoteRoot: "/tmp",
          screenName: "train",
          command: "python train.py",
        })
        ExperimentRemoteTaskListener.register({ taskId: task.task_id, agentId: child.id })
        expect(ExperimentRemoteTaskListener.has(child.id, "collab")).toBeDefined()

        let directory: string | undefined
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(
          (async () => {
            directory = Instance.directory
            return undefined as never
          }) as unknown as typeof SessionPrompt.prompt,
        )
        const source = path.join(tmp.path, "source-collab")
        const detector = path.join(tmp.path, "detector-collab")
        await fs.mkdir(source)
        await fs.mkdir(detector)
        let run!: Promise<void>
        await Instance.provide({
          directory: source,
          fn: () => {
            run = CollabLoop.start(child.id)
          },
        })
        try {
          for (let i = 0; i < 100 && CollabAgentNode.load(child.id).status !== "blocked_on_children"; i++) {
            await Bun.sleep(10)
          }
          expect(CollabAgentNode.load(child.id).status).toBe("blocked_on_children")

          await Instance.provide({
            directory: detector,
            fn: async () => {
              ExperimentRemoteTask.update({ taskId: task.task_id, status: "finished" })
            },
          })

          await run
          expect(directory).toBe(tmp.path)
          expect(prompt).toHaveBeenCalledTimes(1)
          expect(CollabAgentNode.load(child.id).status).toBe("completed")
          expect(CollabMessage.list(child.id, { kind: "remote_task_terminal" })).toMatchObject([
            { status: "consumed" },
          ])
          expect(CollabMessage.list(parent.id, { kind: "child_done" })).toHaveLength(1)
          expect(CollabAgentNode.load(parent.id).active_children).toBe(0)
        } finally {
          CollabRuntime.abort(child.id)
          prompt.mockRestore()
        }
      },
    })
  })

  test("does not finalize while a remote terminal callback arrives", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const attached = await ExperimentAgent.attach(item.expId)
        const child = CollabAgentNode.activate(attached.agentId!)
        const original = Session.messages
        let release!: () => void
        let started!: () => void
        const ready = new Promise<void>((resolve) => {
          started = resolve
        })
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        let calls = 0
        const messages = spyOn(Session, "messages").mockImplementation(
          (async (input: { sessionID: string; limit?: number }) => {
            calls++
            if (calls === 1) {
              started()
              await gate
            }
            return original(input)
          }) as unknown as typeof Session.messages,
        )
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
        const run = CollabLoop.start(child.id)
        try {
          await ready
          await CollabMessage.post({
            recipientAgentId: child.id,
            senderAgentId: null,
            kind: "remote_task_terminal",
            payload: {
              taskId: crypto.randomUUID(),
              expId: item.expId,
              kind: "experiment_run",
              title: "Train model",
              status: "finished",
              logPath: null,
              errorMessage: null,
            },
          })
          release()

          await run
          expect(prompt).toHaveBeenCalledTimes(1)
          expect(CollabAgentNode.load(child.id).status).toBe("completed")
          expect(CollabMessage.list(child.id, { kind: "remote_task_terminal" })).toMatchObject([
            { status: "consumed" },
          ])
        } finally {
          release()
          CollabRuntime.abort(child.id)
          messages.mockRestore()
          prompt.mockRestore()
        }
      },
    })
  })

  test("repairs a failed Atom parent before resuming the same experiment agent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const attached = await ExperimentAgent.attach(item.expId)
        const child = CollabAgentNode.load(attached.agentId!)
        const parent = CollabAgentNode.load(child.parent_agent_id!)
        CollabAgentNode.transition(child.id, "failed", {
          error: { code: "LOOP_CRASH", message: "ProviderModelNotFoundError" },
        })
        CollabAgentNode.transition(parent.id, "failed", {
          error: { code: "CHILD_FAILED_FAIL_FAST", message: "child failed" },
        })

        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        try {
          const resumed = await Collab.resume({ agentId: child.id, prompt: "continue" })
          const repaired = CollabAgentNode.load(parent.id)
          expect(resumed.session_id).toBe(item.exp!.id)
          expect(resumed.status).toBe("running")
          expect(CollabAgentNode.isActive(repaired.status)).toBe(true)
          expect(repaired.spec.policy?.on_fail).toBe("continue")
          expect(repaired.active_children).toBe(1)
        } finally {
          start.mockRestore()
        }
      },
    })
  })

  test("uses the Atom model when the experiment model is unavailable", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const get = spyOn(Provider, "getModel").mockImplementation(async (providerID, modelID) => {
          if (providerID === "atom" && modelID === "current") return {} as never
          throw new Provider.ModelNotFoundError({ providerID, modelID, suggestions: [] })
        })
        const fallback = spyOn(Provider, "defaultModel").mockRejectedValue(new Error("no default"))
        const list = spyOn(Provider, "list").mockResolvedValue({} as never)
        try {
          expect(
            await SessionPrompt.resolveModel({
              sessionID: (await Session.create({ title: "model recovery" })).id,
              agent: "experiment",
              preferred: { providerID: "removed", modelID: "old" },
              fallback: { providerID: "atom", modelID: "current" },
            }),
          ).toEqual({ providerID: "atom", modelID: "current" })
        } finally {
          get.mockRestore()
          fallback.mockRestore()
          list.mockRestore()
        }
      },
    })
  })

  test("persists the recovered Atom model on the experiment agent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const attached = await ExperimentAgent.attach(item.expId)
        const child = CollabAgentNode.load(attached.agentId!)
        CollabAgentNode.spec(child.id, {
          ...child.spec,
          model: { providerID: "removed", modelID: "old" },
        })
        const resolve = spyOn(SessionPrompt, "resolveModel").mockResolvedValue({
          providerID: "atom",
          modelID: "current",
        })
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
        try {
          await Collab.resume({
            agentId: child.id,
            prompt: "continue",
            model: { providerID: "atom", modelID: "current" },
          })
          await CollabRuntime.get(child.id)?.promise
          expect(CollabAgentNode.load(child.id).spec.model).toEqual({
            providerID: "atom",
            modelID: "current",
          })
          expect(prompt.mock.calls[0]?.[0]?.model).toEqual({ providerID: "atom", modelID: "current" })
        } finally {
          resolve.mockRestore()
          prompt.mockRestore()
        }
      },
    })
  })

  test("keeps an experiment recoverable when its model disappears during a turn", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const attached = await ExperimentAgent.attach(item.expId)
        const child = CollabAgentNode.activate(attached.agentId!)
        CollabMessage.post({
          recipientAgentId: child.id,
          senderAgentId: null,
          kind: "user_input",
          payload: { text: "continue" },
        })
        const prompt = spyOn(SessionPrompt, "prompt").mockRejectedValue(
          new Provider.ModelNotFoundError({ providerID: "removed", modelID: "old", suggestions: [] }),
        )
        try {
          await CollabLoop.start(child.id)
          const waiting = CollabAgentNode.load(child.id)
          expect(waiting.status).toBe("waiting_interaction")
          expect(waiting.session_id).toBe(item.exp!.id)
          expect(CollabMessage.list(waiting.parent_agent_id!, { kind: "child_waiting" })).toHaveLength(1)
          expect(CollabMessage.list(waiting.parent_agent_id!, { kind: "child_failed" })).toHaveLength(0)
        } finally {
          prompt.mockRestore()
        }
      },
    })
  })

  test("creates a missing experiment session before attachment", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed({ session: false })
        const [result, duplicate] = await Promise.all([
          ExperimentAgent.attach(item.expId),
          ExperimentAgent.attach(item.expId),
        ])
        const node = CollabAgentNode.load(result.agentId!)
        const exp = Database.use((db) =>
          db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, item.expId)).get(),
        )
        expect(result.status).toBe("attached")
        expect(duplicate.agentId).toBe(result.agentId)
        expect(exp?.exp_session_id).toBe(node.session_id)
        expect(node.status).toBe("idle")
      },
    })
  })

  test("moves an idle experiment when its atom session changes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const first = await ExperimentAgent.attach(item.expId)
        const previous = CollabAgentNode.load(first.agentId!)
        const session = await Session.create({ title: "Atom: replacement" })
        Database.use((db) =>
          db.update(AtomTable).set({ session_id: session.id }).where(eq(AtomTable.atom_id, item.atomId)).run(),
        )

        const result = await ExperimentAgent.attach(item.expId)
        const moved = CollabAgentNode.load(result.agentId!)
        const parent = CollabAgentNode.load(moved.parent_agent_id!)
        expect(result.agentId).toBe(first.agentId)
        expect(moved.parent_agent_id).not.toBe(previous.parent_agent_id)
        expect(parent.session_id).toBe(session.id)
        expect(moved.root_agent_id).toBe(parent.root_agent_id)
      },
    })
  })

  test("recovers the same agent and history when an experiment session is archived", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const first = await ExperimentAgent.attach(item.expId)
        await Session.setArchived({ sessionID: item.exp!.id, time: Date.now() })

        const result = await ExperimentAgent.attach(item.expId)
        const node = CollabAgentNode.load(result.agentId!)
        const exp = Database.use((db) =>
          db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, item.expId)).get(),
        )
        expect(result.agentId).toBe(first.agentId)
        expect(node.session_id).toBe(exp!.exp_session_id!)
        expect(node.session_id).toBe(item.exp!.id)
        expect((await Session.get(node.session_id)).time.archived).toBeUndefined()
        expect(node.status).toBe("idle")
      },
    })
  })

  test("retries a deferred atom move after the active runtime exits", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const first = await ExperimentAgent.attach(item.expId)
        const node = CollabAgentNode.load(first.agentId!)
        const previous = node.parent_agent_id!
        CollabAgentNode.activate(node.id)
        const session = await Session.create({ title: "Atom: replacement" })
        Database.use((db) =>
          db.update(AtomTable).set({ session_id: session.id }).where(eq(AtomTable.atom_id, item.atomId)).run(),
        )

        let finish!: () => void
        const promise = new Promise<void>((resolve) => (finish = resolve))
        CollabRuntime.register(node.id, new AbortController(), promise)
        expect((await ExperimentAgent.attach(item.expId)).status).toBe("deferred")

        CollabAgentNode.transition(node.id, "completed")
        await CollabMessage.post({
          recipientAgentId: previous,
          senderAgentId: node.id,
          kind: "child_done",
          payload: { childAgentId: node.id, childName: node.name, summary: "done" },
        })
        finish()
        await promise
        await Bun.sleep(20)

        const moved = CollabAgentNode.load(node.id)
        expect(moved.parent_agent_id).not.toBe(previous)
        expect(CollabAgentNode.load(moved.parent_agent_id!).session_id).toBe(session.id)
      },
    })
  })

  test("adopts a settled experiment root and preserves its descendants", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const root = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: root,
          sessionId: item.exp!.id,
          name: "legacy root",
          projectId: Instance.project.id,
          rootAgentId: root,
          subagentType: "experiment",
          spec: { initialPrompt: "" },
        })
        const session = await Session.create({ title: "legacy child" })
        const child = CollabAgentNode.create({
          id: Identifier.ascending("collab_agent"),
          sessionId: session.id,
          parentAgentId: root,
          name: "legacy child",
          projectId: Instance.project.id,
          rootAgentId: root,
          subagentType: "general",
          spec: { initialPrompt: "" },
          status: "completed",
        })

        const result = await ExperimentAgent.attach(item.expId)
        const adopted = CollabAgentNode.load(root)
        const parent = CollabAgentNode.load(adopted.parent_agent_id!)
        expect(result).toEqual({ status: "attached", agentId: root })
        expect(adopted.status).toBe("idle")
        expect(adopted.root_agent_id).toBe(parent.root_agent_id)
        expect(CollabAgentNode.load(child.id).parent_agent_id).toBe(root)
        expect(CollabAgentNode.load(child.id).root_agent_id).toBe(parent.root_agent_id)
        expect(parent.active_children).toBe(0)
      },
    })
  })

  test("defers adoption while a legacy descendant is active", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const root = Identifier.ascending("collab_agent")
        CollabAgentNode.create({
          id: root,
          sessionId: item.exp!.id,
          name: "legacy root",
          projectId: Instance.project.id,
          rootAgentId: root,
          subagentType: "experiment",
          spec: { initialPrompt: "" },
        })
        const session = await Session.create({ title: "active child" })
        CollabAgentNode.create({
          id: Identifier.ascending("collab_agent"),
          sessionId: session.id,
          parentAgentId: root,
          name: "active child",
          projectId: Instance.project.id,
          rootAgentId: root,
          subagentType: "general",
          spec: { initialPrompt: "" },
        })

        const result = await ExperimentAgent.attach(item.expId)
        expect(result.status).toBe("deferred")
        expect(CollabAgentNode.load(root).parent_agent_id).toBeNull()
      },
    })
  })

  test("resume activates an idle experiment and blocks human input", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const result = await ExperimentAgent.attach(item.expId)
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        const release = ExperimentAgent.claimHuman(item.exp!.id)
        await expect(Collab.resume({ agentId: result.agentId!, prompt: "race with human" })).rejects.toBeInstanceOf(
          Session.BusyError,
        )
        release()
        expect(CollabAgentNode.load(result.agentId!).status).toBe("idle")
        await Collab.resume({ agentId: result.agentId!, prompt: "run this experiment" })

        const child = CollabAgentNode.load(result.agentId!)
        const parent = CollabAgentNode.load(child.parent_agent_id!)
        expect(child.status).toBe("running")
        expect(child.initiator).toBe("agent")
        expect(parent.active_children).toBe(1)
        expect(() => ExperimentAgent.assertHuman(item.exp!.id)).toThrow(ExperimentAgent.BusyError)
        start.mockRestore()
      },
    })
  })

  test("human experiment spawn uses Collab without reporting completion to Atom", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const attached = await ExperimentAgent.attach(item.expId)
        const message: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          sessionID: item.exp!.id,
          role: "assistant",
          parentID: Identifier.ascending("message"),
          mode: "default",
          agent: "experiment",
          modelID: "model",
          providerID: "provider",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        }
        await Session.updateMessage(message)
        const ctx = {
          sessionID: item.exp!.id,
          messageID: message.id,
          agent: "experiment",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } satisfies Tool.Context
        const tool = await SpawnAgentTool.init()
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        const release = ExperimentAgent.claimHuman(item.exp!.id)
        let initiator: "human" | "agent" | null | undefined
        const off = Bus.subscribe(CollabEvent.AgentStatus, (event) => {
          if (event.properties.agentId === attached.agentId) initiator = event.properties.initiator
        })
        const spawned = await Promise.all([
          tool.execute({ agent_type: "general", name: "first child", prompt: "complete the first task" }, ctx),
          tool.execute({ agent_type: "general", name: "second child", prompt: "complete the second task" }, ctx),
        ])
        off()
        start.mockRestore()

        const parent = CollabAgentNode.load(attached.agentId!)
        const atom = CollabAgentNode.load(parent.parent_agent_id!)
        const children = spawned.map((result) => CollabAgentNode.load(result.metadata.agentId))
        expect(parent.status).toBe("running")
        expect(parent.initiator).toBe("human")
        expect(initiator).toBe("human")
        expect(parent.active_children).toBe(2)
        expect(atom.active_children).toBe(0)
        expect(children.every((child) => child.parent_agent_id === parent.id)).toBe(true)
        expect(children.every((child) => child.initiator === "agent")).toBe(true)
        expect((await ExperimentAgent.recover(parent.id))?.initiator).toBe("human")
        await expect(Collab.resume({ agentId: parent.id, prompt: "Atom takeover" })).rejects.toThrow(
          "belongs to a human session",
        )

        release()
        expect(
          ResearchSessionControl.queueHumanPrompt(item.exp!.id, {
            messageID: Identifier.ascending("message"),
            model: { providerID: "provider", modelID: "first" },
            agent: "plan",
            noReply: true,
            variant: "fast",
            parts: [
              { type: "text", text: "first follow-up" },
              { type: "file", mime: "text/plain", url: "data:text/plain;base64,b25l", filename: "one.txt" },
            ],
          }),
        ).toBe(true)
        expect(
          ResearchSessionControl.queueHumanPrompt(item.exp!.id, {
            messageID: Identifier.ascending("message"),
            model: { providerID: "provider", modelID: "second" },
            agent: "experiment",
            parts: [{ type: "text", text: "second follow-up" }],
          }),
        ).toBe(true)
        const inputs: SessionPrompt.PromptInput[] = []
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(
          (async (input: SessionPrompt.PromptInput) => {
            inputs.push(input)
            return undefined as never
          }) as unknown as typeof SessionPrompt.prompt,
        )
        CollabAutoWake.setEnabled(true)
        try {
          CollabAutoWake.wake(item.exp!.id)
          for (let i = 0; i < 100 && inputs.length < 2; i++) await Bun.sleep(10)
          expect(inputs.map((input) => input.parts[0])).toEqual([
            expect.objectContaining({ type: "text", text: "first follow-up" }),
            expect.objectContaining({ type: "text", text: "second follow-up" }),
          ])
          expect(inputs[0].parts[1]).toEqual(
            expect.objectContaining({ type: "file", filename: "one.txt", url: "data:text/plain;base64,b25l" }),
          )
          expect(inputs.map((input) => input.model?.modelID)).toEqual(["first", "second"])
          expect(inputs.map((input) => input.agent)).toEqual(["plan", "experiment"])
          expect(inputs[0].noReply).toBe(true)
          expect(inputs[0].variant).toBe("fast")
          for (const child of children) {
            CollabAgentNode.finish({
              id: child.id,
              runId: child.run_id,
              parentId: child.parent_agent_id,
              status: "completed",
              phase: "main_loop",
              result: { summary: "child complete" },
              timeEnded: Date.now(),
              report: {
                kind: "child_done",
                payload: { childAgentId: child.id, childName: child.name, summary: "child complete" },
              },
            })
          }
          for (let i = 0; i < 100 && CollabAgentNode.load(parent.id).status !== "idle"; i++) {
            await Bun.sleep(10)
          }
        } finally {
          release()
          CollabAutoWake.setEnabled(false)
          CollabRuntime.abort(parent.id)
          prompt.mockRestore()
        }

        const settled = CollabAgentNode.load(parent.id)
        expect(settled.status).toBe("idle")
        expect(settled.run_id).toBeNull()
        expect(settled.initiator).toBeNull()
        expect(CollabAgentNode.load(atom.id).active_children).toBe(0)
        expect(CollabMessage.list(atom.id, { kind: "child_done" })).toHaveLength(0)
        expect(() => ExperimentAgent.assertHuman(item.exp!.id)).not.toThrow()
      },
    })
  })

  test("failed human promotion leaves the experiment idle", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const attached = await ExperimentAgent.attach(item.expId)
        await expect(
          Collab.spawn({
            parentSessionId: item.exp!.id,
            name: "unowned child",
            subagentType: "general",
            spec: { initialPrompt: "fail before start" },
            startParent: "human",
          }),
        ).rejects.toThrow("not owned by a human turn")
        const node = CollabAgentNode.load(attached.agentId!)
        expect(node.status).toBe("idle")
        expect(node.initiator).toBeNull()
        expect(node.active_children).toBe(0)
        expect(CollabAgentNode.loadChildren(node.id)).toHaveLength(0)
        expect(CollabAgentNode.load(node.parent_agent_id!).active_children).toBe(0)
      },
    })
  })

  test("canceling a human run drains descendants before returning idle", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const attached = await ExperimentAgent.attach(item.expId)
        const release = ExperimentAgent.claimHuman(item.exp!.id)
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        const child = await Collab.spawn({
          parentSessionId: item.exp!.id,
          name: "cancel child",
          subagentType: "general",
          spec: { initialPrompt: "wait" },
          startParent: "human",
        })
        const grandchild = await Collab.spawn({
          parentSessionId: child.session_id,
          name: "cancel grandchild",
          subagentType: "general",
          spec: { initialPrompt: "wait deeper" },
        })
        release()
        start.mockRestore()

        const parent = CollabAgentNode.load(attached.agentId!)
        ResearchSessionControl.assertAbort(item.exp!.id)
        await CollabLoop.start(parent.id)
        const draining = CollabAgentNode.load(parent.id)
        expect(draining.status).toBe("blocked_on_children")
        expect(draining.error?.code).toBe("CANCELED")
        expect(draining.initiator).toBe("human")

        await CollabLoop.start(child.id)
        expect(CollabAgentNode.load(child.id).status).toBe("blocked_on_children")
        expect(CollabAgentNode.load(parent.id).active_children).toBe(1)
        await CollabLoop.start(grandchild.id)
        await CollabLoop.start(child.id)
        await CollabLoop.start(parent.id)

        const settled = CollabAgentNode.load(parent.id)
        expect(settled.status).toBe("idle")
        expect(settled.initiator).toBeNull()
        expect(CollabMessage.list(settled.parent_agent_id!, { kind: "child_failed" })).toHaveLength(0)
      },
    })
  })

  test("human input resumes a model-unavailable run", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const attached = await ExperimentAgent.attach(item.expId)
        const active = CollabAgentNode.activate(attached.agentId!, undefined, "human")
        CollabAgentNode.transition(active.id, "waiting_interaction", {
          error: { code: "MODEL_UNAVAILABLE", message: "select another model" },
        })
        expect(
          ResearchSessionControl.queueHumanPrompt(item.exp!.id, {
            messageID: Identifier.ascending("message"),
            model: { providerID: "available", modelID: "replacement" },
            agent: "experiment",
            parts: [{ type: "text", text: "continue with this model" }],
          }),
        ).toBe(true)
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
        try {
          await CollabLoop.start(active.id)
          expect(prompt.mock.calls[0]?.[0].model).toEqual({ providerID: "available", modelID: "replacement" })
        } finally {
          prompt.mockRestore()
        }

        const settled = CollabAgentNode.load(active.id)
        expect(settled.status).toBe("idle")
        expect(settled.error).toBeNull()
      },
    })
  })

  test("removing an experiment session removes spawned descendants", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const result = await ExperimentAgent.attach(item.expId)
        const peer = await Collab.createSubSession({ title: "spawned peer" })
        const child = CollabAgentNode.create({
          id: Identifier.ascending("collab_agent"),
          sessionId: peer.id,
          parentAgentId: result.agentId,
          name: "spawned peer",
          projectId: Instance.project.id,
          rootAgentId: CollabAgentNode.load(result.agentId!).root_agent_id,
          subagentType: "general",
          spec: { initialPrompt: "" },
          status: "completed",
        })

        await Session.remove(item.exp!.id)
        expect(CollabAgentNode.tryLoad(result.agentId!)).toBeUndefined()
        expect(CollabAgentNode.tryLoad(child.id)).toBeUndefined()
        await expect(Session.get(peer.id)).rejects.toBeDefined()
      },
    })
  })

  test("removing an active experiment reports failure to its atom", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const result = await ExperimentAgent.attach(item.expId)
        const active = CollabAgentNode.activate(result.agentId!)
        const parent = active.parent_agent_id!

        await Session.remove(item.exp!.id)
        expect(CollabAgentNode.load(parent).active_children).toBe(0)
        const messages = CollabMessage.list(parent, { kind: "child_failed" })
        expect(messages).toHaveLength(1)
        expect((messages[0].payload_json as { childAgentId: string }).childAgentId).toBe(active.id)
      },
    })
  })

  test("removing an atom session detaches but preserves experiment sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const result = await ExperimentAgent.attach(item.expId)
        await Session.remove(item.atom.id)

        const node = CollabAgentNode.load(result.agentId!)
        expect(node.parent_agent_id).toBeNull()
        expect(node.root_agent_id).toBe(node.id)
        expect((await Session.get(item.exp!.id)).id).toBe(item.exp!.id)
      },
    })
  })
})
