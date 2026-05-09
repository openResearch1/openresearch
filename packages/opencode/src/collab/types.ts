import z from "zod"
import { collabAgentPhases, collabAgentStatuses, collabMsgKinds } from "./collab.sql"

export const CollabAgentStatusSchema = z.enum(collabAgentStatuses)
export type CollabAgentStatus = z.infer<typeof CollabAgentStatusSchema>

export const CollabAgentPhaseSchema = z.enum(collabAgentPhases)
export type CollabAgentPhase = z.infer<typeof CollabAgentPhaseSchema>

export const CollabMsgKindSchema = z.enum(collabMsgKinds)
export type CollabMsgKind = z.infer<typeof CollabMsgKindSchema>

export const WAKE_MESSAGE_KINDS: readonly CollabMsgKind[] = [
  "child_done",
  "child_failed",
  "child_waiting",
  "cancel",
  "user_input",
]

export const ProgressInjectionSchema = z.enum(["none", "latest", "all"])
export type ProgressInjection = z.infer<typeof ProgressInjectionSchema>

export const OnFailSchema = z.enum(["fail_fast", "continue", "retry_once"])
export type OnFail = z.infer<typeof OnFailSchema>

export const AgentPolicySchema = z
  .object({
    on_fail: OnFailSchema.default("fail_fast").optional(),
    timeout_ms: z.number().int().positive().optional(),
    maxChildren: z.number().int().positive().optional(),
    progress_injection: ProgressInjectionSchema.default("latest").optional(),
    summarize: z.boolean().optional(),
  })
  .meta({ ref: "CollabAgentPolicy" })
export type AgentPolicy = z.infer<typeof AgentPolicySchema>

export const AgentSpecSchema = z
  .object({
    initialPrompt: z.string(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    policy: AgentPolicySchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ ref: "CollabAgentSpec" })
export type AgentSpec = z.infer<typeof AgentSpecSchema>

export const AgentResultSchema = z
  .object({
    summary: z.string().optional(),
    result: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ ref: "CollabAgentResult" })
export type AgentResult = z.infer<typeof AgentResultSchema>

export const AgentErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    detail: z.string().optional(),
  })
  .meta({ ref: "CollabAgentError" })
export type AgentError = z.infer<typeof AgentErrorSchema>

export const ChildDonePayloadSchema = z.object({
  childAgentId: z.string(),
  childName: z.string(),
  summary: z.string(),
  result: z.record(z.string(), z.unknown()).optional(),
})
export type ChildDonePayload = z.infer<typeof ChildDonePayloadSchema>

export const ChildFailedPayloadSchema = z.object({
  childAgentId: z.string(),
  childName: z.string(),
  reason: z.enum(["error", "canceled", "timeout"]),
  message: z.string(),
  detail: z.string().optional(),
})
export type ChildFailedPayload = z.infer<typeof ChildFailedPayloadSchema>

export const ChildWaitingPayloadSchema = z.object({
  childAgentId: z.string(),
  childName: z.string(),
  childSessionId: z.string(),
  workflowInstanceId: z.string().optional(),
  waitMessageId: z.string().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
})
export type ChildWaitingPayload = z.infer<typeof ChildWaitingPayloadSchema>

export const ChildProgressPayloadSchema = z.object({
  childAgentId: z.string(),
  childName: z.string(),
  turn: z.number().int().nonnegative(),
  assistant_text: z.string(),
  tools: z
    .array(
      z.object({
        name: z.string(),
        ok: z.boolean(),
      }),
    )
    .default([]),
})
export type ChildProgressPayload = z.infer<typeof ChildProgressPayloadSchema>

export const CancelPayloadSchema = z.object({
  reason: z.string(),
  initiator: z.enum(["parent", "user", "system", "sibling"]),
})
export type CancelPayload = z.infer<typeof CancelPayloadSchema>

export const UserInputPayloadSchema = z.object({
  text: z.string(),
  messageId: z.string().optional(),
})
export type UserInputPayload = z.infer<typeof UserInputPayloadSchema>

export const SystemPayloadSchema = z.object({
  event: z.enum(["timeout", "retry", "resource_reclaim"]),
  detail: z.string().optional(),
})
export type SystemPayload = z.infer<typeof SystemPayloadSchema>

export type CollabPayload =
  | { kind: "child_done"; data: ChildDonePayload }
  | { kind: "child_failed"; data: ChildFailedPayload }
  | { kind: "child_waiting"; data: ChildWaitingPayload }
  | { kind: "child_progress"; data: ChildProgressPayload }
  | { kind: "cancel"; data: CancelPayload }
  | { kind: "user_input"; data: UserInputPayload }
  | { kind: "system"; data: SystemPayload }

export const AgentInfoSchema = z
  .object({
    id: z.string(),
    session_id: z.string(),
    parent_agent_id: z.string().nullable(),
    name: z.string(),
    project_id: z.string(),
    root_agent_id: z.string(),
    subagent_type: z.string(),
    status: CollabAgentStatusSchema,
    phase: CollabAgentPhaseSchema,
    spec: AgentSpecSchema,
    result: AgentResultSchema.nullable(),
    error: AgentErrorSchema.nullable(),
    active_children: z.number().int().nonnegative(),
    spawned_total: z.number().int().nonnegative(),
    time_created: z.number(),
    time_updated: z.number(),
    time_started: z.number().nullable(),
    time_ended: z.number().nullable(),
  })
  .meta({ ref: "CollabAgent" })
export type AgentInfo = z.infer<typeof AgentInfoSchema>

export const MessageInfoSchema = z
  .object({
    id: z.string(),
    recipient_agent_id: z.string(),
    sender_agent_id: z.string().nullable(),
    kind: CollabMsgKindSchema,
    payload: z.unknown(),
    status: z.enum(["pending", "consumed", "dropped"]),
    time_created: z.number(),
    time_updated: z.number(),
    time_consumed: z.number().nullable(),
  })
  .meta({ ref: "CollabMessage" })
export type MessageInfo = z.infer<typeof MessageInfoSchema>
