import { sql } from "drizzle-orm"
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "@/storage/schema.sql"
import { SessionTable } from "../session/session.sql"
import { ProjectTable } from "../project/project.sql"

export const collabAgentStatuses = [
  "idle",
  "pending",
  "running",
  "blocked_on_children",
  "waiting_interaction",
  "completed",
  "failed",
  "canceled",
] as const
export type CollabAgentStatus = (typeof collabAgentStatuses)[number]

export const collabAgentPhases = ["main_loop", "awaiting_children", "draining"] as const
export type CollabAgentPhase = (typeof collabAgentPhases)[number]

export const collabMsgKinds = [
  "child_done",
  "child_failed",
  "child_waiting",
  "child_progress",
  "remote_task_terminal",
  "session_remote_task_terminal",
  "cancel",
  "user_input",
  "system",
] as const
export type CollabMsgKind = (typeof collabMsgKinds)[number]

export const collabMsgStatuses = ["pending", "processing", "consumed", "dropped"] as const
export type CollabMsgStatus = (typeof collabMsgStatuses)[number]

type AgentSpecData = {
  initialPrompt: string
  model?: { providerID: string; modelID: string }
  policy?: {
    on_fail?: "fail_fast" | "continue" | "retry_once"
    timeout_ms?: number
    maxChildren?: number
    progress_injection?: "none" | "latest" | "all"
    summarize?: boolean
    detach_on_terminal?: boolean
  }
  metadata?: Record<string, unknown>
}

type AgentResultData = {
  summary?: string
  result?: Record<string, unknown>
}

type AgentErrorData = {
  code: string
  message: string
  detail?: string
}

export const CollabAgentTable = sqliteTable(
  "collab_agent",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_agent_id: text(),
    name: text().notNull(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    root_agent_id: text().notNull(),
    run_id: text(),
    initiator: text().$type<"human" | "agent">(),
    subagent_type: text().notNull(),
    status: text().$type<CollabAgentStatus>().notNull(),
    phase: text().$type<CollabAgentPhase>().notNull(),
    spec_json: text({ mode: "json" }).$type<AgentSpecData>().notNull(),
    result_json: text({ mode: "json" }).$type<AgentResultData>(),
    error_json: text({ mode: "json" }).$type<AgentErrorData>(),
    active_children: integer().notNull().default(0),
    spawned_total: integer().notNull().default(0),
    ...Timestamps,
    time_started: integer(),
    time_ended: integer(),
  },
  (t) => [
    index("collab_agent_session_idx").on(t.session_id),
    index("collab_agent_parent_idx").on(t.parent_agent_id),
    index("collab_agent_root_idx").on(t.root_agent_id),
    index("collab_agent_project_status_idx").on(t.project_id, t.status),
  ],
)

export const CollabMessageTable = sqliteTable(
  "collab_message",
  {
    id: text().primaryKey(),
    recipient_agent_id: text()
      .notNull()
      .references(() => CollabAgentTable.id, { onDelete: "cascade" }),
    sender_agent_id: text(),
    run_id: text(),
    kind: text().$type<CollabMsgKind>().notNull(),
    payload_json: text({ mode: "json" }).notNull(),
    status: text().$type<CollabMsgStatus>().notNull(),
    claim_id: text(),
    ...Timestamps,
    time_consumed: integer(),
  },
  (t) => [
    index("collab_msg_recipient_pending_idx").on(t.recipient_agent_id, t.status, t.id),
    uniqueIndex("collab_msg_terminal_run_idx")
      .on(t.recipient_agent_id, t.sender_agent_id, t.run_id)
      .where(sql`${t.run_id} is not null and ${t.kind} in ('child_done', 'child_failed')`),
  ],
)
