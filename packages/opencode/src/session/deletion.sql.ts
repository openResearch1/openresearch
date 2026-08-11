import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "@/storage/schema.sql"
import { SessionTable } from "./session.sql"

export const SessionDeletionTable = sqliteTable("session_deletion", {
  session_id: text()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  ...Timestamps,
})
