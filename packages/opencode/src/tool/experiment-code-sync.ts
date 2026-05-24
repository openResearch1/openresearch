import z from "zod"

import { defaultRemoteCodePath, syncCodeToRemote } from "@/research/remote-code-sync"
import { ExperimentTable, RemoteServerTable } from "@/research/research.sql"
import { normalizeRemoteServerConfig } from "@/research/remote-server"
import { Database, eq } from "@/storage/db"

import { Tool } from "./tool"

export const ExperimentCodeSyncTool = Tool.define("experiment_code_sync", {
  description:
    "Sync an experiment code directory to its configured remote server with rsync. Creates the remote directory, excludes git metadata, and stores the resolved remote code path on the experiment.",
  parameters: z.object({
    expId: z.string().describe("Experiment ID to sync."),
    codePath: z.string().optional().describe("Local code directory. Defaults to the experiment code_path."),
    remoteCodePath: z
      .string()
      .optional()
      .describe("Full remote directory for this experiment. Defaults to experiment remote_code_path, then experiments/<exp_id>."),
    remoteServerId: z.string().optional().describe("Remote server ID. Defaults to the experiment remote_server_id."),
    delete: z.boolean().optional().default(false).describe("Pass --delete to rsync so removed local files disappear remotely."),
    timeout: z.number().positive().optional().describe("Sync timeout in milliseconds."),
  }),
  async execute(params) {
    const exp = Database.use((db) => db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, params.expId)).get())
    if (!exp) throw new Error(`experiment not found: ${params.expId}`)
    const id = params.remoteServerId ?? exp.remote_server_id
    if (!id) throw new Error(`experiment has no remote server: ${params.expId}`)
    const row = Database.use((db) => db.select().from(RemoteServerTable).where(eq(RemoteServerTable.id, id)).get())
    if (!row) throw new Error(`remote server not found: ${id}`)

    const remoteCodePath = (params.remoteCodePath ?? exp.remote_code_path ?? defaultRemoteCodePath(params.expId)).trim()
    const result = await syncCodeToRemote({
      server: normalizeRemoteServerConfig(JSON.parse(row.config)),
      codePath: params.codePath ?? exp.code_path,
      remoteCodePath,
      delete: params.delete,
      timeout: params.timeout,
    })
    if (!result.ok) throw new Error(result.output || `failed to sync code to ${remoteCodePath}`)

    Database.use((db) =>
      db
        .update(ExperimentTable)
        .set({ remote_code_path: remoteCodePath, time_updated: Date.now() })
        .where(eq(ExperimentTable.exp_id, params.expId))
        .run(),
    )

    return {
      title: `Code synced: ${params.expId}`,
      output: [`Status: success`, `Server: ${result.server}`, `Remote Path: ${remoteCodePath}`, result.output].filter(Boolean).join("\n"),
      metadata: {
        expId: params.expId,
        server: result.server,
        remoteCodePath,
        output: result.output,
      },
    }
  },
})
