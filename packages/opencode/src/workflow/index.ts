import { ulid } from "ulid"
import z from "zod"
import { and, asc, eq, inArray, Database } from "@/storage/db"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { WorkflowSchema } from "./schema"
import { WorkflowTemplates } from "./templates"
import { WorkflowInstanceTable } from "./workflow.sql"

export namespace Workflow {
  export const Policy = WorkflowSchema.Policy

  export const Step = z
    .object({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      summary: z.string(),
      prompt: z.string(),
      policy: Policy,
      status: z.enum(["pending", "active", "done", "waiting_interaction", "skipped"]),
      result: z.record(z.string(), z.unknown()).optional(),
      interaction: z
        .object({
          reason: z.string().optional(),
          message: z.string().optional(),
          last_user_message: z.string().optional(),
          wait_after_user_message_id: z.string().optional(),
          resumed_user_message_id: z.string().optional(),
        })
        .optional(),
    })
    .meta({ ref: "WorkflowStep" })
  export type Step = z.infer<typeof Step>

  export const Instance = z
    .object({
      id: z.string(),
      session_id: z.string(),
      template_id: z.string(),
      flow_id: z.string(),
      template_version: z.string(),
      title: z.string(),
      status: z.enum(["running", "waiting_interaction", "completed", "failed", "cancelled"]),
      current_index: z.number().int().min(-1),
      steps: z.array(Step),
      context: z.record(z.string(), z.unknown()),
      created_at: z.number(),
      updated_at: z.number(),
    })
    .meta({ ref: "WorkflowInstance" })
  export type Instance = z.infer<typeof Instance>

