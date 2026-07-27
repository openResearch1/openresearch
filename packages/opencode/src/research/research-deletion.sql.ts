import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "@/storage/schema.sql"

export const ResearchDeletionTable = sqliteTable(
  "research_deletion",
  {
    kind: text().$type<"atom" | "experiment">().notNull(),
    entity_id: text().notNull(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.kind, table.entity_id] })],
)
