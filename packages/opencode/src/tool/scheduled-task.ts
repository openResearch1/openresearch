import z from "zod"

import { Collab } from "@/collab"
import { ScheduledTask } from "@/scheduler/scheduled-task"

import { Tool } from "./tool"

const zone = /(?:Z|[+-]\d{2}:\d{2})$/

async function agent(ctx: Tool.Context) {
  return Collab.ensureRootFromSession(ctx.sessionID, {
    name: "root",
    subagentType: ctx.agent,
    spec: { initialPrompt: "" },
  })
}

function due(value: string) {
  if (!zone.test(value)) throw new Error("dueAt must be an ISO 8601 timestamp with an explicit timezone")
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw new Error("dueAt must be a valid ISO 8601 timestamp")
  if (time <= Date.now()) throw new Error("dueAt must be in the future")
  return time
}

export const ScheduledTaskCreateTool = Tool.define("scheduled_task_create", {
  description:
    "Create a durable one-shot task that wakes this agent at a future wall-clock time. This does not wait for remote task completion.",
  parameters: z.object({
    dueAt: z
      .string()
      .describe("Future ISO 8601 timestamp with an explicit timezone, for example 2026-08-28T15:30:00+08:00."),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(8192)
      .describe("Actionable instruction to deliver to the agent when the task is due."),
  }),
  async execute(params, ctx) {
    const time = due(params.dueAt)
    const recipient = await agent(ctx)
    const task = ScheduledTask.create({ agentId: recipient.id, dueAt: time, prompt: params.prompt })
    const at = new Date(task.due_at).toISOString()
    ctx.metadata({
      title: `Scheduled task: ${at}`,
      metadata: {
        scheduledTaskId: task.id,
        dueAt: at,
        prompt: task.prompt,
        status: task.status,
        mode: task.mode,
        recipientAgentId: task.agent_id,
      },
    })
    return {
      title: `Scheduled task: ${at}`,
      output: [
        `Scheduled task ID: ${task.id}`,
        `Due at: ${at}`,
        `Prompt: ${task.prompt}`,
        "",
        "You may continue with other work. No polling or sleeping is required.",
        "The framework will deliver this prompt and resume the session when the task is due.",
      ].join("\n"),
      metadata: {
        scheduledTaskId: task.id,
        dueAt: at,
        prompt: task.prompt,
        status: task.status,
        mode: task.mode,
        recipientAgentId: task.agent_id,
      },
    }
  },
})

export const ScheduledTaskListTool = Tool.define("scheduled_task_list", {
  description: "List scheduled tasks created by this agent, ordered by due time.",
  parameters: z.object({
    status: z.enum(["pending", "fired", "canceled", "all"]).optional().describe("Defaults to pending tasks."),
  }),
  async execute(params, ctx) {
    const recipient = await agent(ctx)
    const status = params.status ?? "pending"
    const tasks = ScheduledTask.list(recipient.id, status === "all" ? undefined : status)
    return {
      title: "Scheduled tasks",
      output: tasks.length
        ? tasks
            .map((task) =>
              [
                `Scheduled task ID: ${task.id}`,
                `Due at: ${new Date(task.due_at).toISOString()}`,
                `Status: ${task.status}`,
                `Prompt: ${task.prompt}`,
              ].join("\n"),
            )
            .join("\n\n")
        : `No ${status === "all" ? "" : `${status} `}scheduled tasks found.`,
      metadata: {
        status,
        tasks: tasks.map((task) => ({
          scheduledTaskId: task.id,
          dueAt: new Date(task.due_at).toISOString(),
          prompt: task.prompt,
          status: task.status,
          mode: task.mode,
        })),
      },
    }
  },
})

export const ScheduledTaskCancelTool = Tool.define("scheduled_task_cancel", {
  description: "Cancel a pending scheduled task created by this agent.",
  parameters: z.object({
    scheduledTaskId: z.string().describe("Scheduled task ID returned by scheduled_task_create or scheduled_task_list."),
  }),
  async execute(params, ctx) {
    const recipient = await agent(ctx)
    const task = ScheduledTask.cancel({ id: params.scheduledTaskId, agentId: recipient.id })
    if (!task) throw new Error(`scheduled task changed while being canceled: ${params.scheduledTaskId}`)
    return {
      title: "Scheduled task canceled",
      output: [`Scheduled task ID: ${task.id}`, `Status: ${task.status}`].join("\n"),
      metadata: {
        scheduledTaskId: task.id,
        dueAt: new Date(task.due_at).toISOString(),
        prompt: task.prompt,
        status: task.status,
      },
    }
  },
})
