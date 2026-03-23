import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "@/storage/schema.sql"

const atomKinds = (["fact", "method", "theorem", "verification"] as const)
const proofKinds = ["math", "experiment"] as const
const proofSteps = ["pending", "in_progress", "done"] as const
const linkKinds = ["motivates", "formalizes", "derives", "analyzes", "validates", "contradicts", "other"] as const

export const ResearchProjectTable = sqliteTable(
  "research_project",
  {
    research_project_id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    background_path: text(),
    goal_path: text(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("research_project_project_idx").on(table.project_id)],
)

export const ExperimentTable = sqliteTable("experiment", {
  exp_id: text().primaryKey(),
  code_info: text({ mode: "json" }).$type<{
    code_path?: string
    code_branch?: string
    start_tree_hash?: string
    repo_url?: string
  }>(),
  result: text({ mode: "json" }).$type<{
    datasets?: string[]
    baselines?: string[]
    metrics?: Record<string, number | string>
    table?: unknown
    notes?: string
  }>(),
  status: text().$type<"pending" | "running" | "done" | "failed">().notNull().default("pending"),
  started_at: integer(),
  finished_at: integer(),
  ...Timestamps,
})

export const AtomTable = sqliteTable(
  "atom",
  {
    atom_id: text().primaryKey(),
    research_project_id: text()
      .notNull()
      .references(() => ResearchProjectTable.research_project_id, { onDelete: "cascade" }),
    atom_name: text().notNull(),
    atom_type: text().$type<(typeof atomKinds)[number]>().notNull(),
    atom_content_path: text(),
    atom_proof_type: text().$type<(typeof proofKinds)[number]>().notNull(),
    atom_proof_plan_path: text(),
    atom_proof_status: text().$type<(typeof proofSteps)[number]>().notNull().default("pending"),
    atom_proof_result_path: text(),
    article_id: text().references(() => ArticleTable.article_id, { onDelete: "set null" }),
    exp_id: text().references(() => ExperimentTable.exp_id, { onDelete: "set null" }),
    session_id: text().references(() => SessionTable.id, { onDelete: "set null" }),
    ...Timestamps,
  },
  (table) => [
    index("atom_research_project_idx").on(table.research_project_id),
    index("atom_exp_idx").on(table.exp_id),
    index("atom_session_idx").on(table.session_id),
  ],
)

export const AtomRelationTable = sqliteTable(
  "atom_relation",
  {
    atom_id_source: text()
      .notNull()
      .references(() => AtomTable.atom_id, { onDelete: "cascade" }),
    atom_id_target: text()
      .notNull()
      .references(() => AtomTable.atom_id, { onDelete: "cascade" }),
    relation_type: text().$type<(typeof linkKinds)[number]>().notNull(),
    note: text(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.atom_id_source, table.atom_id_target, table.relation_type] }),
    index("atom_relation_target_idx").on(table.atom_id_target),
  ],
)

export const ArticleTable = sqliteTable(
  "article",
  {
    article_id: text().primaryKey(),
    research_project_id: text()
      .notNull()
      .references(() => ResearchProjectTable.research_project_id, { onDelete: "cascade" }),
    path: text().notNull(),
    code_path: text(),
    title: text(),
    source_url: text(),
    status: text().$type<"pending" | "parsed" | "failed">().notNull().default("pending"),
    ...Timestamps,
  },
  (table) => [index("article_research_project_idx").on(table.research_project_id)],
)
