import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { CollabAgentTable } from "@/collab/collab.sql"
import { Timestamps } from "@/storage/schema.sql"
import { RemoteTaskTable } from "./research.sql"

export const RemoteTaskListenerTable = sqliteTable(
  "remote_task_listener",
  {
    task_id: text()
      .notNull()
      .references(() => RemoteTaskTable.task_id, { onDelete: "cascade" }),
    agent_id: text()
      .notNull()
      .references(() => CollabAgentTable.id, { onDelete: "cascade" }),
    mode: text().$type<"direct" | "collab">().notNull().default("collab"),
    run_id: text(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.task_id, table.agent_id] }),
    index("remote_task_listener_agent_idx").on(table.agent_id),
  ],
)
