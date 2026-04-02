import { Database, eq, and, ne } from "../storage/db"
import { LocalDownloadWatchTable } from "./research.sql"

type Status = typeof LocalDownloadWatchTable.$inferSelect.status

interface Lookup {
  watchId?: string
  expId?: string
  resourceKey?: string
}

interface UpdateInput extends Lookup {
  resourceName?: string
  resourceType?: string | null
  status?: Status
  localResourceRoot?: string | null
  localPath?: string | null
  pid?: number | null
  logPath?: string | null
  statusPath?: string | null
  sourceSelection?: string | null
  method?: string | null
  errorMessage?: string | null
  lastPolledAt?: number | null
}

function row(input: Lookup) {
  if (input.watchId) {
    return Database.use((db) =>
      db.select().from(LocalDownloadWatchTable).where(eq(LocalDownloadWatchTable.watch_id, input.watchId!)).get(),
    )
  }
  if (!input.expId || !input.resourceKey) return
  return Database.use((db) =>
    db
      .select()
      .from(LocalDownloadWatchTable)
      .where(
        and(
          eq(LocalDownloadWatchTable.exp_id, input.expId!),
          eq(LocalDownloadWatchTable.resource_key, input.resourceKey!),
        ),
      )
      .get(),
  )
}

export namespace ExperimentLocalDownloadWatch {
  export function createOrGet(input: {
    expId: string
    resourceKey: string
    resourceName: string
    resourceType?: string | null
    localResourceRoot?: string | null
  }) {
    const existing = row(input)
    if (existing) return existing
    const now = Date.now()
    const watchId = crypto.randomUUID()
    Database.use((db) =>
      db
        .insert(LocalDownloadWatchTable)
        .values({
          watch_id: watchId,
          exp_id: input.expId,
          resource_key: input.resourceKey,
          resource_name: input.resourceName,
          resource_type: input.resourceType ?? null,
          local_resource_root: input.localResourceRoot ?? null,
          status: "pending",
          time_created: now,
          time_updated: now,
        })
        .run(),
    )
    return row({ watchId })!
  }

  export function update(input: UpdateInput) {
    const existing = row(input)
    if (!existing) return
    const now = Date.now()
    Database.use((db) =>
      db
        .update(LocalDownloadWatchTable)
        .set({
          resource_name: input.resourceName ?? existing.resource_name,
          resource_type: input.resourceType === undefined ? existing.resource_type : input.resourceType,
          status: input.status ?? existing.status,
          local_resource_root:
            input.localResourceRoot === undefined ? existing.local_resource_root : input.localResourceRoot,
          local_path: input.localPath === undefined ? existing.local_path : input.localPath,
          pid: input.pid === undefined ? existing.pid : input.pid,
          log_path: input.logPath === undefined ? existing.log_path : input.logPath,
          status_path: input.statusPath === undefined ? existing.status_path : input.statusPath,
          source_selection: input.sourceSelection === undefined ? existing.source_selection : input.sourceSelection,
          method: input.method === undefined ? existing.method : input.method,
          error_message: input.errorMessage === undefined ? existing.error_message : input.errorMessage,
          last_polled_at: input.lastPolledAt === undefined ? existing.last_polled_at : input.lastPolledAt,
          time_updated: now,
        })
        .where(eq(LocalDownloadWatchTable.watch_id, existing.watch_id))
        .run(),
    )
    return row({ watchId: existing.watch_id })
  }

  export function listByExp(expId: string) {
    return Database.use((db) =>
      db.select().from(LocalDownloadWatchTable).where(eq(LocalDownloadWatchTable.exp_id, expId)).all(),
    )
  }

  export function listActive() {
    return Database.use((db) =>
      db
        .select()
        .from(LocalDownloadWatchTable)
        .where(
          and(
            ne(LocalDownloadWatchTable.status, "finished"),
            ne(LocalDownloadWatchTable.status, "failed"),
            ne(LocalDownloadWatchTable.status, "crashed"),
          ),
        )
        .all(),
    )
  }

  export function deleteByExp(expId: string) {
    Database.use((db) => db.delete(LocalDownloadWatchTable).where(eq(LocalDownloadWatchTable.exp_id, expId)).run())
  }
}
