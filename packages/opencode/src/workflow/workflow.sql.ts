import { sqliteTable, text, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "@/session/session.sql"
import { Timestamps } from "@/storage/schema.sql"

type StepStatus = "pending" | "active" | "done" | "waiting_interaction" | "skipped"
type InstanceStatus = "running" | "waiting_interaction" | "completed" | "failed" | "cancelled"

type StepData = {
  id: string
  kind: string
  title: string
  summary: string
  prompt: string
  policy: {
    can_next: string[]
    can_wait_interaction: boolean
    can_edit_future: boolean
    allowed_edit_ops: Array<"insert" | "delete">
  }
  status: StepStatus
  result?: Record<string, unknown>
  interaction?: {
    reason?: string
    message?: string
    last_user_message?: string
    wait_after_user_message_id?: string
    resumed_user_message_id?: string
  }
}

export const WorkflowInstanceTable = sqliteTable(
  "workflow_instance",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    template_id: text().notNull(),
    flow_id: text().notNull(),
    template_version: text().notNull(),
    title: text().notNull(),
    status: text().$type<InstanceStatus>().notNull(),
    current_index: text().notNull(),
    steps_json: text({ mode: "json" }).$type<StepData[]>().notNull(),
    context_json: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("workflow_instance_session_idx").on(table.session_id),
    index("workflow_instance_status_idx").on(table.status),
    index("workflow_instance_template_idx").on(table.template_id),
  ],
)
