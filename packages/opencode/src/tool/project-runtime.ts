import { createHash } from "node:crypto"
import path from "node:path"

import z from "zod"

import { Database, and, eq } from "@/storage/db"
import { ProjectRuntime } from "@/research/project-runtime"
import { Research } from "@/research/research"
import {
  ProjectRuntimeEnvironmentTable,
  ProjectRuntimeResourceTable,
  RemoteServerTable,
} from "@/research/research.sql"
import { normalizeRemoteServerConfig, remoteServerLabel, type RemoteServerConfig } from "@/research/remote-server"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"

import { Tool } from "./tool"

const status = z.enum(["pending", "preparing", "downloading", "ready", "stale", "failed"])
const data = z.record(z.string(), z.unknown())

async function project(sessionID: string) {
  const id = await Research.getResearchProjectId(sessionID)
  if (!id) throw new Error("current session is not associated with any research project")
  return id
}

function text(value: unknown) {
  if (value === undefined || value === null) return null
  return JSON.stringify(value)
}

function server(remoteServerId: string) {
  const row = Database.use((db) => db.select().from(RemoteServerTable).where(eq(RemoteServerTable.id, remoteServerId)).get())
  if (!row) throw new Error(`remote server not found: ${remoteServerId}`)
  return row
}

function config(row: typeof RemoteServerTable.$inferSelect) {
  return normalizeRemoteServerConfig(JSON.parse(row.config))
}

function safe(cfg: RemoteServerConfig, includeSecrets: boolean) {
  if (includeSecrets) return cfg
  const shared = {
    resource_root: cfg.resource_root,
    wandb_project_name: cfg.wandb_project_name,
    has_wandb_api_key: !!cfg.wandb_api_key,
    network: cfg.network,
  }
  if (cfg.mode === "ssh_config") {
    return {
      mode: cfg.mode,
      host_alias: cfg.host_alias,
      ssh_config_path: cfg.ssh_config_path,
      user: cfg.user,
      has_password: !!cfg.password,
      ...shared,
    }
  }
  return {
    mode: cfg.mode,
    address: cfg.address,
    port: cfg.port,
    user: cfg.user,
    has_password: !!cfg.password,
    ...shared,
  }
}

function runtime(researchProjectId: string, remoteServerId: string, ensure: boolean) {
  if (ensure) {
    const row = ProjectRuntime.ensure({ researchProjectId, remoteServerId })
    return { exists: true, runtime_exp_id: row.exp_id, runtime_key: row.runtime_key }
  }
  const key = ProjectRuntime.key(researchProjectId, remoteServerId)
  const row = ProjectRuntime.byKey(key)
  return { exists: !!row, runtime_exp_id: row?.exp_id ?? null, runtime_key: key }
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)
}

function clean(input: string) {
  const line = input.replace(/\s+#.*$/, "").trim()
  if (!line || line.startsWith("#")) return
  return line
}

function pkg(input: string) {
  const line = clean(input)
  if (!line) return
  if (/^(--|-f\s|--find-links|--extra-index-url|--index-url)/.test(line)) return
  if (/^(-e\s+)?(\.|\.\/|\.\.\/|file:)/.test(line)) return { value: line, sync: true }
  if (/^-r\s+/.test(line)) return { value: line, include: line.replace(/^-r\s+/, "").trim() }
  if (/^(git\+|https?:\/\/)/.test(line)) return { value: line }
  const match = /^([A-Za-z0-9_.-]+(?:\[[^\]]+\])?)(.*)$/.exec(line.replace(/\s*(==|>=|<=|~=|!=|>|<)\s*/g, "$1"))
  if (!match) return { value: line }
  return { value: `${match[1].toLowerCase()}${match[2]}` }
}

function unique(items: (string | undefined)[]) {
  return [...new Set(items.filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b))
}

function safeName(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "env"
}

