import { createMemo, For, Show, type Component } from "solid-js"
import stripAnsi from "strip-ansi"

import { useI18n } from "../context/i18n"
import { ToolCall } from "./basic-tool"
import { Markdown } from "./markdown"
import type { ToolComponent, ToolProps } from "./message-part"

type Data = Record<string, unknown>

type Family = "atom" | "experiment" | "runtime" | "agent" | "article" | "code" | "research" | "document"

type Spec = {
  family: Family
  title: string
  existing?: boolean
}

type Field = {
  label: string
  value: unknown
  mono?: boolean
}

type Item = {
  title: string
  subtitle?: string
  status?: string
  body?: string
}

type Document = {
  label: string
  value: string
}

const LIMIT = 50

const SPECS: Record<string, Spec> = {
  atom_create: { family: "atom", title: "ui.tool.research.atom.create" },
  atom_query: { family: "atom", title: "ui.tool.research.atom.query" },
  atom_status_update: { family: "atom", title: "ui.tool.research.atom.status" },
  atom_batch_create: { family: "atom", title: "ui.tool.research.atom.batchCreate" },
  atom_delete: { family: "atom", title: "ui.tool.research.atom.delete" },
  atom_relation_query: { family: "atom", title: "ui.tool.research.atom.relationQuery" },
  atom_relation_create: { family: "atom", title: "ui.tool.research.atom.relationCreate" },
  atom_relation_delete: { family: "atom", title: "ui.tool.research.atom.relationDelete" },
  atom_graph_prompt: { family: "atom", title: "ui.tool.research.atom.graph" },
  atom_graph_prompt_smart: { family: "atom", title: "ui.tool.research.atom.graphSmart" },
  delegate_atom: { family: "atom", title: "ui.tool.research.atom.delegate", existing: true },
  experiment_create: { family: "experiment", title: "ui.tool.research.experiment.create" },
  experiment_query: { family: "experiment", title: "ui.tool.research.experiment.query" },
  experiment_code_sync: { family: "experiment", title: "ui.tool.research.experiment.sync" },
  experiment_watch: { family: "experiment", title: "ui.tool.research.experiment.watch" },
  experiment_execution_watch_init: { family: "experiment", title: "ui.tool.research.experiment.progressInit" },
  experiment_execution_watch_update: { family: "experiment", title: "ui.tool.research.experiment.progressUpdate" },
  experiment_remote_task_start: {
    family: "experiment",
    title: "ui.tool.research.experiment.remoteStart",
    existing: true,
  },
  experiment_remote_task_get: {
    family: "experiment",
    title: "ui.tool.research.experiment.remoteGet",
    existing: true,
  },
  experiment_remote_task_list: { family: "experiment", title: "ui.tool.research.experiment.remoteList" },
  scheduled_task_create: { family: "agent", title: "ui.tool.research.scheduledTask.create" },
  scheduled_task_list: { family: "agent", title: "ui.tool.research.scheduledTask.list" },
  scheduled_task_cancel: { family: "agent", title: "ui.tool.research.scheduledTask.cancel" },
  project_runtime_server_query: { family: "runtime", title: "ui.tool.research.runtime.serverQuery" },
  project_runtime_env_spec_inspect: { family: "runtime", title: "ui.tool.research.runtime.specInspect" },
  project_runtime_ensure: { family: "runtime", title: "ui.tool.research.runtime.ensure" },
  project_runtime_env_query: { family: "runtime", title: "ui.tool.research.runtime.envQuery" },
  project_runtime_env_upsert: { family: "runtime", title: "ui.tool.research.runtime.envUpsert" },
  project_runtime_resource_query: { family: "runtime", title: "ui.tool.research.runtime.resourceQuery" },
  project_runtime_resource_upsert: { family: "runtime", title: "ui.tool.research.runtime.resourceUpsert" },
  list_children: { family: "agent", title: "ui.tool.research.agent.children" },
  article_query: { family: "article", title: "ui.tool.research.article.query" },
  article_status_update: { family: "article", title: "ui.tool.research.article.status" },
  research_code_query: { family: "code", title: "ui.tool.research.code.query" },
  research_code_branch_query: { family: "code", title: "ui.tool.research.code.branches" },
  research_background_edit: { family: "research", title: "ui.tool.research.project.background" },
  research_goal_edit: { family: "research", title: "ui.tool.research.project.goal" },
  research_macro_edit: { family: "research", title: "ui.tool.research.project.macro" },
  research_info: { family: "research", title: "ui.tool.research.project.info" },
  research_path: { family: "research", title: "ui.tool.research.project.path" },
  research_result_query: { family: "research", title: "ui.tool.research.result.query" },
  research_result_submit: { family: "research", title: "ui.tool.research.result.submit" },
  convert: { family: "document", title: "ui.tool.research.document.convert" },
  read_agent_output: { family: "agent", title: "ui.tool.research.agent.output" },
}

