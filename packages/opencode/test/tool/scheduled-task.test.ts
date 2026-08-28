import { describe, expect, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { Collab } from "../../src/collab"
import { CollabAgentNode } from "../../src/collab/agent-node"
import { CollabAutoWake } from "../../src/collab/auto-wake"
import { CollabMessage } from "../../src/collab/message"
import { ScheduledTask } from "../../src/scheduler/scheduled-task"
import type { Tool } from "../../src/tool/tool"
import { ScheduledTaskCancelTool, ScheduledTaskCreateTool, ScheduledTaskListTool } from "../../src/tool/scheduled-task"
import { tmpdir } from "../fixture/fixture"

function context(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: "message-1",
    agent: "experiment",
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask() {},
  }
}

describe("tool.scheduled-task", () => {
  test("creates, lists, and cancels a direct scheduled task", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "scheduled task" })
        const ctx = context(session.id)
        const create = await ScheduledTaskCreateTool.init()
        const dueAt = new Date(Date.now() + 60_000).toISOString()
        const created = await create.execute({ dueAt, prompt: "Analyze the latest metrics." }, ctx)

        expect(created.output).toContain("You may continue with other work")
        expect(created.output).not.toContain("END YOUR TURN")
        expect(created.metadata.mode).toBe("direct")
        expect(created.metadata.dueAt).toBe(dueAt)

        const list = await ScheduledTaskListTool.init()
        const pending = await list.execute({}, ctx)
        expect(pending.metadata.tasks).toHaveLength(1)
        expect(pending.metadata.tasks[0]?.scheduledTaskId).toBe(created.metadata.scheduledTaskId)

        const cancel = await ScheduledTaskCancelTool.init()
        const canceled = await cancel.execute({ scheduledTaskId: created.metadata.scheduledTaskId }, ctx)
        expect(canceled.metadata.status).toBe("canceled")
        expect((await list.execute({}, ctx)).metadata.tasks).toHaveLength(0)
        expect((await list.execute({ status: "canceled" }, ctx)).metadata.tasks).toHaveLength(1)
      },
    })
  })

  test("requires a future ISO timestamp with an explicit timezone", async () => {
    const create = await ScheduledTaskCreateTool.init()
    const ctx = context("unused")
    await expect(create.execute({ dueAt: "2026-08-28T15:30:00", prompt: "Analyze metrics." }, ctx)).rejects.toThrow(
      "explicit timezone",
    )
    await expect(
      create.execute({ dueAt: new Date(Date.now() - 1000).toISOString(), prompt: "Analyze metrics." }, ctx),
    ).rejects.toThrow("must be in the future")
  })

  test("fires one durable direct callback", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        CollabAutoWake.setEnabled(false)
        try {
          const session = await Session.create({ title: "direct scheduled callback" })
          const ctx = context(session.id)
          const create = await ScheduledTaskCreateTool.init()
          const at = Date.now() + 60_000
          const created = await create.execute(
            { dueAt: new Date(at).toISOString(), prompt: "Analyze the latest metrics." },
            ctx,
          )

          await ScheduledTask.fireDue(at + 1)
          await ScheduledTask.fireDue(at + 1)

          const task = ScheduledTask.get(created.metadata.scheduledTaskId)
          const node = Collab.getBySession(session.id)!
          const messages = CollabMessage.list(node.id, { kind: "session_scheduled_task_due" })
          expect(task?.status).toBe("fired")
          expect(messages).toHaveLength(1)
          expect(messages[0].payload_json).toMatchObject({
            scheduledTaskId: created.metadata.scheduledTaskId,
            dueAt: at,
            prompt: "Analyze the latest metrics.",
          })
        } finally {
          CollabAutoWake.setEnabled(true)
        }
      },
    })
  })

  test("wakes an idle direct session when the task becomes due", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        CollabAutoWake.ensure()
        CollabAutoWake.setEnabled(true)
        let turns = 0
        CollabAutoWake.setDriveTurnOverrideForTesting(async (agentId) => {
          turns++
          CollabMessage.drain(agentId, "direct")
        })
        try {
          const session = await Session.create({ title: "scheduled wake" })
          const create = await ScheduledTaskCreateTool.init()
          const at = Date.now() + 60_000
          const created = await create.execute(
            { dueAt: new Date(at).toISOString(), prompt: "Analyze the latest metrics." },
            context(session.id),
          )

          await ScheduledTask.fireDue(at + 1)
          for (let i = 0; i < 100 && turns === 0; i++) await Bun.sleep(10)

          const node = Collab.getBySession(session.id)!
          expect(turns).toBe(1)
          expect(CollabMessage.list(node.id, { kind: "session_scheduled_task_due" })[0]?.status).toBe("consumed")
          expect(ScheduledTask.get(created.metadata.scheduledTaskId)?.status).toBe("fired")
        } finally {
          CollabAutoWake.setDriveTurnOverrideForTesting(undefined)
        }
      },
    })
  })

  test("keeps a collab run active and routes its due callback to that run", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        CollabAutoWake.setEnabled(false)
        try {
          const rootSession = await Session.create({ title: "scheduled root" })
          const root = Identifier.ascending("collab_agent")
          CollabAgentNode.create({
            id: root,
            sessionId: rootSession.id,
            name: "root",
            projectId: Instance.project.id,
            rootAgentId: root,
            subagentType: "general",
            spec: { initialPrompt: "root" },
          })
          const session = await Session.create({ parentID: rootSession.id, title: "scheduled child" })
          const id = Identifier.ascending("collab_agent")
          const child = CollabAgentNode.create({
            id,
            sessionId: session.id,
            parentAgentId: root,
            name: "child",
            projectId: Instance.project.id,
            rootAgentId: root,
            subagentType: "general",
            spec: { initialPrompt: "child" },
          })
          const create = await ScheduledTaskCreateTool.init()
          const at = Date.now() + 60_000
          const created = await create.execute(
            { dueAt: new Date(at).toISOString(), prompt: "Review the running experiment." },
            context(session.id),
          )

          expect(created.metadata.mode).toBe("collab")
          expect(ScheduledTask.has(child.id, "collab")).toBeTruthy()
          expect(Collab.workflowAsyncState(session.id).hasRemoteTaskListeners).toBe(true)

          await ScheduledTask.fireDue(at + 1)

          const messages = CollabMessage.list(child.id, { kind: "scheduled_task_due" })
          expect(messages).toHaveLength(1)
          expect(messages[0].run_id).toBe(child.run_id)
          expect(ScheduledTask.has(child.id, "collab")).toBeFalsy()
        } finally {
          CollabAutoWake.setEnabled(true)
        }
      },
    })
  })
})
