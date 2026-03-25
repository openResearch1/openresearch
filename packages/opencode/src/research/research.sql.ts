import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "@/storage/schema.sql"

const atomKinds = ["fact", "method", "theorem", "verification"] as const
const evidenceKinds = ["math", "experiment"] as const
const evidenceSteps = ["pending", "in_progress", "proven", "disproven"] as const
export const linkKinds = [
  "motivates",
  "formalizes",
  "derives",
  "analyzes",
  "validates",
  "contradicts",
  "other",
] as const

export const RemoteServerTable = sqliteTable("remote_server", {
  id: text().primaryKey(),
  config: text().notNull(),
  ...Timestamps,
})

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

export const ExperimentTable = sqliteTable(
  "experiment",
  {
    exp_id: text().primaryKey(),
    research_project_id: text()
      .notNull()
      .references(() => ResearchProjectTable.research_project_id, { onDelete: "cascade" }),
    exp_session_id: text().references(() => SessionTable.id, { onDelete: "set null" }),
    baseline_branch_name: text(),
    exp_branch_name: text(),
    exp_result_path: text(),
    atom_id: text().references(() => AtomTable.atom_id, { onDelete: "set null" }),
    exp_result_summary_path: text(),
    exp_plan_path: text(),
    remote_server_id: text().references(() => RemoteServerTable.id, { onDelete: "set null" }),
    code_path: text().notNull(),
    status: text().$type<"pending" | "running" | "done" | "idle" | "failed">().notNull().default("pending"),
    started_at: integer(),
    finished_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("experiment_research_project_idx").on(table.research_project_id),
    index("experiment_session_idx").on(table.exp_session_id),
    index("experiment_atom_idx").on(table.atom_id),
  ],
)

export const AtomTable = sqliteTable(
  "atom",
  {
    atom_id: text().primaryKey(),
    research_project_id: text()
      .notNull()
      .references(() => ResearchProjectTable.research_project_id, { onDelete: "cascade" }),
    atom_name: text().notNull(),
    atom_type: text().$type<(typeof atomKinds)[number]>().notNull(),
    atom_claim_path: text(),
    atom_evidence_type: text().$type<(typeof evidenceKinds)[number]>().notNull(),
    atom_evidence_status: text().$type<(typeof evidenceSteps)[number]>().notNull().default("pending"),
    atom_evidence_path: text(),
    atom_evidence_assessment_path: text(),
    article_id: text().references(() => ArticleTable.article_id, { onDelete: "set null" }),
    session_id: text().references(() => SessionTable.id, { onDelete: "set null" }),
    ...Timestamps,
  },
  (table) => [
    index("atom_research_project_idx").on(table.research_project_id),
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

const watchStatuses = ["pending", "running", "finished", "failed", "crashed"] as const

export const ExperimentWatchTable = sqliteTable(
  "experiment_watch",
  {
    watch_id: text().primaryKey(),
    exp_id: text()
      .notNull()
      .references(() => ExperimentTable.exp_id, { onDelete: "cascade" }),
    wandb_entity: text().notNull(),
    wandb_project: text().notNull(),
    wandb_api_key: text().notNull(),
    wandb_run_id: text().notNull(),
    status: text().$type<(typeof watchStatuses)[number]>().notNull().default("pending"),
    last_polled_at: integer(),
    wandb_state: text(),
    error_message: text(),
    ...Timestamps,
  },
  (table) => [
    index("experiment_watch_exp_idx").on(table.exp_id),
    index("experiment_watch_status_idx").on(table.status),
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