export const ProjectRuntimeServerQueryTool = Tool.define("project_runtime_server_query", {
  description:
    "Query remote server configuration available to the current research project. By default secrets are redacted. Optionally ensure and return the project runtime experiment for a server.",
  parameters: z.object({
    remoteServerId: z.string().optional().describe("Specific remote server ID to inspect. Omit to list all servers."),
    includeSecrets: z.boolean().optional().default(false).describe("Return password and W&B API key in the config."),
    ensureRuntime: z.boolean().optional().default(false).describe("Create the project runtime experiment if missing."),
  }),
  async execute(params, ctx) {
    const researchProjectId = await project(ctx.sessionID)
    const rows = params.remoteServerId
      ? [server(params.remoteServerId)]
      : Database.use((db) => db.select().from(RemoteServerTable).all())
    const servers = rows.map((row) => {
      const cfg = config(row)
      const item = runtime(researchProjectId, row.id, params.ensureRuntime)
      const envs = Database.use((db) =>
        db
          .select()
          .from(ProjectRuntimeEnvironmentTable)
          .where(
            and(
              eq(ProjectRuntimeEnvironmentTable.research_project_id, researchProjectId),
              eq(ProjectRuntimeEnvironmentTable.remote_server_id, row.id),
            ),
          )
          .all(),
      )
      const resources = Database.use((db) =>
        db
          .select()
          .from(ProjectRuntimeResourceTable)
          .where(
            and(
              eq(ProjectRuntimeResourceTable.research_project_id, researchProjectId),
              eq(ProjectRuntimeResourceTable.remote_server_id, row.id),
            ),
          )
          .all(),
      )
      return {
        id: row.id,
        label: remoteServerLabel(cfg),
        config: safe(cfg, params.includeSecrets),
        resource_root: cfg.resource_root ?? null,
        wandb_project_name: cfg.wandb_project_name ?? null,
        has_wandb_api_key: !!cfg.wandb_api_key,
        network_mode: cfg.network?.mode ?? "direct",
        project_runtime: item,
        environments: params.remoteServerId ? envs : undefined,
        resources: params.remoteServerId ? resources : undefined,
        environment_count: envs.length,
        resource_count: resources.length,
      }
    })
    return {
      title: params.remoteServerId ? `Remote server: ${servers[0]?.label ?? params.remoteServerId}` : `${servers.length} remote server(s)`,
      output: JSON.stringify(params.remoteServerId ? servers[0] : servers, null, 2),
      metadata: params.remoteServerId ? { server: servers[0] } : { servers },
    }
  },
})

