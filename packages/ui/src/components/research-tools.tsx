import { createMemo, For, Show, type Component } from "solid-js"
import stripAnsi from "strip-ansi"

import { useI18n } from "../context/i18n"
import { ToolCall } from "./basic-tool"
import { Markdown } from "./markdown"
import type { ToolComponent, ToolProps } from "./message-part"

type Data = Record<string, unknown>

type Family = "atom" | "experiment" | "runtime"

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
}

type Document = {
  label: string
  value: string
}

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
  project_runtime_server_query: { family: "runtime", title: "ui.tool.research.runtime.serverQuery" },
  project_runtime_env_spec_inspect: { family: "runtime", title: "ui.tool.research.runtime.specInspect" },
  project_runtime_ensure: { family: "runtime", title: "ui.tool.research.runtime.ensure" },
  project_runtime_env_query: { family: "runtime", title: "ui.tool.research.runtime.envQuery" },
  project_runtime_env_upsert: { family: "runtime", title: "ui.tool.research.runtime.envUpsert" },
  project_runtime_resource_query: { family: "runtime", title: "ui.tool.research.runtime.resourceQuery" },
  project_runtime_resource_upsert: { family: "runtime", title: "ui.tool.research.runtime.resourceUpsert" },
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

function resultCount(props: ToolProps) {
  const count = value(props.metadata, "count", "atomCount", "deletedCount", "relationCount")
  if (typeof count === "number") return count
  const rows = value(props.metadata, "rows", "tasks", "servers")
  if (Array.isArray(rows)) return rows.length
}

function subtitle(props: ToolProps) {
  const input = props.input
  const meta = props.metadata
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
  }
}

function args(props: ToolProps, count: (value: number) => string) {
  const result: string[] = []
  const total = resultCount(props)
  if (total !== undefined) result.push(count(total))

  const status =
    text(value(props.metadata, "status")) ??
    text(value(data(props.metadata.row), "status")) ??
    text(value(props.input, "status", "evidenceStatus", "stage"))
  if (status) result.push(status.replaceAll("_", " "))
  return result.slice(0, 2)
}

function fields(props: ToolProps) {
  const input = props.input
  const meta = props.metadata
  const row = data(meta.row)
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
  }
  return result
}

function list(props: ToolProps): Item[] {
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
    return []
  })()

  return rows.map((item, index) => {
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
    return {
      title: text(value(row, "resource_key", "resourceKey")) ?? `Resource ${index + 1}`,
      subtitle: [text(row.type), text(value(row, "target_path", "targetPath"))].filter(Boolean).join(" · "),
      status: text(row.status),
    }
  })
}

function documents(props: ToolProps): Document[] {
  if (props.tool !== "atom_create") return []
  return [
    { label: "ui.tool.research.claim", value: text(props.input.claim) ?? "" },
    { label: "ui.tool.research.evidence", value: text(props.input.evidence) ?? "" },
  ].filter((item) => item.value)
}

function tone(status: string | undefined) {
  if (!status) return "neutral"
  if (["ready", "done", "finished", "completed", "proven"].includes(status)) return "success"
  if (["failed", "crashed", "disproven", "error"].includes(status)) return "error"
  if (["pending", "running", "preparing", "downloading", "stale", "in_progress", "waiting"].includes(status)) {
    return "waiting"
  }
  return "neutral"
}

const ResearchTool: Component<ToolProps> = (props) => {
  const i18n = useI18n()
  const spec = () => SPECS[props.tool]!
  const details = createMemo(() => fields(props))
  const items = createMemo(() => list(props))
  const docs = createMemo(() => documents(props))
  const result = createMemo(() => output(props.output))
  const triggerArgs = createMemo(() => args(props, (count) => i18n.t("ui.tool.research.count", { count })))

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
          subtitle: subtitle(props),
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
                <div data-slot="research-tool-document">
                  <Markdown text={doc.value} />
                </div>
              </section>
            )}
          </For>

          <Show when={items().length > 0}>
            <section data-slot="research-tool-section">
              <div data-slot="research-tool-section-title">{i18n.t("ui.tool.research.items")}</div>
              <div data-slot="research-tool-list">
                <For each={items()}>
                  {(item) => (
                    <div data-slot="research-tool-item">
                      <div data-slot="research-tool-item-content">
                        <span data-slot="research-tool-item-title">{item.title}</span>
                        <Show when={item.subtitle}>
                          <span data-slot="research-tool-item-subtitle">{item.subtitle}</span>
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
            </section>
          </Show>

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
            <div data-slot="research-tool-output" data-tone="error">
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
