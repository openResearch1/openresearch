import { describe, expect, test } from "bun:test"

import { Collab } from "../../src/collab"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { CollabAutoWake } from "../../src/collab/auto-wake"
import { CollabMessage } from "../../src/collab/message"
import { CollabRecovery } from "../../src/collab/recovery"
import { CollabAgentTable } from "../../src/collab/collab.sql"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { ResearchSessionControl } from "../../src/research/session-control"
import { Session } from "../../src/session"
import { Database, eq } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

CollabAutoWake.setEnabled(false)

async function node(input: {
  name: string
  parent?: string
  root?: string
  initiator?: "human" | "agent"
  detach?: boolean
  activeParent?: boolean
  parentGeneration?: number
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
    subagentType: "general",
    spec: {
      initialPrompt: input.name,
      policy: input.detach ? { detach_on_terminal: true } : undefined,
    },
    status: "running",
    initiator: input.initiator,
    activeParent: input.activeParent,
    parentGeneration: input.parentGeneration,
  })
}

describe("Collab controller stop", () => {
  test("durably stops automatic descendants and preserves human runs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await node({ name: "controller" })
        const child = await node({ name: "automatic", parent: root.id, root: root.id })
        const human = await node({ name: "human", parent: root.id, root: root.id, initiator: "human" })
        CollabMessage.post({ recipientAgentId: root.id, kind: "user_input", payload: { text: "queued" } })
        CollabMessage.post({
          recipientAgentId: child.id,
          runId: child.run_id,
          kind: "user_input",
          payload: { text: "work" },
        })

        const stopped = await Collab.stop(root.id)
        expect(stopped.status).toBe("canceled")
        expect(stopped.spec.metadata?.stoppedByUser).toBe(true)
        expect(stopped.spec.metadata?.stopReady).toBe(true)
        expect(CollabAgentNode.load(child.id).status).toBe("canceled")
        expect(CollabAgentNode.load(child.id).spec.metadata?.stoppedByUser).toBe(true)
        expect(CollabAgentNode.load(human.id).status).toBe("running")
        expect(CollabMessage.list(root.id).every((item) => item.status === "dropped")).toBe(true)
        expect(CollabMessage.list(child.id).every((item) => item.status === "dropped")).toBe(true)

        expect(
          CollabMessage.post({
            recipientAgentId: root.id,
            senderAgentId: child.id,
            runId: child.run_id,
            kind: "child_failed",
            payload: { childAgentId: child.id, childName: child.name, reason: "canceled", message: "late" },
          }),
        ).toBeUndefined()
        expect(CollabMessage.list(root.id, { kind: "child_failed" })).toHaveLength(0)

        const restarted = CollabAgentNode.restart(root.id)
        expect(restarted.status).toBe("running")
        await expect(
          node({
            name: "stale-spawn",
            parent: root.id,
            root: root.id,
            activeParent: true,
            parentGeneration: 0,
          }),
        ).rejects.toThrow("changed before child creation")
        expect(
          CollabMessage.post({
            recipientAgentId: root.id,
            senderAgentId: child.id,
            runId: child.run_id,
            kind: "child_failed",
            payload: { childAgentId: child.id, childName: child.name, reason: "canceled", message: "later" },
          }),
        ).toBeUndefined()
        expect(
          await CollabMessage.postChildWaiting({
            agentId: child.id,
            rootAgentId: root.id,
            recipientAgentId: root.id,
            payload: {
              runId: child.run_id ?? undefined,
              childAgentId: child.id,
              childName: child.name,
              childSessionId: child.session_id,
              message: "stale wait",
            },
          }),
        ).toBeUndefined()
        expect(CollabAgentNode.load(child.id).status).toBe("canceled")
      },
    })
  })

  test("the next human prompt claim restarts a user-stopped root", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await node({ name: "restart-controller" })
        await Collab.stop(root.id)

        const release = ResearchSessionControl.claimHuman(root.session_id, { restart: true })
        try {
          const restarted = CollabAgentNode.load(root.id)
          expect(restarted.status).toBe("running")
          expect(restarted.initiator).toBe("human")
          expect(restarted.error).toBeNull()
          expect(restarted.spec.metadata?.stoppedByUser).toBeUndefined()
        } finally {
          release()
        }
      },
    })
  })

  test("stopping a leased agent releases it as an independent root", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await node({ name: "lease-controller" })
        const atom = await node({ name: "leased-atom", parent: root.id, root: root.id, detach: true })

        await Collab.stop(root.id)

        const released = CollabAgentNode.load(atom.id)
        expect(released.parent_agent_id).toBeNull()
        expect(released.root_agent_id).toBe(atom.id)
        expect(released.status).toBe("running")
        expect(released.spec.policy?.detach_on_terminal).toBe(false)
        expect(released.spec.metadata?.stoppedByUser).toBeUndefined()
      },
    })
  })

  test("direct callbacks do not wake a stopped root", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await node({ name: "stopped-direct" })
        const child = await node({ name: "stopped-direct-child", parent: root.id, root: root.id })
        await Collab.stop(root.id)
        let turns = 0
        CollabAutoWake.setDriveTurnOverrideForTesting(async () => {
          turns++
        })
        CollabAutoWake.setEnabled(true)
        CollabAutoWake.ensure()
        try {
          CollabMessage.post({
            recipientAgentId: root.id,
            kind: "session_remote_task_terminal",
            payload: {
              taskId: "task",
              expId: "experiment",
              kind: "experiment_run",
              title: "late task",
              status: "finished",
              logPath: null,
              errorMessage: null,
            },
          })
          CollabMessage.post({
            recipientAgentId: child.id,
            kind: "session_remote_task_terminal",
            payload: {
              taskId: "child-task",
              expId: "experiment",
              kind: "experiment_run",
              title: "late child task",
              status: "finished",
              logPath: null,
              errorMessage: null,
            },
          })
          await Bun.sleep(50)
          expect(turns).toBe(0)
          expect(CollabAgentNode.load(root.id).status).toBe("canceled")
        } finally {
          CollabAutoWake.setDriveTurnOverrideForTesting(undefined)
          CollabAutoWake.setEnabled(false)
        }
      },
    })
  })

  test("recovery completes interrupted stop cleanup and stopped roots reject new children", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await node({ name: "recovered-stop" })
        const first = CollabAgentNode.stop(root.id)
        const duplicate = CollabAgentNode.stop(root.id)
        expect(first.valid).toBe(true)
        expect(duplicate.valid).toBe(false)
        expect(duplicate.token).toBe(first.token)
        expect(CollabAgentNode.load(root.id).spec.metadata?.stopReady).toBe(false)
        const stopped = CollabAgentNode.load(root.id)
        Database.use((db) =>
          db
            .update(CollabAgentTable)
            .set({
              spec_json: {
                ...stopped.spec,
                metadata: {
                  ...stopped.spec.metadata,
                  stopClaimedAt: Date.now() - CollabAgentNode.STOP_TIMEOUT - 1,
                },
              },
            })
            .where(eq(CollabAgentTable.id, root.id))
            .run(),
        )

        await CollabRecovery.reconcile()

        expect(CollabAgentNode.load(root.id).spec.metadata?.stopReady).toBe(true)
        await expect(node({ name: "late-child", parent: root.id, root: root.id, activeParent: true })).rejects.toThrow(
          "is not active",
        )
      },
    })
  })
})