export const ProjectRuntimeEnvSpecInspectTool = Tool.define("project_runtime_env_spec_inspect", {
  description:
    "Normalize AI-provided project runtime environment requirements into a stable spec and fingerprint. This tool does not infer dependencies from code; the agent must inspect code and server facts first.",
  parameters: z.object({
    codePath: z.string().optional().describe("Local code directory already inspected by the agent. Recorded in spec only."),
    envKey: z.string().optional().describe("Stable project environment key to use instead of the generated key."),
    condaEnvName: z.string().optional().describe("Conda environment name to use instead of the generated name."),
    pythonVersion: z.string().optional().describe("Python major.minor version requirement, for example 3.10."),
    cudaVersion: z.string().optional().describe("CUDA major.minor requirement, for example 12.1."),
    pipPackages: z.array(z.string()).optional().describe("Pip requirements selected by the agent after code analysis."),
    condaPackages: z.array(z.string()).optional().describe("Conda requirements selected by the agent after code/server analysis."),
    systemPackages: z.array(z.string()).optional().describe("System packages selected by the agent after server analysis."),
    installMode: z
      .enum(["dependency_only", "local_package_required", "editable_install_required", "unknown"])
      .optional()
      .default("dependency_only")
      .describe("Agent-selected install mode for the environment requirements."),
    analysisNotes: data.optional().describe("Agent's code-reading rationale for selected dependencies."),
    serverProfile: data.optional().describe("Server facts collected by the agent with the ssh tool."),
    installPlan: data.optional().describe("Concrete server-adapted installation plan selected by the agent."),
    verificationPlan: data.optional().describe("Remote verification checks the agent plans to run after install."),
    requiresProjectCode: z.boolean().optional().default(false),
    projectCodeNotVerified: z.boolean().optional().default(true),
  }),
  async execute(params) {
    const dir = params.codePath ? Filesystem.resolve(params.codePath) : undefined
    if (dir) {
      const stat = Filesystem.stat(dir)
      if (!stat?.isDirectory()) throw new Error(`codePath is not a directory: ${dir}`)
    }

    const extra = (params.pipPackages ?? []).map((item) => pkg(item)?.value)
    const input = {
      python: params.pythonVersion?.replace(/^(\d+)\.(\d+).*$/, "$1.$2") ?? null,
      cuda: params.cudaVersion?.replace(/^(\d+)\.(\d+).*$/, "$1.$2") ?? null,
      pip: unique(extra),
      conda: unique((params.condaPackages ?? []).map((item) => item.toLowerCase().trim())),
      system: unique((params.systemPackages ?? []).map((item) => item.toLowerCase().trim())),
      install_mode: params.installMode,
    }
    const fingerprint = hash(input)
    const base = safeName(params.envKey ?? (dir ? path.basename(dir) : "project"))
    const result = {
      envKey: params.envKey ?? `${base}-${fingerprint.slice(0, 8)}`,
      condaEnvName: params.condaEnvName ?? `openresearch_${base}_${fingerprint.slice(0, 8)}`,
      fingerprint,
      spec: {
        fingerprint_input: input,
        source: {
          code_path: dir ?? null,
          dependency_source: "agent_analysis",
          requires_project_code: params.requiresProjectCode,
          project_code_not_verified: params.projectCodeNotVerified,
        },
        analysis: params.analysisNotes ?? null,
        server_profile: params.serverProfile ?? null,
        install_plan: params.installPlan ?? null,
        verification_plan: params.verificationPlan ?? null,
      },
      requiresProjectCode: params.requiresProjectCode,
      projectCodeNotVerified: params.projectCodeNotVerified,
      confidence: params.pipPackages?.length || params.condaPackages?.length ? "agent_provided" : "low",
    }
    return {
      title: `Environment spec: ${result.envKey}`,
      output: JSON.stringify(result, null, 2),
      metadata: result,
    }
  },
})

export const ProjectRuntimeEnsureTool = Tool.define("project_runtime_ensure", {
  description:
    "Create or return the project-level runtime experiment for the current research project and remote server. Use the returned runtime_exp_id for project-level remote tasks.",
  parameters: z.object({
    remoteServerId: z.string().describe("Remote server ID that owns the project runtime."),
  }),
  async execute(params, ctx) {
    server(params.remoteServerId)
    const researchProjectId = await project(ctx.sessionID)
    const row = ProjectRuntime.ensure({ researchProjectId, remoteServerId: params.remoteServerId })
    return {
      title: "Project runtime",
      output: [
        `runtime_exp_id: ${row.exp_id}`,
        `runtime_key: ${row.runtime_key}`,
        `remote_server_id: ${row.remote_server_id}`,
      ].join("\n"),
      metadata: {
        runtimeExpId: row.exp_id,
        runtimeKey: row.runtime_key,
        remoteServerId: row.remote_server_id,
      },
    }
  },
})

export const ProjectRuntimeEnvQueryTool = Tool.define("project_runtime_env_query", {
  description: "Query project-managed remote environments for the current research project.",
  parameters: z.object({
    remoteServerId: z.string().optional(),
    envKey: z.string().optional(),
  }),
  async execute(params, ctx) {
    const researchProjectId = await project(ctx.sessionID)
    const rows = Database.use((db) =>
      db
        .select()
        .from(ProjectRuntimeEnvironmentTable)
        .where(
          and(
            eq(ProjectRuntimeEnvironmentTable.research_project_id, researchProjectId),
            params.remoteServerId
              ? eq(ProjectRuntimeEnvironmentTable.remote_server_id, params.remoteServerId)
              : undefined,
            params.envKey ? eq(ProjectRuntimeEnvironmentTable.env_key, params.envKey) : undefined,
          ),
        )
        .all(),
    )
    return {
      title: `${rows.length} project runtime environment(s)`,
      output: JSON.stringify(rows, null, 2),
      metadata: { rows },
    }
  },
})

