import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { AgentInfoSchema, CollabAgentPhaseSchema, CollabAgentStatusSchema, CollabMsgKindSchema } from "./types"

export namespace CollabEvent {
  export const AgentCreated = BusEvent.define(
    "collab.agent.created",
    z.object({
      info: AgentInfoSchema,
    }),
  )

  export const AgentStatus = BusEvent.define(
    "collab.agent.status",
    z.object({
      agentId: z.string(),
      rootAgentId: z.string(),
      status: CollabAgentStatusSchema,
      phase: CollabAgentPhaseSchema,
      active_children: z.number().int().nonnegative(),
    }),
  )

  export const AgentCompleted = BusEvent.define(
    "collab.agent.completed",
    z.object({
      agentId: z.string(),
      rootAgentId: z.string(),
      summary: z.string().optional(),
    }),
  )

  export const AgentFailed = BusEvent.define(
    "collab.agent.failed",
    z.object({
      agentId: z.string(),
      rootAgentId: z.string(),
      code: z.string(),
      message: z.string(),
    }),
  )

  export const MessagePosted = BusEvent.define(
    "collab.message.posted",
    z.object({
      messageId: z.string(),
      recipientAgentId: z.string(),
      senderAgentId: z.string().nullable(),
      kind: CollabMsgKindSchema,
    }),
  )

  export const MessageConsumed = BusEvent.define(
    "collab.message.consumed",
    z.object({
      messageId: z.string(),
      recipientAgentId: z.string(),
      kind: CollabMsgKindSchema,
    }),
  )

  /**
   * Fired each time CollabAutoWake finishes a drive cycle for a root agent
   * and releases its inflight lock. External waiters (e.g.
   * Collab.waitForRootSettled from the `task` tool) subscribe to this to
   * re-check their settled condition — the usual AgentStatus / Idle
   * triggers all fire WHILE inflight is still held, so they get filtered
   * out, and there'd otherwise be no signal after the lock releases.
   */
  export const RootDriveEnded = BusEvent.define(
    "collab.root.drive_ended",
    z.object({
      sessionID: z.string(),
      rootAgentId: z.string(),
    }),
  )
}
