import { describe, expect, spyOn, test } from "bun:test"

import { Session } from "../../src/session"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { CollabAutoWake } from "../../src/collab/auto-wake"
import { CollabLoop } from "../../src/collab/loop"
import { CollabMessage } from "../../src/collab/message"
import { CollabRecovery } from "../../src/collab/recovery"
import { Instance } from "../../src/project/instance"
import { AtomAgent } from "../../src/research/atom-agent"
import { ExperimentRemoteTask } from "../../src/research/experiment-remote-task"
import { ExperimentRemoteTaskListener } from "../../src/research/experiment-remote-task-listener"
import { ExperimentTable, AtomTable, ResearchProjectTable } from "../../src/research/research.sql"
import { Database, eq } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

CollabAutoWake.setEnabled(false)

async function seed(input?: { experiment?: boolean; research?: string }) {
  const research = input?.research ?? crypto.randomUUID()
  const atomId = crypto.randomUUID()
  const expId = crypto.randomUUID()
  const exp = input?.experiment === false ? undefined : await Session.create({ title: "Exp: delegated" })
  const now = Date.now()
  if (!input?.research) {
    Database.use((db) =>
      db
        .insert(ResearchProjectTable)
        .values({
          research_project_id: research,
          project_id: Instance.project.id,
          time_created: now,
          time_updated: now,
        })
        .run(),
    )
  }
  Database.use((db) =>
    db
      .insert(AtomTable)
      .values({
        atom_id: atomId,
        research_project_id: research,
        atom_name: "delegated atom",
        atom_type: "verification",
        atom_evidence_type: "experiment",
        atom_evidence_status: "pending",
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  if (exp) {
    Database.use((db) =>
      db
        .insert(ExperimentTable)
        .values({
          exp_id: expId,
          research_project_id: research,
          exp_name: "delegated experiment",
          atom_id: atomId,
          exp_session_id: exp.id,
          code_path: Instance.directory,
          time_created: now,
          time_updated: now,
        })
        .run(),
    )
  }
  return { atomId, exp, expId, research }
}

describe("research.atom-agent", () => {
  test("leases an Atom subtree idempotently and keeps waiting attached", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const source = await Session.create({ title: "project root" })
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        try {
          const first = await AtomAgent.delegate({
            atomId: item.atomId,
            sourceSessionId: source.id,
            agent: "research",
            prompt: "check the evidence",
            model: { providerID: "sender", modelID: "flash" },
            runId: "stable-run",
          })
          const target = CollabAgentNode.load(first.agentId)
          const exp = CollabAgentNode.loadBySessionId(item.exp!.id)!
          expect(target.parent_agent_id).toBe(first.parentAgentId)
          expect(target.run_id).toBe("stable-run")
          expect(target.spec.policy?.detach_on_terminal).toBe(true)
          expect(exp.parent_agent_id).toBe(target.id)
          expect(exp.root_agent_id).toBe(target.root_agent_id)
          expect(() => AtomAgent.assertHuman(target.session_id)).toThrow()

          const duplicate = await AtomAgent.delegate({
            atomId: item.atomId,
            sourceSessionId: source.id,
            agent: "research",
            prompt: "check the evidence",
            model: { providerID: "sender", modelID: "flash" },
            runId: "stable-run",
          })
          expect(duplicate).toEqual(first)
          expect(CollabMessage.list(target.id, { kind: "user_input" })).toHaveLength(1)
          expect(CollabMessage.list(target.id, { kind: "user_input" })[0].payload_json).toMatchObject({
            model: { providerID: "sender", modelID: "flash" },
          })
          expect(CollabAgentNode.load(first.parentAgentId).active_children).toBe(1)

          CollabAgentNode.transition(target.id, "waiting_interaction")
          expect(CollabAgentNode.load(target.id).parent_agent_id).toBe(first.parentAgentId)
          expect(CollabAgentNode.load(target.id).run_id).toBe("stable-run")
        } finally {
          start.mockRestore()
        }
      },
    })
  })

  test("reports the owning project session to a competing root", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed({ experiment: false })
        const owner = await Session.create({ title: "owner" })
        const other = await Session.create({ title: "other" })
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        try {
          const results = await Promise.allSettled([
            AtomAgent.delegate({
              atomId: item.atomId,
              sourceSessionId: owner.id,
              agent: "research",
              prompt: "owner task",
              runId: "owner-run",
            }),
            AtomAgent.delegate({
              atomId: item.atomId,
              sourceSessionId: other.id,
              agent: "research",
              prompt: "competing task",
              runId: "other-run",
            }),
          ])
          const winner = results.find((result) => result.status === "fulfilled")
          const loser = results.find((result) => result.status === "rejected")
          expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
          expect(loser?.status === "rejected" ? loser.reason : undefined).toBeInstanceOf(AtomAgent.BusyError)
          expect(loser?.status === "rejected" ? loser.reason : undefined).toMatchObject({
            reason: "leased",
            ownerSessionID: winner?.status === "fulfilled" ? winner.value.parentSessionId : undefined,
          })
        } finally {
          start.mockRestore()
        }
      },
    })
  })

  test("human ownership blocks delegation and an active lease blocks Atom human control", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed({ experiment: false })
        const source = await Session.create({ title: "source" })
        const target = await AtomAgent.ensure(item.atomId)
        const human = AtomAgent.claimHuman(target.session.id)
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        try {
          const err = await AtomAgent.delegate({
            atomId: item.atomId,
            sourceSessionId: source.id,
            agent: "research",
            prompt: "race",
            runId: "human-race",
          }).catch((error) => error)
          expect(err).toMatchObject({ reason: "human_control" })
          human()

          const leased = await AtomAgent.delegate({
            atomId: item.atomId,
            sourceSessionId: source.id,
            agent: "research",
            prompt: "after human",
            runId: "after-human",
          })
          expect(() => AtomAgent.claimHuman(leased.sessionId)).toThrow()
        } finally {
          human()
          start.mockRestore()
        }
      },
    })
  })

  test("direct Atom control requires its independent branch to be settled", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const target = await AtomAgent.ensure(item.atomId)
        const exp = CollabAgentNode.loadBySessionId(item.exp!.id)!
        CollabAgentNode.activate(exp.id)

        expect(() => AtomAgent.claimHuman(target.session.id)).toThrow("busy")
      },
    })
  })

  test("rejects non-root and domain-bound source sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ title: "child", parentID: parent.id })
        await expect(
          AtomAgent.delegate({
            atomId: item.atomId,
            sourceSessionId: child.id,
            agent: "research",
            prompt: "invalid",
            runId: "invalid-child",
          }),
        ).rejects.toThrow("ordinary root")
        await expect(
          AtomAgent.delegate({
            atomId: item.atomId,
            sourceSessionId: item.exp!.id,
            agent: "experiment",
            prompt: "invalid",
            runId: "invalid-exp",
          }),
        ).rejects.toThrow("cannot delegate")
      },
    })
  })

  test("terminal recovery restores the Atom as an independent root", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const source = await Session.create({ title: "source" })
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        try {
          const result = await AtomAgent.delegate({
            atomId: item.atomId,
            sourceSessionId: source.id,
            agent: "research",
            prompt: "finish",
            runId: "terminal-run",
          })
          CollabAgentNode.transition(result.agentId, "completed", {
            result: { summary: "done" },
            timeEnded: Date.now(),
          })
          await CollabRecovery.scan()

          const target = CollabAgentNode.load(result.agentId)
          expect(target.parent_agent_id).toBeNull()
          expect(target.root_agent_id).toBe(target.id)
          expect(target.run_id).toBeNull()
          expect(CollabAgentNode.isActive(target.status)).toBe(true)
          expect(CollabAgentNode.loadBySessionId(item.exp!.id)?.root_agent_id).toBe(target.id)
          expect(CollabMessage.list(result.parentAgentId, { kind: "child_done" })).toHaveLength(1)

          const duplicate = await AtomAgent.delegate({
            atomId: item.atomId,
            sourceSessionId: source.id,
            agent: "research",
            prompt: "finish",
            runId: "terminal-run",
          })
          expect(duplicate.status).toBe("completed")
          expect(CollabAgentNode.load(result.agentId).parent_agent_id).toBeNull()
          expect(CollabMessage.list(result.agentId, { kind: "user_input" })).toHaveLength(1)
        } finally {
          start.mockRestore()
        }
      },
    })
  })

  test("scan reactivates detached Atom roots without reparenting active leases", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = await seed({ experiment: false })
        const repaired = await AtomAgent.ensure(first.atomId)
        CollabAgentNode.transition(repaired.agent.id, "failed")
        await AtomAgent.scan()
        expect(CollabAgentNode.isActive(CollabAgentNode.load(repaired.agent.id).status)).toBe(true)

        const second = await seed({ experiment: false, research: first.research })
        const source = await Session.create({ title: "source" })
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        try {
          const leased = await AtomAgent.delegate({
            atomId: second.atomId,
            sourceSessionId: source.id,
            agent: "research",
            prompt: "remain leased",
            runId: "scan-lease",
          })
          await AtomAgent.scan()
          expect(CollabAgentNode.load(leased.agentId).parent_agent_id).toBe(leased.parentAgentId)
          expect(CollabAgentNode.load(leased.agentId).run_id).toBe("scan-lease")
        } finally {
          start.mockRestore()
        }
      },
    })
  })

  test("scan keeps unopened Atom sessions lazy", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed({ experiment: false })
        await AtomAgent.scan()

        const atom = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, item.atomId)).get())
        expect(atom?.session_id).toBeNull()
      },
    })
  })

  test("deleting the owning project session preserves and restores the Atom subtree", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const source = await Session.create({ title: "deleted source" })
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        try {
          const result = await AtomAgent.delegate({
            atomId: item.atomId,
            sourceSessionId: source.id,
            agent: "research",
            prompt: "interrupted",
            runId: "deleted-parent",
          })
          const task = ExperimentRemoteTask.create({
            expId: item.expId,
            kind: "experiment_run",
            title: "Interrupted task",
            server: "{}",
            remoteRoot: "/tmp",
            screenName: "interrupted",
            command: "python train.py",
          })
          ExperimentRemoteTaskListener.register({ taskId: task.task_id, agentId: result.agentId })
          await Session.remove(source.id)

          const target = CollabAgentNode.load(result.agentId)
          expect(target.parent_agent_id).toBeNull()
          expect(target.root_agent_id).toBe(target.id)
          expect(CollabAgentNode.isActive(target.status)).toBe(true)
          expect(CollabMessage.hasPendingWakeMsg(target.id)).toBe(false)
          expect((await Session.get(target.session_id)).id).toBe(target.session_id)
          expect((await Session.get(item.exp!.id)).id).toBe(item.exp!.id)
          expect(ExperimentRemoteTaskListener.has(result.agentId)).toBeUndefined()
        } finally {
          start.mockRestore()
        }
      },
    })
  })
})