export const ProjectRuntimeEnvUpsertTool = Tool.define("project_runtime_env_upsert", {
  description: "Create or update a project-managed remote environment record.",
  parameters: z.object({
    remoteServerId: z.string(),
    envKey: z.string(),
    condaEnvName: z.string(),
    pythonVersion: z.string().nullable().optional(),
    spec: data.nullable().optional(),
    fingerprint: z.string().nullable().optional(),
    status: status.default("pending"),
    lastVerifiedAt: z.number().nullable().optional(),
    errorMessage: z.string().nullable().optional(),
  }),
  async execute(params, ctx) {
    server(params.remoteServerId)
    const researchProjectId = await project(ctx.sessionID)
    const runtime = ProjectRuntime.ensure({ researchProjectId, remoteServerId: params.remoteServerId })
    const existing = Database.use((db) =>
      db
        .select()
        .from(ProjectRuntimeEnvironmentTable)
        .where(
          and(
            eq(ProjectRuntimeEnvironmentTable.research_project_id, researchProjectId),
            eq(ProjectRuntimeEnvironmentTable.remote_server_id, params.remoteServerId),
            eq(ProjectRuntimeEnvironmentTable.env_key, params.envKey),
          ),
        )
        .get(),
    )
    const now = Date.now()
    if (existing) {
      Database.use((db) =>
        db
          .update(ProjectRuntimeEnvironmentTable)
          .set({
            runtime_exp_id: runtime.exp_id,
            conda_env_name: params.condaEnvName,
            python_version: params.pythonVersion ?? null,
            spec: text(params.spec),
            fingerprint: params.fingerprint ?? null,
            status: params.status,
            last_verified_at: params.lastVerifiedAt ?? null,
            error_message: params.errorMessage ?? null,
            time_updated: now,
          })
          .where(eq(ProjectRuntimeEnvironmentTable.env_id, existing.env_id))
          .run(),
      )
    } else {
      Database.use((db) =>
        db
          .insert(ProjectRuntimeEnvironmentTable)
          .values({
            env_id: crypto.randomUUID(),
            research_project_id: researchProjectId,
            remote_server_id: params.remoteServerId,
            runtime_exp_id: runtime.exp_id,
            env_key: params.envKey,
            conda_env_name: params.condaEnvName,
            python_version: params.pythonVersion ?? null,
            spec: text(params.spec),
            fingerprint: params.fingerprint ?? null,
            status: params.status,
            last_verified_at: params.lastVerifiedAt ?? null,
            error_message: params.errorMessage ?? null,
            time_created: now,
            time_updated: now,
          })
          .run(),
      )
    }
    const row = Database.use((db) =>
      db
        .select()
        .from(ProjectRuntimeEnvironmentTable)
        .where(
          and(
            eq(ProjectRuntimeEnvironmentTable.research_project_id, researchProjectId),
            eq(ProjectRuntimeEnvironmentTable.remote_server_id, params.remoteServerId),
            eq(ProjectRuntimeEnvironmentTable.env_key, params.envKey),
          ),
        )
        .get(),
    )!
    return { title: `Environment: ${row.env_key}`, output: JSON.stringify(row, null, 2), metadata: { row } }
  },
})

