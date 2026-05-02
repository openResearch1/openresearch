import { createHash } from "node:crypto"

import { Database, eq } from "@/storage/db"
import { Instance } from "@/project/instance"

import { ExperimentExecutionWatch } from "./experiment-execution-watch"
import { ExperimentTable, RemoteServerTable } from "./research.sql"
import { normalizeRemoteServerConfig, remoteServerLabel } from "./remote-server"

export namespace ProjectRuntime {
  export function key(researchProjectId: string, remoteServerId: string) {
    return `project:${researchProjectId}:server:${remoteServerId}`
  }

  export function id(runtimeKey: string) {
    return `project-runtime-${createHash("sha256").update(runtimeKey).digest("hex").slice(0, 16)}`
  }

  export function is(exp: { kind?: string | null }) {
    return exp.kind === "project_runtime"
  }

  export function byKey(runtimeKey: string) {
    return Database.use((db) => db.select().from(ExperimentTable).where(eq(ExperimentTable.runtime_key, runtimeKey)).get())
  }

  export function ensure(input: { researchProjectId: string; remoteServerId: string }) {
    const runtime = key(input.researchProjectId, input.remoteServerId)
    const existing = byKey(runtime)
    if (existing) {
      ExperimentExecutionWatch.createOrGet(existing.exp_id, title(input.remoteServerId), "pending")
      return existing
    }

    const server = Database.use((db) =>
      db.select().from(RemoteServerTable).where(eq(RemoteServerTable.id, input.remoteServerId)).get(),
    )
    if (!server) throw new Error(`remote server not found: ${input.remoteServerId}`)

    const expId = id(runtime)
    const now = Date.now()
    try {
      Database.use((db) =>
        db
          .insert(ExperimentTable)
          .values({
            exp_id: expId,
            kind: "project_runtime",
            runtime_key: runtime,
            research_project_id: input.researchProjectId,
            exp_name: "[system] Project Runtime",
            exp_session_id: null,
            baseline_branch_name: null,
            exp_branch_name: null,
            exp_result_path: null,
            atom_id: null,
            exp_result_summary_path: null,
            exp_plan_path: null,
            remote_server_id: input.remoteServerId,
            code_path: Instance.worktree,
            status: "idle",
            started_at: null,
            finished_at: null,
            time_created: now,
            time_updated: now,
          })
          .run(),
      )
    } catch {
      const row = byKey(runtime)
      if (row) return row
      throw new Error(`failed to create project runtime: ${runtime}`)
    }

    ExperimentExecutionWatch.createOrGet(expId, title(input.remoteServerId), "pending")
    return byKey(runtime)!
  }

  export function title(remoteServerId: string) {
    const server = Database.use((db) => db.select().from(RemoteServerTable).where(eq(RemoteServerTable.id, remoteServerId)).get())
    if (!server) return "Project Runtime"
    return `Project Runtime: ${remoteServerLabel(normalizeRemoteServerConfig(JSON.parse(server.config)))}`
  }
}
