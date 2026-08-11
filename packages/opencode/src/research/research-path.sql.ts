import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

import { Timestamps } from "@/storage/schema.sql"
import { AtomTable, ResearchProjectTable } from "./research.sql"

export const researchPathStatuses = ["active", "completed", "cancelled"] as const
export const researchPathAtomRoles = ["seed", "member"] as const

export const ResearchPathTable = sqliteTable(
  "research_path",
  {
    research_path_id: text().primaryKey(),
    research_project_id: text()
      .notNull()
      .references(() => ResearchProjectTable.research_project_id, { onDelete: "cascade" }),
    creator_session_id: text().notNull(),
    title: text().notNull(),
    brief: text().notNull(),
    summary: text(),
    status: text().$type<(typeof researchPathStatuses)[number]>().notNull().default("active"),
    ...Timestamps,
  },
  (table) => [
    index("research_path_project_status_idx").on(table.research_project_id, table.status),
    index("research_path_creator_session_idx").on(table.creator_session_id),
  ],
)

export const ResearchPathAtomTable = sqliteTable(
  "research_path_atom",
  {
    research_path_id: text()
      .notNull()
      .references(() => ResearchPathTable.research_path_id, { onDelete: "cascade" }),
    atom_id: text()
      .notNull()
      .references(() => AtomTable.atom_id, { onDelete: "cascade" }),
    role: text().$type<(typeof researchPathAtomRoles)[number]>().notNull().default("member"),
  },
  (table) => [
    primaryKey({ columns: [table.research_path_id, table.atom_id] }),
    index("research_path_atom_atom_idx").on(table.atom_id),
  ],
)