export const ProjectRuntimeResourceQueryTool = Tool.define("project_runtime_resource_query", {
  description: "Query project-managed remote resources for the current research project.",
  parameters: z.object({
    remoteServerId: z.string().optional(),
    resourceKey: z.string().optional(),
  }),
  async execute(params, ctx) {
    const researchProjectId = await project(ctx.sessionID)
    const rows = Database.use((db) =>
      db
        .select()
        .from(ProjectRuntimeResourceTable)
        .where(
          and(
            eq(ProjectRuntimeResourceTable.research_project_id, researchProjectId),
            params.remoteServerId ? eq(ProjectRuntimeResourceTable.remote_server_id, params.remoteServerId) : undefined,
            params.resourceKey ? eq(ProjectRuntimeResourceTable.resource_key, params.resourceKey) : undefined,
          ),
        )
        .all(),
    )
    return { title: `${rows.length} project runtime resource(s)`, output: JSON.stringify(rows, null, 2), metadata: { rows } }
  },
})

export const ProjectRuntimeResourceUpsertTool = Tool.define("project_runtime_resource_upsert", {
  description: "Create or update a project-managed remote resource record.",
  parameters: z.object({
    remoteServerId: z.string(),
    resourceKey: z.string(),
    type: z.enum(["dataset", "model", "checkpoint", "artifact"]),
    targetPath: z.string(),
    source: data.nullable().optional(),
    verify: data.nullable().optional(),
    fingerprint: z.string().nullable().optional(),
    status: status.default("pending"),
    lastVerifiedAt: z.number().nullable().optional(),
    errorMessage: z.string().nullable().optional(),
  }),
  async execute(params, ctx) {
    server(params.remoteServerId)
    const researchProjectId = await project(ctx.sessionID)
    const runtime = ProjectRuntime.ensure({ researchProjectId, remoteServerId: params.remoteServerId })
    const existing = Database.use((db) =>
      db
        .select()
        .from(ProjectRuntimeResourceTable)
        .where(
          and(
            eq(ProjectRuntimeResourceTable.research_project_id, researchProjectId),
            eq(ProjectRuntimeResourceTable.remote_server_id, params.remoteServerId),
            eq(ProjectRuntimeResourceTable.resource_key, params.resourceKey),
          ),
        )
        .get(),
    )
    const now = Date.now()
    if (existing) {
      Database.use((db) =>
        db
          .update(ProjectRuntimeResourceTable)
          .set({
            runtime_exp_id: runtime.exp_id,
            type: params.type,
            source: text(params.source),
            target_path: params.targetPath,
            verify: text(params.verify),
            fingerprint: params.fingerprint ?? null,
            status: params.status,
            last_verified_at: params.lastVerifiedAt ?? null,
            error_message: params.errorMessage ?? null,
            time_updated: now,
          })
          .where(eq(ProjectRuntimeResourceTable.resource_id, existing.resource_id))
          .run(),
      )
    } else {
      Database.use((db) =>
        db
          .insert(ProjectRuntimeResourceTable)
          .values({
            resource_id: crypto.randomUUID(),
            research_project_id: researchProjectId,
            remote_server_id: params.remoteServerId,
            runtime_exp_id: runtime.exp_id,
            resource_key: params.resourceKey,
            type: params.type,
            source: text(params.source),
            target_path: params.targetPath,
            verify: text(params.verify),
            fingerprint: params.fingerprint ?? null,
            status: params.status,
            last_verified_at: params.lastVerifiedAt ?? null,
            error_message: params.errorMessage ?? null,
            time_created: now,
            time_updated: now,
          })
          .run(),
      )
    }
    const row = Database.use((db) =>
      db
        .select()
        .from(ProjectRuntimeResourceTable)
        .where(
          and(
            eq(ProjectRuntimeResourceTable.research_project_id, researchProjectId),
            eq(ProjectRuntimeResourceTable.remote_server_id, params.remoteServerId),
            eq(ProjectRuntimeResourceTable.resource_key, params.resourceKey),
          ),
        )
        .get(),
    )!
    return { title: `Resource: ${row.resource_key}`, output: JSON.stringify(row, null, 2), metadata: { row } }
  },
})