  export const EditOp = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("insert_after_current"),
      kinds: z
        .array(z.string())
        .describe("Array of predefined step kinds to insert immediately after the current step."),
    }),
    z.object({
      type: z.literal("delete_future"),
      step_ids: z.array(z.string()).describe("Array of future step ids to delete."),
    }),
  ])
  export type EditOp = z.infer<typeof EditOp>

  export const Meta = z
    .object({
      action: z.enum(["start", "next", "edit", "wait_interaction", "fail", "inspect"]),
      instance: z.object({
        id: z.string(),
        template_id: z.string(),
        flow_id: z.string(),
        flow_title: z.string(),
        title: z.string(),
        status: z.enum(["running", "waiting_interaction", "completed", "failed", "cancelled"]),
        current_index: z.number(),
        context: z.record(z.string(), z.unknown()),
        current_step: z
          .object({
            id: z.string(),
            kind: z.string(),
            title: z.string(),
            summary: z.string(),
            prompt: z.string(),
            policy: Policy,
            status: z.enum(["pending", "active", "done", "waiting_interaction", "skipped"]),
            result: z.record(z.string(), z.unknown()).optional(),
            interaction: z
              .object({
                reason: z.string().optional(),
                message: z.string().optional(),
                last_user_message: z.string().optional(),
                wait_after_user_message_id: z.string().optional(),
                resumed_user_message_id: z.string().optional(),
              })
              .optional(),
          })
          .optional(),
        steps: z.array(
          z.object({
            id: z.string(),
            kind: z.string(),
            title: z.string(),
            summary: z.string(),
            status: z.enum(["pending", "active", "done", "waiting_interaction", "skipped"]),
            result: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      }),
      diff: z
        .object({
          inserted: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
          deleted: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .meta({ ref: "WorkflowMetadata" })
  export type Meta = z.infer<typeof Meta>

  export const Event = {
    Updated: BusEvent.define(
      "workflow.updated",
      z.object({
        sessionID: z.string(),
        workflow: Meta,
      }),
    ),
  }

  export class Error extends globalThis.Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  function raise(code: string, message: string): never {
    throw new Error(code, message)
  }

  function parseIndex(value: string) {
    return Number.parseInt(value, 10)
  }

  function now() {
    return Date.now()
  }

  function stepID() {
    return `wfs_${ulid()}`
  }

  function instanceID() {
    return `wf_${ulid()}`
  }

  function fromRow(row: typeof WorkflowInstanceTable.$inferSelect): Instance {
    return {
      id: row.id,
      session_id: row.session_id,
      template_id: row.template_id,
      flow_id: row.flow_id,
      template_version: row.template_version,
      title: row.title,
      status: row.status,
      current_index: parseIndex(row.current_index),
      steps: row.steps_json,
      context: row.context_json,
      created_at: row.time_created,
      updated_at: row.time_updated,
    }
  }

  function current(inst: Instance) {
    if (inst.current_index < 0) return
    return inst.steps[inst.current_index]
  }

  export function summary(inst: Instance): Meta["instance"] {
    const step = current(inst)
    return {
      id: inst.id,
      template_id: inst.template_id,
      flow_id: inst.flow_id,
      flow_title: WorkflowTemplates.flow(inst.template_id, inst.flow_id)?.title ?? inst.flow_id,
      title: inst.title,
      status: inst.status,
      current_index: inst.current_index,
      context: inst.context,
      current_step: step
        ? {
            id: step.id,
            kind: step.kind,
            title: step.title,
            summary: step.summary,
            prompt: step.prompt,
            policy: step.policy,
            status: step.status,
            result: step.result,
            interaction: step.interaction,
          }
        : undefined,
      steps: inst.steps.map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        summary: item.summary,
        status: item.status,
        result: item.result,
      })),
    }
  }

  function failInstance(
    inst: Instance,
    input: { code: string; message: string; detail?: string; context?: Record<string, unknown> },
  ) {
    const step = current(inst)
    inst.status = "failed"
    inst.context = patch(inst.context, input.context)
    if (step) {
      step.result = {
        status: "failed",
        code: input.code,
        message: input.message,
        detail: input.detail,
      }
    }
    write(inst)
    publish("fail", inst)
    return build("fail", inst)
  }

  function guard(inst: Instance) {
    const counts = new Map<string, number>()
    for (const step of inst.steps) {
      const count = (counts.get(step.kind) ?? 0) + 1
      counts.set(step.kind, count)
      if (count > 3) {
        return failInstance(inst, {
          code: "STEP_KIND_LIMIT_EXCEEDED",
          message: `The workflow was stopped automatically because the same recovery step ('${step.kind}') was repeated too many times. Please review the current issue and decide how to proceed.`,
          detail:
            "To avoid getting stuck in a retry loop, the system stops the workflow after the same kind of step appears more than three times. Manual review is now required.",
        })
      }
    }
  }

  function build(action: Meta["action"], inst: Instance, input?: { diff?: Meta["diff"] }): Meta {
    return {
      action,
      instance: summary(inst),
      diff: input?.diff,
    }
  }

  function publish(action: Meta["action"], inst: Instance, diff?: Meta["diff"]) {
    Bus.publish(Event.Updated, {
      sessionID: inst.session_id,
      workflow: { action, instance: summary(inst), diff },
    })
  }

  function getPath(ctx: Record<string, unknown>, key: string): unknown {
    return key.split(".").reduce<unknown>((acc, part) => {
      if (!acc || typeof acc !== "object") return undefined
      return (acc as Record<string, unknown>)[part]
    }, ctx)
  }

  function checkAtom(ctx: Record<string, unknown>, raw: string) {
    const expr = raw.trim()
    if (!expr) return true

    const ops = ["!= null", "== null", "== true", "== false", "!= true", "!= false"] as const
    for (const op of ops) {
      if (!expr.includes(op)) continue
      const [left] = expr.split(op)
      const val = getPath(ctx, left.trim())
      if (op === "!= null") return val !== null && val !== undefined
      if (op === "== null") return val === null || val === undefined
      if (op === "== true") return val === true
      if (op === "== false") return val === false
      if (op === "!= true") return val !== true
      return val !== false
    }

    return !!getPath(ctx, expr)
  }

  function checkAll(ctx: Record<string, unknown>, list: string[]) {
    return list.every((item) => item.split("||").some((part) => checkAtom(ctx, part)))
  }

  function patch(base: Record<string, unknown>, diff?: Record<string, unknown>) {
    if (!diff) return base
    return {
      ...base,
      ...diff,
    }
  }

  function draft(step: WorkflowSchema.Step): Step {
    return {
      id: stepID(),
      kind: step.kind,
      title: step.title,
      summary: step.summary ?? step.title,
      prompt: step.prompt,
      policy: step.policy ?? {
        can_next: [],
        can_wait_interaction: false,
        can_edit_future: false,
        allowed_edit_ops: [],
      },
      status: "pending",
    }
  }

  function resolve(templateID: string, kind: string) {
    const step = WorkflowTemplates.step(templateID, kind)
    if (!step) raise("STEP_KIND_NOT_FOUND", `Workflow step kind not found in template: ${kind}`)
    return step
  }

  function write(inst: Instance) {
    Database.use((db) =>
      db
        .update(WorkflowInstanceTable)
        .set({
          status: inst.status,
          current_index: String(inst.current_index),
          steps_json: inst.steps,
          context_json: inst.context,
          title: inst.title,
          template_id: inst.template_id,
          flow_id: inst.flow_id,
          template_version: inst.template_version,
          session_id: inst.session_id,
          time_updated: now(),
        })
        .where(eq(WorkflowInstanceTable.id, inst.id))
        .run(),
    )
  }

  function create(input: {
    sessionID: string
    template: WorkflowSchema.Template
    flowID: string
    context?: Record<string, unknown>
  }) {
    const ts = now()
    const flow = WorkflowTemplates.flow(input.template.id, input.flowID)
    if (!flow) raise("FLOW_NOT_FOUND", `Workflow flow not found in template: ${input.flowID}`)
    const steps = flow.steps.map((kind) => {
      const item = resolve(input.template.id, kind)
      return {
        ...draft(item),
        status: "pending",
      }
    }) satisfies Step[]

    const inst: Instance = {
      id: instanceID(),
      session_id: input.sessionID,
      template_id: input.template.id,
      flow_id: input.flowID,
      template_version: input.template.version,
      title: input.template.name,
      status: steps.length ? "running" : "completed",
      current_index: steps.length ? -1 : 0,
      steps,
      context: input.context ?? {},
      created_at: ts,
      updated_at: ts,
    }

    Database.use((db) =>
      db
        .insert(WorkflowInstanceTable)
        .values({
          id: inst.id,
          session_id: inst.session_id,
          template_id: inst.template_id,
          flow_id: inst.flow_id,
          template_version: inst.template_version,
          title: inst.title,
          status: inst.status,
          current_index: String(inst.current_index),
          steps_json: inst.steps,
          context_json: inst.context,
          time_created: ts,
          time_updated: ts,
        })
        .run(),
    )

    return inst
  }

  function load(id: string) {
    const row = Database.use((db) =>
      db.select().from(WorkflowInstanceTable).where(eq(WorkflowInstanceTable.id, id)).get(),
    )
    if (!row) raise("INSTANCE_NOT_FOUND", `Workflow instance not found: ${id}`)
    return fromRow(row)
  }

  function owns(inst: Instance, sessionID: string) {
    if (inst.session_id !== sessionID) raise("INSTANCE_NOT_FOUND", `Workflow instance not found: ${inst.id}`)
  }

  export function active(sessionID: string) {
    const row = Database.use((db) =>
      db
        .select()
        .from(WorkflowInstanceTable)
        .where(
          and(
            eq(WorkflowInstanceTable.session_id, sessionID),
            inArray(WorkflowInstanceTable.status, ["running", "waiting_interaction"]),
          ),
        )
        .orderBy(asc(WorkflowInstanceTable.time_created))
        .get(),
    )
    return row ? fromRow(row) : undefined
  }

  export function latest(sessionID: string) {
    const rows = Database.use((db) =>
      db
        .select()
        .from(WorkflowInstanceTable)
        .where(eq(WorkflowInstanceTable.session_id, sessionID))
        .orderBy(asc(WorkflowInstanceTable.time_updated), asc(WorkflowInstanceTable.time_created))
        .all(),
    )
    const row = rows.at(-1)
    return row ? fromRow(row) : undefined
  }

  export function start(input: {
    sessionID: string
    templateID: string
    flowID?: string
    context?: Record<string, unknown>
  }) {
    if (active(input.sessionID)) {
      raise("ACTIVE_WORKFLOW_ALREADY_EXISTS", "Current session already has an active workflow instance.")
    }
    const template = WorkflowTemplates.get(input.templateID)
    if (!template) raise("TEMPLATE_NOT_FOUND", `Workflow template not found: ${input.templateID}`)
    const flowID = input.flowID ?? template.default_flow
    if (!WorkflowTemplates.flow(input.templateID, flowID)) {
      raise("FLOW_NOT_FOUND", `Workflow flow not found in template: ${flowID}`)
    }
    const inst = create({
      sessionID: input.sessionID,
      template,
      flowID,
      context: input.context,
    })
    publish("start", inst)
    return build("start", inst)
  }

  export function inspect(input: { sessionID: string; instanceID: string }) {
    const inst = load(input.instanceID)
    owns(inst, input.sessionID)
    return build("inspect", inst)
  }

  export function next(input: {
    sessionID: string
    instanceID: string
    result?: Record<string, unknown>
    context?: Record<string, unknown>
  }) {
    const inst = load(input.instanceID)
    owns(inst, input.sessionID)
    if (inst.status !== "running") raise("INVALID_WORKFLOW_STATE", "Workflow is not in running state.")
    if (inst.current_index < 0) {
      const first = inst.steps[0]
      if (!first) {
        inst.status = "completed"
        write(inst)
        publish("next", inst)
        return build("next", inst)
      }
      inst.current_index = 0
      first.status = "active"
      inst.context = patch(inst.context, input.context)
      write(inst)
      publish("next", inst)
      return build("next", inst)
    }
    const step = current(inst)
    if (!step || step.status !== "active") raise("NEXT_NOT_ALLOWED", "Current step is not active.")
    if (!checkAll(patch(inst.context, input.context), step.policy.can_next)) {
      raise("NEXT_NOT_ALLOWED", "Current step does not satisfy next conditions.")
    }

    step.status = "done"
    if (input.result) step.result = input.result
    inst.context = patch(inst.context, input.context)

    const next = inst.steps[inst.current_index + 1]
    if (!next) {
      inst.status = "completed"
    } else {
      inst.current_index += 1
      next.status = "active"
    }

    write(inst)
    publish("next", inst)
    return build("next", inst)
  }

  export function edit(input: { sessionID: string; instanceID: string; ops: EditOp[] }) {
    const inst = load(input.instanceID)
    owns(inst, input.sessionID)
    if (inst.status !== "running") raise("INVALID_WORKFLOW_STATE", "Workflow is not in running state.")
    const step = current(inst)
    if (!step || step.status !== "active") raise("EDIT_NOT_ALLOWED", "Current step cannot edit future steps.")
    if (!step.policy.can_edit_future) raise("EDIT_NOT_ALLOWED", "Current step cannot edit future steps.")

    const inserted: Array<{ id: string; title: string }> = []
    const deleted: string[] = []

    for (const op of input.ops) {
      if (op.type === "insert_after_current") {
        if (!step.policy.allowed_edit_ops.includes("insert")) raise("EDIT_NOT_ALLOWED", "Insert is not allowed.")
        const items = op.kinds.map((kind) => draft(resolve(inst.template_id, kind)))
        inst.steps.splice(inst.current_index + 1, 0, ...items)
        inserted.push(...items.map((item) => ({ id: item.id, title: item.title })))
        continue
      }

      if (!step.policy.allowed_edit_ops.includes("delete")) raise("EDIT_NOT_ALLOWED", "Delete is not allowed.")
      const future = new Set(inst.steps.slice(inst.current_index + 1).map((item) => item.id))
      for (const id of op.step_ids) {
        if (!future.has(id)) raise("EDIT_NOT_ALLOWED", `Future step not found: ${id}`)
      }
      inst.steps = inst.steps.filter((item, idx) => {
        if (idx <= inst.current_index) return true
        if (!op.step_ids.includes(item.id)) return true
        deleted.push(item.id)
        return false
      })
    }

    const blocked = guard(inst)
    if (blocked) return blocked

    const diff = {
      inserted: inserted.length ? inserted : undefined,
      deleted: deleted.length ? deleted : undefined,
    }
    write(inst)
    publish("edit", inst, diff)
    return build("edit", inst, { diff })
  }

  export function wait(input: {
    sessionID: string
    instanceID: string
    userMessageID?: string
    reason?: string
    message?: string
  }) {
    const inst = load(input.instanceID)
    owns(inst, input.sessionID)
    if (inst.status !== "running") raise("WAIT_INTERACTION_NOT_ALLOWED", "Workflow is not in running state.")
    const step = current(inst)
    if (!step || step.status !== "active" || !step.policy.can_wait_interaction) {
      raise("WAIT_INTERACTION_NOT_ALLOWED", "Current step cannot enter waiting_interaction state.")
    }

    inst.status = "waiting_interaction"
    step.status = "waiting_interaction"
    step.interaction = {
      ...step.interaction,
      reason: input.reason,
      message: input.message,
      wait_after_user_message_id: input.userMessageID,
      resumed_user_message_id: undefined,
    }

    write(inst)
    publish("wait_interaction", inst)
    return build("wait_interaction", inst)
  }

  export function autoResume(input: { sessionID: string; userMessageID: string; userMessage: string }) {
    const inst = active(input.sessionID)
    if (!inst || inst.status !== "waiting_interaction") return
    if (inst.status !== "waiting_interaction") {
      return
    }
    const step = current(inst)
    if (!step || step.status !== "waiting_interaction") {
      return
    }
    if (step.interaction?.wait_after_user_message_id === input.userMessageID) {
      return
    }
    if (step.interaction?.resumed_user_message_id === input.userMessageID) {
      return
    }

    inst.status = "running"
    step.status = "active"
    step.interaction = {
      ...step.interaction,
      last_user_message: input.userMessage,
      resumed_user_message_id: input.userMessageID,
    }

    write(inst)
  }

  export function fail(input: {
    sessionID: string
    instanceID: string
    code: string
    message: string
    detail?: string
    context?: Record<string, unknown>
  }) {
    const inst = load(input.instanceID)
    owns(inst, input.sessionID)
    if (!["running", "waiting_interaction"].includes(inst.status)) {
      raise("INVALID_WORKFLOW_STATE", "Workflow cannot be failed from its current state.")
    }
    return failInstance(inst, input)
  }
}
