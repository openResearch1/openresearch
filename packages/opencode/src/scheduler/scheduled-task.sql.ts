import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

import { CollabAgentTable } from "@/collab/collab.sql"
import { Timestamps } from "@/storage/schema.sql"

export const scheduledTaskStatuses = ["pending", "fired", "canceled"] as const

export const ScheduledTaskTable = sqliteTable(
  "scheduled_task",
  {
    id: text().primaryKey(),
    agent_id: text()
      .notNull()
      .references(() => CollabAgentTable.id, { onDelete: "cascade" }),
    status: text().$type<(typeof scheduledTaskStatuses)[number]>().notNull().default("pending"),
    mode: text().$type<"direct" | "collab">().notNull(),
    run_id: text(),
    due_at: integer().notNull(),
    prompt: text().notNull(),
    callback_message_id: text(),
    fired_at: integer(),
    canceled_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("scheduled_task_due_idx").on(table.status, table.due_at),
    index("scheduled_task_agent_idx").on(table.agent_id, table.status),
  ],
)
