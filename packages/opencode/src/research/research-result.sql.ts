import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

import { Timestamps } from "@/storage/schema.sql"
import { ResearchProjectTable } from "./research.sql"

export type ResearchResultAtom = {
  atom_id: string
  atom_name: string
}

export const ResearchResultTable = sqliteTable(
  "research_result",
  {
    research_result_id: text().primaryKey(),
    research_project_id: text()
      .notNull()
      .references(() => ResearchProjectTable.research_project_id, { onDelete: "cascade" }),
    source_session_id: text().notNull(),
    reviewer_session_id: text().notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    evaluation: text().notNull(),
    atoms_json: text({ mode: "json" }).$type<ResearchResultAtom[]>().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("research_result_project_idx").on(table.research_project_id),
    uniqueIndex("research_result_reviewer_session_idx").on(table.reviewer_session_id),
  ],
)
