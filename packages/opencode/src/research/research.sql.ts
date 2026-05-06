import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "@/storage/schema.sql"

const atomKinds = ["fact", "method", "theorem", "verification"] as const
const evidenceKinds = ["math", "experiment"] as const
const evidenceSteps = ["pending", "in_progress", "proven", "disproven"] as const
const experimentKinds = ["experiment", "project_runtime"] as const
const runtimeStatuses = ["pending", "preparing", "downloading", "ready", "stale", "failed"] as const
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
    macro_table_path: text(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("research_project_project_idx").on(table.project_id)],
)

export const ExperimentTable = sqliteTable(
  "experiment",
  {
    exp_id: text().primaryKey(),
    kind: text().$type<(typeof experimentKinds)[number]>().notNull().default("experiment"),
    runtime_key: text(),
    research_project_id: text()
      .notNull()
      .references(() => ResearchProjectTable.research_project_id, { onDelete: "cascade" }),
    exp_name: text().notNull(),
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
    uniqueIndex("experiment_runtime_key_idx").on(table.runtime_key),
  ],
)

export const ProjectRuntimeEnvironmentTable = sqliteTable(
  "project_runtime_environment",
  {
    env_id: text().primaryKey(),
    research_project_id: text()
      .notNull()
      .references(() => ResearchProjectTable.research_project_id, { onDelete: "cascade" }),
    remote_server_id: text()
      .notNull()
      .references(() => RemoteServerTable.id, { onDelete: "cascade" }),
    runtime_exp_id: text()
      .notNull()
      .references(() => ExperimentTable.exp_id, { onDelete: "cascade" }),
    env_key: text().notNull(),
    conda_env_name: text().notNull(),
    python_version: text(),
    spec: text(),
    fingerprint: text(),
    status: text().$type<(typeof runtimeStatuses)[number]>().notNull().default("pending"),
    last_verified_at: integer(),
    error_message: text(),
    ...Timestamps,
  },
  (table) => [
    index("project_runtime_env_project_idx").on(table.research_project_id),
    index("project_runtime_env_server_idx").on(table.remote_server_id),
    index("project_runtime_env_runtime_exp_idx").on(table.runtime_exp_id),
    uniqueIndex("project_runtime_env_key_idx").on(table.research_project_id, table.remote_server_id, table.env_key),
  ],
)

export const ProjectRuntimeResourceTable = sqliteTable(
  "project_runtime_resource",
  {
    resource_id: text().primaryKey(),
    research_project_id: text()
      .notNull()
      .references(() => ResearchProjectTable.research_project_id, { onDelete: "cascade" }),
    remote_server_id: text()
      .notNull()
      .references(() => RemoteServerTable.id, { onDelete: "cascade" }),
    runtime_exp_id: text()
      .notNull()
      .references(() => ExperimentTable.exp_id, { onDelete: "cascade" }),
    resource_key: text().notNull(),
    type: text().$type<"dataset" | "model" | "checkpoint" | "artifact">().notNull(),
    source: text(),
    target_path: text().notNull(),
    verify: text(),
    fingerprint: text(),
    status: text().$type<(typeof runtimeStatuses)[number]>().notNull().default("pending"),
    last_verified_at: integer(),
    error_message: text(),
    ...Timestamps,
  },
  (table) => [
    index("project_runtime_resource_project_idx").on(table.research_project_id),
    index("project_runtime_resource_server_idx").on(table.remote_server_id),
    index("project_runtime_resource_runtime_exp_idx").on(table.runtime_exp_id),
    uniqueIndex("project_runtime_resource_key_idx").on(
      table.research_project_id,
      table.remote_server_id,
      table.resource_key,
    ),
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

const watchStatuses = ["pending", "running", "finished", "failed", "crashed", "canceled"] as const
const executionStatuses = ["pending", "running", "finished", "failed", "canceled"] as const
const executionStages = [
  "pending",
  "planning",
  "coding",
  "deploying_code",
  "setting_up_env",
  "remote_downloading",
  "verifying_resources",
  "running_experiment",
  "watching_wandb",
] as const
const remoteTaskKinds = ["resource_download", "experiment_run", "env_setup"] as const
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

export const ExperimentExecutionWatchTable = sqliteTable(
  "experiment_execution_watch",
  {
    watch_id: text().primaryKey(),
    exp_id: text()
      .notNull()
      .references(() => ExperimentTable.exp_id, { onDelete: "cascade" }),
    status: text().$type<(typeof executionStatuses)[number]>().notNull().default("pending"),
    stage: text().$type<(typeof executionStages)[number]>().notNull().default("planning"),
    title: text().notNull(),
    message: text(),
    wandb_entity: text(),
    wandb_project: text(),
    wandb_run_id: text(),
    error_message: text(),
    started_at: integer(),
    finished_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("experiment_execution_watch_exp_idx").on(table.exp_id),
    index("experiment_execution_watch_status_idx").on(table.status),
  ],
)

export const RemoteTaskTable = sqliteTable(
  "remote_task",
  {
    task_id: text().primaryKey(),
    exp_id: text()
      .notNull()
      .references(() => ExperimentTable.exp_id, { onDelete: "cascade" }),
    kind: text().$type<(typeof remoteTaskKinds)[number]>().notNull(),
    resource_key: text(),
    title: text().notNull(),
    status: text().$type<(typeof watchStatuses)[number]>().notNull().default("pending"),
    server: text().notNull(),
    remote_root: text().notNull(),
    target_path: text(),
    screen_name: text().notNull(),
    command: text().notNull(),
    pid: integer(),
    log_path: text(),
    source_selection: text(),
    method: text(),
    error_message: text(),
    last_polled_at: integer(),
    stopped_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("remote_task_exp_idx").on(table.exp_id),
    index("remote_task_status_idx").on(table.status),
    uniqueIndex("remote_task_exp_kind_resource_idx").on(table.exp_id, table.kind, table.resource_key),
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
    title: text(),
    source_url: text(),
    status: text().$type<"pending" | "parsed" | "failed">().notNull().default("pending"),
    ...Timestamps,
  },
  (table) => [index("article_research_project_idx").on(table.research_project_id)],
)

export const CodeTable = sqliteTable(
  "code",
  {
    code_id: text().primaryKey(),
    research_project_id: text()
      .notNull()
      .references(() => ResearchProjectTable.research_project_id, { onDelete: "cascade" }),
    code_name: text().notNull(),
    article_id: text().references(() => ArticleTable.article_id, { onDelete: "set null" }),
    ...Timestamps,
  },
  (table) => [
    index("code_research_project_idx").on(table.research_project_id),
    index("code_article_idx").on(table.article_id),
  ],
)
