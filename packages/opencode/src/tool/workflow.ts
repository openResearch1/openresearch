import z from "zod"
import { Tool } from "./tool"
import { Workflow } from "@/workflow"
import { WorkflowTemplates } from "@/workflow/templates"
import DESCRIPTION from "./workflow.txt"

function latestUserMessageID(messages: Tool.Context["messages"]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]?.info
    if (msg?.role !== "user") continue
    return msg.id
  }
}

const action = z
  .object({
    action: z
      .enum(["start", "inspect", "next", "edit", "wait_interaction", "fail"])
      .describe("Workflow action to execute."),
    template_id: z.string().optional().describe("Template id to start, for example simple_test_v1."),
    flow: z
      .string()
      .optional()
      .describe("Optional predefined flow id within the template, for example default or rerun_only."),
    input: z.record(z.string(), z.unknown()).optional().describe("Optional initial workflow context object."),
    instance_id: z.string().optional().describe("Workflow instance id returned by start, for example wf_..."),
    result: z.record(z.string(), z.unknown()).optional().describe("Optional result object for the current step."),
    context_patch: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Optional context fields to merge into workflow context."),
    ops: z
      .array(Workflow.EditOp)
      .optional()
      .describe(
        "Array of edit operations. Must be an actual array, not a string. Insert operations must reference predefined step kinds, for example [{ type: 'insert_after_current', kinds: ['setup_env_retry', 'run_experiment_retry'] }] or [{ type: 'delete_future', step_ids: ['wfs_...'] }].",
      ),
    reason: z.string().optional().describe("Optional machine-readable waiting reason."),
    message: z.string().optional().describe("Optional user-facing message explaining what input is needed."),
    code: z.string().optional().describe("Machine-readable failure code for fail action."),
    detail: z.string().optional().describe("Optional detailed failure explanation for the user."),
  })
  .superRefine((value, ctx) => {
    if (value.action === "start") {
      if (!value.template_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["template_id"],
          message: "template_id is required for start",
        })
      }
      return
    }

    if (!value.instance_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instance_id"], message: "instance_id is required" })
    }

    if (value.action === "edit" && !value.ops) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ops"], message: "ops is required for edit" })
    }

    if (value.action === "fail") {
      if (!value.code) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["code"], message: "code is required for fail" })
      }
      if (!value.message) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["message"], message: "message is required for fail" })
      }
    }
  })

function title(meta: Workflow.Meta) {
  const step = meta.instance.current_step
  if (meta.action === "wait_interaction") return `Waiting in ${step?.title ?? meta.instance.title}`
  if (meta.action === "fail") return `Failed ${step?.title ?? meta.instance.title}`
  if (meta.action === "next") return `Advanced to ${step?.title ?? meta.instance.flow_title ?? "completed"}`
  if (meta.action === "edit") return `Updated workflow steps`
  if (meta.action === "inspect") return `Inspected ${meta.instance.title}`
  return `Started ${meta.instance.title}`
}

function format(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2)
}

function steps(meta: Workflow.Meta) {
  return meta.instance.steps.map((step) => `- ${step.id} | ${step.kind} | ${step.status}`).join("\n")
}

function policy(meta: Workflow.Meta) {
  const step = meta.instance.current_step
  if (!step) return
  return [
    "Step policy:",
    `- next allowed: yes`,
    `- next conditions: ${step.policy.can_next.length ? "" : "none"}`,
    ...(step.policy.can_next.length ? step.policy.can_next.map((item) => `  - ${item}`) : []),
    `- wait_interaction allowed: ${step.policy.can_wait_interaction ? "yes" : "no"}`,
    `- edit_future allowed: ${step.policy.can_edit_future ? "yes" : "no"}`,
    `- allowed edit ops: ${step.policy.allowed_edit_ops.length ? "" : "none"}`,
    ...(step.policy.allowed_edit_ops.length ? step.policy.allowed_edit_ops.map((item) => `  - ${item}`) : []),
  ].join("\n")
}

async function docs(meta: Workflow.Meta) {
  return {
    flow: WorkflowTemplates.flow(meta.instance.template_id, meta.instance.flow_id),
    summary: await WorkflowTemplates.summary(meta.instance.template_id, meta.instance.flow_id),
    prompt: meta.instance.current_step
      ? await WorkflowTemplates.prompt(meta.instance.template_id, meta.instance.current_step.prompt)
      : undefined,
  }
}