const sensitive = /(?:api[_-]?key|password|passwd|token|secret|authorization|credential)/i

function secret(key: string) {
  return !/^has[_-]/i.test(key) && sensitive.test(key)
}

function data(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Data
}

function value(source: Data, ...keys: string[]) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key]
  }
}

function text(input: unknown) {
  if (typeof input === "string" && input) return input
  if (typeof input === "number" || typeof input === "boolean") return String(input)
}

function array(input: unknown) {
  return Array.isArray(input) ? input : []
}

function shown(input: unknown) {
  if (input === undefined || input === null || input === "") return false
  if (Array.isArray(input) && input.length === 0) return false
  return true
}

function display(input: unknown) {
  if (Array.isArray(input)) {
    if (input.every((item) => ["string", "number", "boolean"].includes(typeof item))) return input.join(", ")
    return JSON.stringify(redact(input), null, 2)
  }
  if (input && typeof input === "object") return JSON.stringify(redact(input), null, 2)
  return String(input)
}

function redact(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(redact)
  if (!input || typeof input !== "object") return input
  return Object.fromEntries(
    Object.entries(input).map(([key, item]) => [key, secret(key) ? "[redacted]" : redact(item)]),
  )
}

function output(input: string | undefined) {
  if (!input) return ""
  const clean = stripAnsi(input)
  try {
    return JSON.stringify(redact(JSON.parse(clean)), null, 2)
  } catch {
    return clean.replace(
      /((?:api[_-]?key|password|passwd|token|secret|authorization|credential)(?:["'])?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,\n}]+)/gi,
      "$1[redacted]",
    )
  }
}

export function payload(input: string | undefined, truncated = false) {
  if (!input || truncated) return
  try {
    return JSON.parse(stripAnsi(input)) as unknown
  } catch {
    return
  }
}

function filename(input: unknown) {
  const path = text(input)
  if (!path) return
  return path.split(/[\\/]/).filter(Boolean).at(-1)
}

export function children(input: string | undefined, truncated = false) {
  if (!input || truncated) return
  const clean = stripAnsi(input).split("\nPOLLING WARNING:", 1)[0]
  try {
    const rows = data(JSON.parse(clean)).children
    if (Array.isArray(rows)) return rows
  } catch {
    return
  }
}

function resultCount(props: ToolProps, parsed?: unknown) {
  const count = value(props.metadata, "count", "atomCount", "deletedCount", "relationCount")
  if (typeof count === "number") return count
  const rows = value(props.metadata, "rows", "tasks", "servers", "branches")
  if (Array.isArray(rows)) return rows.length
  if (Array.isArray(parsed)) return parsed.length
}

function subtitle(props: ToolProps, parsed?: unknown) {
  const input = props.input
  const meta = props.metadata
  const result = data(parsed)
  switch (props.tool) {
    case "atom_create":
      return text(input.name)
    case "atom_query":
      return text(input.atomId) ?? (array(input.atomIds).length ? `${array(input.atomIds).length} atoms` : undefined)
    case "atom_status_update":
      return text(input.atomId) ?? text(input.evidenceStatus)
    case "atom_batch_create":
      return `${array(input.atoms).length} atoms`
    case "atom_delete":
      return `${array(input.atomIds).length} atoms`
    case "atom_relation_query":
      return text(input.atomId) ?? text(input.direction)
    case "atom_relation_create":
    case "atom_relation_delete":
      return [text(input.sourceAtomId), text(input.targetAtomId)].filter(Boolean).join(" → ")
    case "atom_graph_prompt":
    case "atom_graph_prompt_smart":
      return text(input.query) ?? (array(input.atomIds).length ? `${array(input.atomIds).length} seeds` : undefined)
    case "experiment_create":
      return text(input.expName)
    case "experiment_query":
      return text(input.expId) ?? text(input.atomId)
    case "experiment_code_sync":
    case "experiment_watch":
    case "experiment_remote_task_list":
      return text(input.wandbRunId) ?? text(input.expId)
    case "experiment_execution_watch_init":
      return text(input.title) ?? text(input.expId)
    case "experiment_execution_watch_update":
      return text(input.title) ?? text(input.watchId) ?? text(input.expId)
    case "project_runtime_server_query":
      return text(input.remoteServerId)
    case "project_runtime_env_spec_inspect":
      return text(meta.envKey) ?? text(input.envKey) ?? text(input.condaEnvName)
    case "project_runtime_ensure":
      return text(input.remoteServerId)
    case "project_runtime_env_query":
    case "project_runtime_env_upsert":
      return text(input.envKey) ?? text(input.remoteServerId)
    case "project_runtime_resource_query":
    case "project_runtime_resource_upsert":
      return text(input.resourceKey) ?? text(input.remoteServerId)
    case "list_children":
      return text(meta.parentAgentId)
    case "article_query":
      return text(input.articleId) ?? (array(input.articleIds).length ? `${array(input.articleIds).length} articles` : undefined)
    case "article_status_update":
      return text(input.status)
    case "research_code_query":
      return text(input.codeName) ?? text(input.codeId)
    case "research_code_branch_query":
      return text(meta.currentBranch) ?? text(result.currentBranch) ?? filename(input.codeRoot)
    case "research_background_edit":
    case "research_goal_edit":
    case "research_macro_edit":
      return filename(meta.filepath)
    case "research_path":
      return text(result.title) ?? text(input.title) ?? text(input.researchPathId) ?? text(input.action)
    case "research_result_query":
      return text(result.title) ?? text(input.resultId)
    case "research_result_submit":
      return text(result.title) ?? text(input.title)
    case "convert":
      return filename(input.filePath)
    case "read_agent_output":
      return text(result.name) ?? text(input.agent_id)
  }
}

function args(props: ToolProps, parsed: unknown, count: (value: number) => string) {
  const result: string[] = []
  const total = resultCount(props, parsed)
  if (total !== undefined) result.push(count(total))

  const status =
    text(value(props.metadata, "status")) ??
    text(value(data(props.metadata.row), "status")) ??
    text(value(data(parsed), "status")) ??
    text(value(props.input, "status", "evidenceStatus", "stage"))
  if (status) result.push(status.replaceAll("_", " "))
  return result.slice(0, 2)
}

function fields(props: ToolProps, parsed?: unknown) {
  const input = props.input
  const meta = props.metadata
  const row = data(meta.row)
  const info = data(parsed)
  const result: Field[] = []
  const add = (label: string, item: unknown, mono = false) => {
    if (shown(item) && !secret(label)) result.push({ label, value: item, mono })
  }

  switch (props.tool) {
    case "atom_create":
      add("Atom ID", meta.atomId, true)
      add("Type", input.type)
      add("Evidence", input.evidenceType ?? (input.type === "verification" ? "experiment" : "math"))
      add("Article", input.articleId, true)
      break
    case "atom_query":
      add("Atom ID", input.atomId, true)
      add("Atom IDs", input.atomIds, true)
      add("Article IDs", input.articleIds, true)
      add("Results", meta.count)
      break
    case "atom_status_update":
      add("Atom ID", input.atomId, true)
      add("Evidence status", input.evidenceStatus)
      add("Evidence type", input.evidenceType)
      add("Updated", meta.updated)
      break
    case "atom_batch_create":
      add("Atoms", meta.atomCount ?? array(input.atoms).length)
      add("Relations", meta.relationCount ?? array(input.relations).length)
      break
    case "atom_delete":
      add("Atom IDs", input.atomIds, true)
      add("Deleted", meta.deletedCount)
      break
    case "atom_relation_query":
      add("Atom ID", input.atomId, true)
      add("Direction", input.direction ?? "all")
      add("Relation", input.relationType)
      add("Results", meta.count)
      break
    case "atom_relation_create":
    case "atom_relation_delete":
      add("Source", input.sourceAtomId, true)
      add("Target", input.targetAtomId, true)
      add("Relation", input.relationType)
      add("Note", input.note)
      add("Deleted", meta.deletedCount)
      break
    case "atom_graph_prompt":
    case "atom_graph_prompt_smart":
      add("Seed atoms", meta.seedAtomIds ?? input.atomIds, true)
      add("Atoms", meta.atomCount)
      add("Depth", meta.maxDepth ?? input.maxDepth)
      add("Template", meta.template ?? input.template)
      add("Estimated tokens", meta.estimatedTokens)
      add("Tokens used", meta.tokensUsed)
      add("Budget used", meta.budgetUsed)
      break
    case "experiment_create":
      add("Experiment ID", meta.expId, true)
      add("Atom ID", input.atomId, true)
      add("Baseline branch", input.baselineBranch, true)
      add("Expected commit", input.expectedHeadSha, true)
      add("Remote server", input.remoteServerId, true)
      add("Code path", input.codePath, true)
      add("Agent ID", meta.agentId, true)
      break
    case "experiment_query":
      add("Experiment ID", input.expId, true)
      add("Atom ID", input.atomId, true)
      add("Results", meta.count)
      break
    case "experiment_code_sync":
      add("Experiment ID", input.expId, true)
      add("Server", meta.server ?? input.remoteServerId, true)
      add("Local path", input.codePath, true)
      add("Remote path", meta.remoteCodePath ?? input.remoteCodePath, true)
      add("Delete remote files", input.delete)
      break
    case "experiment_watch":
      add("Experiment ID", input.expId, true)
      add("W&B project", input.wandbProject)
      add("W&B run", input.wandbRunId, true)
      add("Watch ID", meta.watchId, true)
      break
    case "experiment_execution_watch_init":
      add("Experiment ID", input.expId, true)
      add("Watch ID", meta.watchId, true)
      add("Title", input.title)
      break
    case "experiment_execution_watch_update":
      add("Experiment ID", input.expId, true)
      add("Watch ID", input.watchId ?? meta.watchId, true)
      add("Stage", input.stage)
      add("Status", input.status)
      add("Message", input.message)
      add("W&B entity", input.wandbEntity)
      add("W&B project", input.wandbProject)
      add("W&B run", input.wandbRunId, true)
      add("Error", input.errorMessage)
      break
    case "experiment_remote_task_list":
      add("Experiment ID", input.expId, true)
      add("Active tasks", array(meta.tasks).length)
      break
    case "project_runtime_server_query":
      add("Server", input.remoteServerId, true)
      add("Ensure runtime", input.ensureRuntime)
      add("Servers", Array.isArray(meta.servers) ? meta.servers.length : meta.server ? 1 : undefined)
      break
    case "project_runtime_env_spec_inspect": {
      const spec = data(meta.spec)
      const fingerprint = data(spec.fingerprint_input)
      add("Environment key", meta.envKey ?? input.envKey, true)
      add("Conda environment", meta.condaEnvName ?? input.condaEnvName, true)
      add("Python", fingerprint.python ?? input.pythonVersion)
      add("CUDA", fingerprint.cuda ?? input.cudaVersion)
      add("Fingerprint", meta.fingerprint, true)
      add("Install mode", input.installMode)
      add("Pip packages", array(input.pipPackages).length)
      add("Conda packages", array(input.condaPackages).length)
      add("System packages", array(input.systemPackages).length)
      add("Confidence", meta.confidence)
      add("Project code not verified", meta.projectCodeNotVerified)
      break
    }
    case "project_runtime_ensure":
      add("Server", meta.remoteServerId ?? input.remoteServerId, true)
      add("Runtime ID", meta.runtimeExpId, true)
      add("Runtime key", meta.runtimeKey, true)
      break
    case "project_runtime_env_query":
      add("Server", input.remoteServerId, true)
      add("Environment key", input.envKey, true)
      add("Results", array(meta.rows).length)
      break
    case "project_runtime_env_upsert":
      add("Server", input.remoteServerId, true)
      add("Environment key", row.env_key ?? input.envKey, true)
      add("Conda environment", row.conda_env_name ?? input.condaEnvName, true)
      add("Python", row.python_version ?? input.pythonVersion)
      add("Fingerprint", row.fingerprint ?? input.fingerprint, true)
      add("Status", row.status ?? input.status)
      add("Error", row.error_message ?? input.errorMessage)
      break
    case "project_runtime_resource_query":
      add("Server", input.remoteServerId, true)
      add("Resource key", input.resourceKey, true)
      add("Results", array(meta.rows).length)
      break
    case "project_runtime_resource_upsert":
      add("Server", input.remoteServerId, true)
      add("Resource key", row.resource_key ?? input.resourceKey, true)
      add("Type", row.type ?? input.type)
      add("Target path", row.target_path ?? input.targetPath, true)
      add("Fingerprint", row.fingerprint ?? input.fingerprint, true)
      add("Status", row.status ?? input.status)
      add("Error", row.error_message ?? input.errorMessage)
      break
    case "list_children":
      add("Parent agent", meta.parentAgentId, true)
      add("Children", meta.count)
      break
    case "article_query":
      add("Article ID", input.articleId, true)
      add("Article IDs", input.articleIds, true)
      add("Status", input.status)
      add("Results", meta.count)
      break
    case "article_status_update":
      add("Article IDs", input.articleIds, true)
      add("Status", input.status)
      add("Updated", meta.updated)
      add("Articles", meta.count)
      break
    case "research_code_query":
      add("Code ID", input.codeId, true)
      add("Code name", input.codeName)
      add("Results", Array.isArray(meta.rows) ? meta.rows.length : meta.count)
      break
    case "research_code_branch_query": {
      const branch = Array.isArray(meta.branches) ? meta : info
      add("Code root", branch.codeRoot ?? input.codeRoot, true)
      add("Current branch", branch.currentBranch, true)
      add("Default branch", branch.defaultBranch, true)
      add("Branches", array(branch.branches).length)
      break
    }
    case "research_background_edit":
    case "research_goal_edit":
    case "research_macro_edit":
      add("File", meta.filepath, true)
      add("Mode", input.oldString === "" ? "whole document" : "matching text")
      add("Previous characters", typeof input.oldString === "string" ? input.oldString.length : undefined)
      add("New characters", typeof input.newString === "string" ? input.newString.length : undefined)
      break
    case "research_info":
      add("Found", meta.found)
      break
    case "research_path":
      add("Action", input.action)
      add("Research path ID", info.research_path_id ?? input.researchPathId, true)
      add("Status", info.status ?? input.status)
      add("Paths", Array.isArray(parsed) ? parsed.length : undefined)
      add("Atoms", Array.isArray(info.atoms) ? info.atoms.length : undefined)
      add("Relations", Array.isArray(info.relations) ? info.relations.length : undefined)
      add("Stages", Array.isArray(info.stages) ? info.stages.length : undefined)
      break
    case "research_result_query":
    case "research_result_submit":
      add("Research result ID", info.research_result_id ?? meta.resultId ?? input.resultId, true)
      add("Results", Array.isArray(parsed) ? parsed.length : meta.count)
      add("Atoms", Array.isArray(info.atoms) ? info.atoms.length : meta.atomCount)
      add("Relations", Array.isArray(info.relations) ? info.relations.length : undefined)
      add("Source session", info.source_session_id, true)
      add("Reviewer session", info.reviewer_session_id, true)
      break
    case "convert":
      add("File", input.filePath, true)
      add("Type", filename(input.filePath)?.split(".").at(-1)?.toUpperCase())
      add("Preview characters", typeof meta.preview === "string" ? meta.preview.length : undefined)
      break
    case "read_agent_output":
      add("Agent ID", info.agent_id ?? input.agent_id, true)
      add("Agent type", info.subagent_type)
      add("Status", info.status)
      add("Spawned", info.spawned_at)
      add("Ended", info.ended_at)
      add("Summary characters", info.summary_bytes)
      add("Summary truncated", info.summary_truncated)
      add(
        "Progress entries",
        Array.isArray(info.progress)
          ? info.progress.length > LIMIT
            ? `latest ${LIMIT} of ${info.progress.length}`
            : info.progress.length
          : undefined,
      )
      break
  }
  return result
}

function list(
  props: ToolProps,
  parsed: unknown,
  children: unknown[] | undefined,
  active: (count: number) => string,
): Item[] {
  const meta = props.metadata
  const rows = (() => {
    if (props.tool === "atom_batch_create") return array(props.input.atoms)
    if (props.tool === "experiment_remote_task_list") return array(meta.tasks)
    if (props.tool === "project_runtime_server_query") {
      if (Array.isArray(meta.servers)) return meta.servers
      return meta.server ? [meta.server] : []
    }
    if (props.tool === "project_runtime_env_query" || props.tool === "project_runtime_resource_query") {
      return array(meta.rows)
    }
    if (props.tool === "list_children") return children ?? []
    if (props.tool === "research_code_query") return array(meta.rows)
    if (props.tool === "research_code_branch_query") {
      return array(Array.isArray(meta.branches) ? meta.branches : data(parsed).branches)
    }
    if (props.tool === "research_path") return Array.isArray(parsed) ? parsed : array(data(parsed).atoms)
    if (props.tool === "research_result_query" || props.tool === "research_result_submit") {
      return Array.isArray(parsed) ? parsed : array(data(parsed).atoms)
    }
    if (props.tool === "read_agent_output") return array(data(parsed).progress)
    return []
  })()

  const visible = props.tool === "read_agent_output" ? rows.slice(-LIMIT) : rows.slice(0, LIMIT)

  return visible.map((item, index) => {
    const row = data(item)
    if (props.tool === "atom_batch_create") {
      return {
        title: text(row.name) ?? `Atom ${index + 1}`,
        subtitle: [text(row.type), text(row.evidenceType)].filter(Boolean).join(" · "),
      }
    }
    if (props.tool === "experiment_remote_task_list") {
      return {
        title: text(row.title) ?? text(value(row, "taskId", "task_id")) ?? `Task ${index + 1}`,
        subtitle: [text(row.kind), text(value(row, "targetPath", "target_path"))].filter(Boolean).join(" · "),
        status: text(row.status),
      }
    }
    if (props.tool === "project_runtime_server_query") {
      const runtime = data(row.project_runtime)
      const envs = text(row.environment_count) ?? "0"
      const resources = text(row.resource_count) ?? "0"
      return {
        title: text(row.label) ?? text(row.id) ?? `Server ${index + 1}`,
        subtitle: `${envs} environments · ${resources} resources`,
        status: runtime.exists === true ? "ready" : "not created",
      }
    }
    if (props.tool === "project_runtime_env_query") {
      return {
        title: text(value(row, "env_key", "envKey")) ?? `Environment ${index + 1}`,
        subtitle: [
          text(value(row, "conda_env_name", "condaEnvName")),
          text(value(row, "python_version", "pythonVersion")),
        ]
          .filter(Boolean)
          .join(" · "),
        status: text(row.status),
      }
    }
    if (props.tool === "list_children") {
      const count = typeof row.active_children === "number" ? row.active_children : 0
      return {
        title: text(row.name) ?? text(row.agent_id) ?? `Agent ${index + 1}`,
        subtitle: [text(row.subagent_type), text(row.agent_id), count > 0 ? active(count) : undefined]
          .filter(Boolean)
          .join(" · "),
        status: text(row.status),
      }
    }
    if (props.tool === "research_code_query") {
      return {
        title: text(row.code_name) ?? text(row.code_id) ?? `Code ${index + 1}`,
        subtitle: [text(row.code_id), text(row.article_title), text(row.code_path)].filter(Boolean).join(" · "),
        status: row.exists === false ? "missing" : row.registered === true ? "registered" : "unregistered",
      }
    }
    if (props.tool === "research_code_branch_query") {
      const sha = text(row.headSha)
      return {
        title: text(row.displayName) ?? text(row.branch) ?? `Branch ${index + 1}`,
        subtitle: [sha, text(row.subject), text(row.experimentName)].filter(Boolean).join(" · "),
        status: text(row.experimentStatus) ?? (row.current === true ? "current" : row.default === true ? "default" : undefined),
      }
    }
    if (props.tool === "research_path") {
      if (Array.isArray(parsed)) {
        return {
          title: text(row.title) ?? text(row.research_path_id) ?? `Path ${index + 1}`,
          subtitle: [text(row.research_path_id), text(row.brief)].filter(Boolean).join(" · "),
          status: text(row.status),
        }
      }
      return {
        title: text(row.atom_name) ?? text(row.atom_id) ?? `Atom ${index + 1}`,
        subtitle: [text(row.role), text(row.atom_type), text(row.atom_evidence_type)].filter(Boolean).join(" · "),
        status: text(row.atom_evidence_status),
      }
    }
    if (props.tool === "research_result_query" || props.tool === "research_result_submit") {
      if (Array.isArray(parsed)) {
        return {
          title: text(row.title) ?? text(row.research_result_id) ?? `Result ${index + 1}`,
          subtitle: [text(row.research_result_id), `${array(row.atoms).length} atoms`].filter(Boolean).join(" · "),
        }
      }
      return {
        title: text(row.atom_name) ?? text(row.atom_id) ?? `Atom ${index + 1}`,
        subtitle: [text(row.atom_type), text(row.atom_evidence_type)].filter(Boolean).join(" · "),
        status: row.available === false ? "unavailable" : text(row.atom_evidence_status),
      }
    }
    if (props.tool === "read_agent_output") {
      const tools = array(row.tools)
      return {
        title: text(row.childName) ?? text(row.childAgentId) ?? `Progress ${index + 1}`,
        subtitle: [typeof row.turn === "number" ? `Turn ${row.turn}` : undefined, tools.length ? `${tools.length} tools` : undefined]
          .filter(Boolean)
          .join(" · "),
        status: tools.length ? (tools.every((item) => data(item).ok === true) ? "passed" : "failed") : undefined,
        body: text(row.assistant_text),
      }
    }
    return {
      title: text(value(row, "resource_key", "resourceKey")) ?? `Resource ${index + 1}`,
      subtitle: [text(row.type), text(value(row, "target_path", "targetPath"))].filter(Boolean).join(" · "),
      status: text(row.status),
    }
  })
}

function documents(props: ToolProps, parsed?: unknown): Document[] {
  const result = data(parsed)
  if (props.tool === "atom_create") {
    return [
      { label: "ui.tool.research.claim", value: text(props.input.claim) ?? "" },
      { label: "ui.tool.research.evidence", value: text(props.input.evidence) ?? "" },
    ].filter((item) => item.value)
  }
  if (props.tool === "research_path" && !Array.isArray(parsed)) {
    return [
      { label: "ui.tool.research.brief", value: text(result.brief) ?? "" },
      { label: "ui.tool.research.summary", value: text(result.summary) ?? "" },
    ].filter((item) => item.value)
  }
  if ((props.tool === "research_result_query" || props.tool === "research_result_submit") && !Array.isArray(parsed)) {
    return [
      { label: "ui.tool.research.summary", value: text(result.summary) ?? "" },
      { label: "ui.tool.research.evaluation", value: text(result.evaluation) ?? "" },
    ].filter((item) => item.value)
  }
  if (props.tool === "convert") {
    return [{ label: "ui.tool.research.preview", value: text(props.metadata.preview) ?? "" }].filter(
      (item) => item.value,
    )
  }
  if (props.tool === "read_agent_output") {
    const error = data(result.error)
    return [
      { label: "ui.tool.research.summary", value: text(result.summary) ?? "" },
      {
        label: "ui.tool.agent.error",
        value: [text(error.message), text(error.detail)].filter(Boolean).join("\n\n"),
      },
    ].filter((item) => item.value)
  }
  return []
}

function structured(props: ToolProps, parsed?: unknown) {
  if (props.tool === "convert") return true
  if (props.tool === "read_agent_output") return parsed !== undefined
  return false
}

function tone(status: string | undefined) {
  if (!status) return "neutral"
  const value = status.toLowerCase()
  if (["ready", "done", "finished", "completed", "proven", "registered", "current", "passed"].includes(value)) {
    return "success"
  }
  if (["failed", "crashed", "disproven", "error", "missing", "unavailable"].includes(value)) return "error"
  if (
    [
      "pending",
      "running",
      "preparing",
      "downloading",
      "stale",
      "in_progress",
      "waiting",
      "blocked_on_children",
      "waiting_interaction",
    ].includes(value)
  ) {
    return "waiting"
  }
  if (["idle", "canceled", "cancelled"].includes(value)) return "neutral"
  return "neutral"
}

const ResearchTool: Component<ToolProps> = (props) => {
  const i18n = useI18n()
  const spec = () => SPECS[props.tool]!
  const parsed = createMemo(() => {
    if (props.tool === "convert") return
    return payload(props.output, props.tool === "read_agent_output" ? false : props.metadata.truncated === true)
  })
  const details = createMemo(() => fields(props, parsed()))
  const childRows = createMemo(() =>
    props.tool === "list_children" ? children(props.output, props.metadata.truncated === true) : undefined,
  )
  const items = createMemo(() =>
    list(props, parsed(), childRows(), (count) => i18n.t("ui.tool.research.agent.activeChildren", { count })),
  )
  const docs = createMemo(() => documents(props, parsed()))
  const triggerArgs = createMemo(() =>
    args(props, parsed(), (count) => i18n.t("ui.tool.research.count", { count })),
  )
  const raw = createMemo(() => !structured(props, parsed()))
  const result = createMemo(() => (raw() ? output(props.output) : ""))

  return (
    <div data-component="research-tool" data-family={spec().family}>
      <ToolCall
        variant="panel"
        icon="mcp"
        status={props.status}
        animate={props.animate}
        springContent
        defer
        defaultOpen={false}
        trigger={{
          title: i18n.t(spec().title),
          subtitle: subtitle(props, parsed()),
          args: triggerArgs(),
        }}
      >
        <div data-component="research-tool-details">
          <div data-slot="research-tool-family">{i18n.t(`ui.tool.research.family.${spec().family}`)}</div>

          <Show when={details().length > 0}>
            <div data-slot="research-tool-fields">
              <For each={details()}>
                {(field) => (
                  <div data-slot="research-tool-field">
                    <span data-slot="research-tool-label">{field.label}</span>
                    <span data-slot="research-tool-value" data-mono={field.mono ? "" : undefined}>
                      {display(field.value)}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <For each={docs()}>
            {(doc) => (
              <section data-slot="research-tool-section">
                <div data-slot="research-tool-section-title">{i18n.t(doc.label)}</div>
                <div data-slot="research-tool-document" data-scrollable>
                  <Markdown text={doc.value} />
                </div>
              </section>
            )}
          </For>

          <Show when={items().length > 0 || childRows()}>
            <section data-slot="research-tool-section">
              <div data-slot="research-tool-section-title">{i18n.t("ui.tool.research.items")}</div>
              <Show
                when={items().length > 0}
                fallback={<div data-slot="research-tool-empty">{i18n.t("ui.tool.research.agent.noChildren")}</div>}
              >
                <div data-slot="research-tool-list" data-scrollable>
                  <For each={items()}>
                    {(item) => (
                      <div data-slot="research-tool-item" data-rich={item.body ? "" : undefined}>
                        <div data-slot="research-tool-item-content">
                          <span data-slot="research-tool-item-title" title={item.title}>
                            {item.title}
                          </span>
                          <Show when={item.subtitle}>
                            {(content) => (
                              <span data-slot="research-tool-item-subtitle" title={content()}>
                                {content()}
                              </span>
                            )}
                          </Show>
                          <Show when={item.body}>
                            {(content) => (
                              <div data-slot="research-tool-item-body">
                                <Markdown text={content()} />
                              </div>
                            )}
                          </Show>
                        </div>
                        <Show when={item.status}>
                          {(status) => (
                            <span data-slot="research-tool-chip" data-tone={tone(status())}>
                              {status().replaceAll("_", " ")}
                            </span>
                          )}
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </section>
          </Show>

          <Show when={raw()}>
            <section data-slot="research-tool-section">
              <div data-slot="research-tool-section-title">{i18n.t("ui.tool.research.output")}</div>
              <Show
                when={result()}
                fallback={<div data-slot="research-tool-empty">{i18n.t("ui.tool.research.noOutput")}</div>}
              >
                {(content) => (
                  <Show
                    when={props.tool === "atom_graph_prompt" || props.tool === "atom_graph_prompt_smart"}
                    fallback={
                      <div data-slot="research-tool-output" data-scrollable>
                        <pre>
                          <code>{content()}</code>
                        </pre>
                      </div>
                    }
                  >
                    <div data-slot="research-tool-document" data-scrollable>
                      <Markdown text={content()} />
                    </div>
                  </Show>
                )}
              </Show>
            </section>
          </Show>
        </div>
      </ToolCall>
    </div>
  )
}

export function ResearchToolError(props: { tool: string; error: string }) {
  const i18n = useI18n()
  const spec = () => SPECS[props.tool]

  return (
    <div data-component="research-tool" data-family={spec()?.family}>
      <ToolCall
        variant="panel"
        icon="mcp"
        status="error"
        springContent
        defaultOpen={false}
        trigger={{
          title: spec() ? i18n.t(spec()!.title) : props.tool,
          args: [i18n.t("ui.tool.research.failed")],
        }}
      >
        <div data-component="research-tool-details">
          <Show when={spec()?.family}>
            {(family) => <div data-slot="research-tool-family">{i18n.t(`ui.tool.research.family.${family()}`)}</div>}
          </Show>
          <section data-slot="research-tool-section">
            <div data-slot="research-tool-section-title">{i18n.t("ui.tool.agent.error")}</div>
            <div data-slot="research-tool-output" data-tone="error" data-scrollable>
              <pre>
                <code>{output(props.error)}</code>
              </pre>
            </div>
          </section>
        </div>
      </ToolCall>
    </div>
  )
}

export function isResearchTool(name: string) {
  return name in SPECS
}

export function registerResearchTools(register: (input: { name: string; render?: ToolComponent }) => unknown) {
  Object.entries(SPECS)
    .filter(([, spec]) => !spec.existing)
    .forEach(([name]) => register({ name, render: ResearchTool }))
}
