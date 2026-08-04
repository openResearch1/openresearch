import { describe, expect, test } from "bun:test"

import { Bus } from "../../src/bus"
import { Collab } from "../../src/collab"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { CollabEvent } from "../../src/collab/events"
import { CollabLoop } from "../../src/collab/loop"
import { CollabMessage } from "../../src/collab/message"
import { CollabSupervisor } from "../../src/collab/supervisor"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

async function node(input: {
  name: string
  parent?: string
  root?: string
  initiator?: "human" | "agent"
  status?: "pending" | "running" | "blocked_on_children" | "waiting_interaction" | "idle" | "completed" | "failed" | "canceled"
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
    spec: { initialPrompt: input.name },
    status: input.status ?? "running",
    initiator: input.initiator,
    activeParent: input.activeParent,
    parentGeneration: input.parentGeneration,
  })
}

function cancels(id: string) {
  return CollabMessage.list(id, { kind: "cancel", limit: 1000 })
}

describe("Collab cancel propagation", () => {
  test("deduplicates cancel messages for one lifecycle and permits a later run", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await node({ name: "root" })
        const child = await node({ name: "child", parent: root.id, root: root.id })
        const first = CollabMessage.post({
          recipientAgentId: child.id,
          runId: child.run_id,
          kind: "cancel",
          payload: { reason: "first", initiator: "user" },
        })
        const duplicate = CollabMessage.post({
          recipientAgentId: child.id,
          runId: child.run_id,
          kind: "cancel",
          payload: { reason: "second", initiator: "parent" },
        })

        expect(duplicate).toBe(first)
        expect(cancels(child.id)).toHaveLength(1)
        expect(cancels(child.id)[0].payload_json).toMatchObject({ reason: "first", initiator: "user" })

        CollabMessage.drop(CollabMessage.drain(child.id))
        CollabAgentNode.finish({
          id: child.id,
          runId: child.run_id,
          parentId: root.id,
          status: "canceled",
          phase: "main_loop",
          error: { code: "CANCELED", message: "first" },
          timeEnded: Date.now(),
        })
        const active = CollabAgentNode.activate(child.id)
        expect(active.run_id).not.toBe(child.run_id)

        const next = CollabMessage.post({
          recipientAgentId: active.id,
          runId: active.run_id,
          kind: "cancel",
          payload: { reason: "new run", initiator: "user" },
        })
        expect(next).not.toBe(first)
        expect(cancels(child.id)).toHaveLength(2)
      },
    })
  })

  test("keeps a deep cancellation cascade linear under retries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const nodes = [await node({ name: "node-0" })]
        for (let i = 1; i < 24; i++) {
          nodes.push(await node({ name: `node-${i}`, parent: nodes[i - 1].id, root: nodes[0].id }))
        }

        await Collab.cancel(nodes[0].id, "stop")
        for (const item of nodes.slice(0, -1)) {
          CollabSupervisor.cancelChildren(item.id, { reason: "stop", initiator: "parent" })
          CollabSupervisor.cancelChildren(item.id, { reason: "duplicate", initiator: "parent" })
        }

        expect(nodes.flatMap((item) => cancels(item.id))).toHaveLength(nodes.length)
        for (const item of nodes) expect(cancels(item.id)).toHaveLength(1)
      },
    })
  })

  test("does not duplicate child cancellation after processing retry", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await node({ name: "retry-root" })
        const child = await node({ name: "retry-child", parent: root.id, root: root.id })
        CollabMessage.post({
          recipientAgentId: root.id,
          kind: "cancel",
          payload: { reason: "stop", initiator: "user" },
        })
        const first = CollabMessage.drain(root.id)
        expect(first).toHaveLength(1)

        CollabSupervisor.cancelChildren(root.id, { reason: "stop", initiator: "parent" })
        CollabMessage.retry(first, false)
        const second = CollabMessage.drain(root.id)
        CollabSupervisor.cancelChildren(root.id, { reason: "stop again", initiator: "parent" })

        expect(second[0].id).toBe(first[0].id)
        expect(cancels(child.id)).toHaveLength(1)
      },
    })
  })

  test("rejects a stale cancellation without touching the current run", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await node({ name: "stale-root" })
        const child = await node({ name: "stale-child", parent: root.id, root: root.id })
        const run = child.run_id
        CollabMessage.post({
          recipientAgentId: child.id,
          runId: run,
          kind: "cancel",
          payload: { reason: "old", initiator: "user" },
        })
        CollabMessage.drop(CollabMessage.drain(child.id))
        CollabAgentNode.finish({
          id: child.id,
          runId: run,
          parentId: root.id,
          status: "canceled",
          phase: "main_loop",
          error: { code: "CANCELED", message: "old" },
          timeEnded: Date.now(),
        })
        const active = CollabAgentNode.activate(child.id)
        const grandchild = await node({ name: "current-child", parent: active.id, root: root.id })

        await expect(
          Collab.cancel(active.id, "stale retry", { parentAgentId: root.id, runId: run }),
        ).rejects.toThrow("ownership changed")
        expect(CollabAgentNode.load(active.id).status).toBe("running")
        expect(cancels(grandchild.id)).toHaveLength(0)
      },
    })
  })

  test("uses a new cancel identity after a root lifecycle restarts", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await node({ name: "lifecycle-root" })
        const first = CollabMessage.post({
          recipientAgentId: root.id,
          kind: "cancel",
          payload: { reason: "first", initiator: "user" },
        })
        CollabMessage.drop(CollabMessage.drain(root.id))
        CollabAgentNode.transition(root.id, "canceled", { timeEnded: Date.now() })
        const active = CollabAgentNode.activate(root.id)
        const second = CollabMessage.post({
          recipientAgentId: active.id,
          kind: "cancel",
          payload: { reason: "second", initiator: "user" },
        })

        expect(second).not.toBe(first)
        expect(cancels(root.id)).toHaveLength(2)
      },
    })
  })

  test("rejects cancellation from a stale root lifecycle", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await node({ name: "stale-lifecycle-root" })
        const lifecycle = CollabAgentNode.lifecycle(root.spec)
        CollabAgentNode.transition(root.id, "canceled", { timeEnded: Date.now() })
        const active = CollabAgentNode.activate(root.id)

        await expect(
          Collab.cancel(active.id, "stale root cancel", {
            parentAgentId: null,
            runId: null,
            lifecycle,
          }),
        ).rejects.toThrow("ownership changed")
        expect(CollabAgentNode.load(root.id).status).toBe("running")
        expect(cancels(root.id)).toHaveLength(0)
      },
    })
  })

  test("requeues a dropped cancel for an active leaf", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await node({ name: "requeue-root" })
        const child = await node({ name: "requeue-child", parent: root.id, root: root.id })
        CollabMessage.post({
          recipientAgentId: child.id,
          runId: child.run_id,
          kind: "cancel",
          payload: { reason: "interrupted", initiator: "user" },
        })
        CollabMessage.drop(CollabMessage.drain(child.id))
        expect(cancels(child.id)[0].status).toBe("dropped")
        let posted = 0
        const off = Bus.subscribe(CollabEvent.MessagePosted, (event) => {
          if (event.properties.recipientAgentId === child.id && event.properties.kind === "cancel") posted++
        })

        try {
          await Collab.cancel(child.id, "retry")
        } finally {
          off()
        }

        expect(cancels(child.id)).toHaveLength(1)
        expect(cancels(child.id)[0].status).toBe("pending")
        expect(posted).toBe(1)
      },
    })
  })

  test("preserves root lifecycle metadata across spec updates", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await node({ name: "spec-root" })
        const lifecycle = CollabAgentNode.lifecycle(root.spec)
        const updated = CollabAgentNode.spec(root.id, {
          initialPrompt: "updated",
          metadata: { collabLifecycle: "stale" },
        })

        expect(CollabAgentNode.lifecycle(updated.spec)).toBe(lifecycle)
      },
    })
  })

  test("cancels a nested branch exactly once per agent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await node({ name: "branch-root" })
        const parent = await node({ name: "branch-parent", parent: root.id, root: root.id })
        const child = await node({ name: "branch-child", parent: parent.id, root: root.id })
        const grandchild = await node({ name: "branch-grandchild", parent: child.id, root: root.id })

        await Collab.cancel(parent.id, "stop branch")
        await CollabLoop.start(child.id)
        await CollabLoop.start(grandchild.id)
        await CollabLoop.start(child.id)
        await CollabLoop.start(parent.id)

        expect(CollabAgentNode.load(parent.id).status).toBe("canceled")
        expect(CollabAgentNode.load(child.id).status).toBe("canceled")
        expect(CollabAgentNode.load(grandchild.id).status).toBe("canceled")
        expect(cancels(parent.id)).toHaveLength(1)
        expect(cancels(child.id)).toHaveLength(1)
        expect(cancels(grandchild.id)).toHaveLength(1)
        expect(cancels(root.id)).toHaveLength(0)
      },
    })
  })

  test("stops at human and detached branch boundaries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await node({ name: "boundary-root" })
        const human = await node({ name: "human", parent: root.id, root: root.id, initiator: "human" })
        const humanChild = await node({ name: "human-child", parent: human.id, root: root.id })
        const detached = await node({ name: "detached", parent: root.id, root: root.id })
        const detachedChild = await node({ name: "detached-child", parent: detached.id, root: root.id })
        CollabAgentNode.detach(detached.id)

        await Collab.cancel(root.id, "stop root")

        expect(cancels(root.id)).toHaveLength(1)
        expect(cancels(human.id)).toHaveLength(0)
        expect(cancels(humanChild.id)).toHaveLength(0)
        expect(cancels(detached.id)).toHaveLength(0)
        expect(cancels(detachedChild.id)).toHaveLength(0)
      },
    })
  })

  test("rejects topology changes beneath a canceling parent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await node({ name: "terminating-parent" })
        const child = await node({ name: "terminal-child", parent: parent.id, root: parent.id })
        CollabAgentNode.transition(child.id, "canceled", { timeEnded: Date.now() })
        const independent = await node({ name: "independent" })
        CollabAgentNode.transition(parent.id, parent.status, {
          error: { code: "CANCELED", message: "terminating" },
        })

        await expect(
          node({
            name: "late-child",
            parent: parent.id,
            root: parent.id,
            activeParent: true,
            parentGeneration: CollabAgentNode.generation(parent.spec),
          }),
        ).rejects.toThrow("terminating")
        expect(() => CollabAgentNode.activate(child.id)).toThrow("not available")
        expect(() =>
          CollabAgentNode.attach({
            id: independent.id,
            parentId: parent.id,
            rootId: parent.id,
            name: independent.name,
            subagentType: independent.subagent_type,
            metadata: {},
          }),
        ).toThrow("not available")
        expect(() =>
          CollabAgentNode.lease({
            agentId: independent.id,
            parentAgentId: parent.id,
            prompt: "late lease",
          }),
        ).toThrow("terminating")
      },
    })
  })

  test("allows topology changes while a parent waits for a model", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await node({ name: "model-parent" })
        CollabAgentNode.transition(parent.id, "waiting_interaction", {
          error: { code: "MODEL_UNAVAILABLE", message: "choose a model" },
        })

        const child = await node({
          name: "model-child",
          parent: parent.id,
          root: parent.id,
          activeParent: true,
          parentGeneration: CollabAgentNode.generation(parent.spec),
        })
        expect(child.parent_agent_id).toBe(parent.id)
      },
    })
  })
})
