import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "@/storage/schema.sql"
import { SessionTable } from "./session.sql"

export const SessionOwnershipTable = sqliteTable("session_ownership", {
  session_id: text()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  owner: text().$type<"human" | "collab">().notNull(),
  token: text().notNull(),
  expires_at: integer().notNull(),
  ...Timestamps,
})