async function output(meta: Workflow.Meta, content: Awaited<ReturnType<typeof docs>>) {
  const step = meta.instance.current_step
  const state = [
    "Workflow state:",
    `- instance_id: ${meta.instance.id}`,
    `- template_id: ${meta.instance.template_id}`,
    `- flow_id: ${meta.instance.flow_id}`,
    `- flow_title: ${meta.instance.flow_title}`,
    `- status: ${meta.instance.status}`,
    `- current_index: ${meta.instance.current_index}`,
    `- current_step_id: ${step?.id ?? ""}`,
    `- current_step_kind: ${step?.kind ?? ""}`,
    `- current_step_title: ${step?.title ?? ""}`,
    `- current_step_status: ${step?.status ?? ""}`,
    "",
    "Current step summary:",
    step?.summary ?? "",
    "",
    step ? "Current step instructions:" : "Flow summary:",
    step ? (content.prompt ?? "No step prompt found.") : (content.summary ?? "No flow summary found."),
    ...(step ? ["", policy(meta) ?? ""] : []),
    "",
    "Context:",
    format(meta.instance.context),
    "",
    "Steps:",
    steps(meta),
  ].join("\n")

  if (meta.action === "start") {
    return `Workflow ${meta.instance.title} started on flow '${content.flow?.title ?? meta.instance.flow_id}'. Review the flow summary before entering the first step.\n\n${state}`
  }
  if (meta.action === "next") {
    return meta.instance.status === "completed"
      ? `Workflow ${meta.instance.title} is completed.\n\n${state}`
      : meta.instance.current_index === 0
        ? `Workflow entered the first step.\n\n${state}`
        : `Workflow advanced to the next step.\n\n${state}`
  }
  if (meta.action === "edit") {
    const add = meta.diff?.inserted?.length ?? 0
    const del = meta.diff?.deleted?.length ?? 0
    return [`Updated future workflow steps.`, `- inserted: ${add}`, `- deleted: ${del}`, "", state].join("\n")
  }
  if (meta.action === "wait_interaction") {
    return `Workflow is waiting for user input.\n\n${state}`
  }
  if (meta.action === "fail") {
    const reason = step?.result
      ? [
          `Failure code: ${String(step.result.code ?? "WORKFLOW_FAILED")}`,
          `Failure message: ${String(step.result.message ?? "Workflow failed.")}`,
          step.result.detail ? `Failure detail: ${String(step.result.detail)}` : undefined,
          "",
        ]
          .filter(Boolean)
          .join("\n")
      : ""
    return `${reason}${reason ? "\n" : ""}Workflow failed and stopped.\n\n${state}`
  }
  return `Workflow inspected.\n\n${state}`
}

export const WorkflowTool = Tool.define("workflow", {
  description: DESCRIPTION,
  parameters: action,
  async execute(params, ctx) {
    try {
      const meta =
        params.action === "start"
          ? Workflow.start({
              sessionID: ctx.sessionID,
              templateID: params.template_id!,
              flowID: params.flow,
              context: params.input,
            })
          : params.action === "inspect"
            ? Workflow.inspect({
                sessionID: ctx.sessionID,
                instanceID: params.instance_id!,
              })
            : params.action === "next"
              ? Workflow.next({
                  sessionID: ctx.sessionID,
                  instanceID: params.instance_id!,
                  result: params.result,
                  context: params.context_patch,
                })
              : params.action === "edit"
                ? Workflow.edit({
                    sessionID: ctx.sessionID,
                    instanceID: params.instance_id!,
                    ops: params.ops!,
                  })
                : params.action === "fail"
                  ? Workflow.fail({
                      sessionID: ctx.sessionID,
                      instanceID: params.instance_id!,
                      code: params.code!,
                      message: params.message!,
                      detail: params.detail,
                      context: params.context_patch,
                    })
                  : params.action === "wait_interaction"
                    ? Workflow.wait({
                        sessionID: ctx.sessionID,
                        instanceID: params.instance_id!,
                        userMessageID: latestUserMessageID(ctx.messages),
                        reason: params.reason,
                        message: params.message,
                      })
                    : undefined

      if (!meta) {
        throw new globalThis.Error("INVALID_WORKFLOW_ACTION: Workflow action is not supported.")
      }

      const content = await docs(meta)

      return {
        title: title(meta),
        output: await output(meta, content),
        metadata: {
          ...meta,
          flow_summary: content.summary,
          instance_id: meta.instance.id,
          truncated: false,
        },
      }
    } catch (err) {
      if (err instanceof Workflow.Error) {
        throw new globalThis.Error(`${err.code}: ${err.message}`)
      }
      throw err
    }
  },
})
