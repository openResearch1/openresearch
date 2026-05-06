import { and, Database, eq, ne } from "@/storage/db"
import { ExperimentExecutionWatch } from "./experiment-execution-watch"
import { RemoteTaskTable } from "./research.sql"

type Status = typeof RemoteTaskTable.$inferSelect.status
type Kind = typeof RemoteTaskTable.$inferSelect.kind
type Task = typeof RemoteTaskTable.$inferSelect
type Waiter = {
  resolve(task: Task): void
  reject(err: Error): void
  cleanup(): void
}

const terminal = new Set<Status>(["finished", "failed", "crashed", "canceled"])
const waiters = new Map<string, Waiter[]>()

interface Lookup {
  taskId?: string
  expId?: string
  kind?: Kind
  resourceKey?: string
}

interface UpdateInput extends Lookup {
  title?: string
  status?: Status
  server?: string
  remoteRoot?: string
  targetPath?: string | null
  screenName?: string
  command?: string
  pid?: number | null
  logPath?: string | null
  sourceSelection?: string | null
  method?: string | null
  errorMessage?: string | null
  lastPolledAt?: number | null
  stoppedAt?: number | null
}

interface UpdateOptions {
  sync?: boolean
  preserveStage?: boolean
}

function row(input: Lookup) {
  if (input.taskId) {
    return Database.use((db) =>
      db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.task_id, input.taskId!)).get(),
    )
  }
  if (!input.expId || !input.kind || !input.resourceKey) return
  const expId = input.expId
  const kind = input.kind
  const resourceKey = input.resourceKey
  return Database.use((db) =>
    db
      .select()
      .from(RemoteTaskTable)
      .where(
        and(
          eq(RemoteTaskTable.exp_id, expId),
          eq(RemoteTaskTable.kind, kind),
          eq(RemoteTaskTable.resource_key, resourceKey),
        ),
      )
      .get(),
  )
}

function done(status: Status) {
  return terminal.has(status)
}

function remove(taskId: string, waiter: Waiter) {
  const rows = (waiters.get(taskId) ?? []).filter((item) => item !== waiter)
  if (rows.length) waiters.set(taskId, rows)
  else waiters.delete(taskId)
}

function notify(task: Task) {
  if (!done(task.status)) return
  const rows = waiters.get(task.task_id)
  if (!rows?.length) return
  waiters.delete(task.task_id)
  for (const item of rows) {
    item.cleanup()
    item.resolve(task)
  }
}

export namespace ExperimentRemoteTask {
  export function isTerminal(status: Status) {
    return done(status)
  }

  export function get(taskId: string) {
    return row({ taskId })
  }

  export function waitTerminal(input: { taskId: string; signal: AbortSignal; timeoutMs?: number }) {
    const current = row({ taskId: input.taskId })
    if (!current) throw new Error(`remote task not found: ${input.taskId}`)
    if (done(current.status)) return Promise.resolve(current)
    return new Promise<Task>((resolve, reject) => {
      const list = waiters.get(input.taskId) ?? []
      waiters.set(input.taskId, list)
      let timeout: ReturnType<typeof setTimeout> | undefined
      const abort = () => {
        remove(input.taskId, waiter)
        waiter.cleanup()
        reject(new Error(`remote task wait aborted: ${input.taskId}`))
      }
      const waiter: Waiter = {
        resolve,
        reject,
        cleanup() {
          if (timeout) clearTimeout(timeout)
          input.signal.removeEventListener("abort", abort)
        },
      }
      timeout = input.timeoutMs
        ? setTimeout(() => {
            remove(input.taskId, waiter)
            waiter.cleanup()
            reject(new Error(`remote task wait timed out: ${input.taskId}`))
          }, input.timeoutMs)
        : undefined
      timeout?.unref()
      if (input.signal.aborted) {
        abort()
        return
      }
      input.signal.addEventListener("abort", abort, { once: true })
      list.push(waiter)
    })
  }

  export function current(expId: string) {
    const rows = [...listByExp(expId)].sort((a, b) => b.time_updated - a.time_updated)
    if (!rows.length) return
    return rows.find((row) => row.status === "pending" || row.status === "running") ?? rows[0]
  }

  export function create(input: {
    expId: string
    kind: Kind
    resourceKey?: string | null
    title: string
    server: string
    remoteRoot: string
    targetPath?: string | null
    screenName: string
    command: string
    logPath?: string | null
    sourceSelection?: string | null
    method?: string | null
  }) {
    const existing = input.resourceKey
      ? row({ expId: input.expId, kind: input.kind, resourceKey: input.resourceKey })
      : undefined
    const now = Date.now()
    if (existing) {
      Database.use((db) =>
        db
          .update(RemoteTaskTable)
          .set({
            title: input.title,
            status: "pending",
            server: input.server,
            remote_root: input.remoteRoot,
            target_path: input.targetPath ?? null,
            screen_name: input.screenName,
            command: input.command,
            log_path: input.logPath ?? null,
            source_selection: input.sourceSelection ?? null,
            method: input.method ?? null,
            error_message: null,
            last_polled_at: null,
            stopped_at: null,
            pid: null,
            time_updated: now,
          })
          .where(eq(RemoteTaskTable.task_id, existing.task_id))
          .run(),
      )
      ExperimentExecutionWatch.syncRemoteTask(input.expId)
      return row({ taskId: existing.task_id })!
    }

    const taskId = crypto.randomUUID()
    Database.use((db) =>
      db
        .insert(RemoteTaskTable)
        .values({
          task_id: taskId,
          exp_id: input.expId,
          kind: input.kind,
          resource_key: input.resourceKey ?? null,
          title: input.title,
          status: "pending",
          server: input.server,
          remote_root: input.remoteRoot,
          target_path: input.targetPath ?? null,
          screen_name: input.screenName,
          command: input.command,
          log_path: input.logPath ?? null,
          source_selection: input.sourceSelection ?? null,
          method: input.method ?? null,
          stopped_at: null,
          time_created: now,
          time_updated: now,
        })
        .run(),
    )
    ExperimentExecutionWatch.syncRemoteTask(input.expId)
    return row({ taskId })!
  }

  export function update(input: UpdateInput, opts?: UpdateOptions) {
    const existing = row(input)
    if (!existing) return
    const now = Date.now()
    Database.use((db) =>
      db
        .update(RemoteTaskTable)
        .set({
          title: input.title ?? existing.title,
          status: input.status ?? existing.status,
          server: input.server ?? existing.server,
          remote_root: input.remoteRoot ?? existing.remote_root,
          target_path: input.targetPath === undefined ? existing.target_path : input.targetPath,
          screen_name: input.screenName ?? existing.screen_name,
          command: input.command ?? existing.command,
          pid: input.pid === undefined ? existing.pid : input.pid,
          log_path: input.logPath === undefined ? existing.log_path : input.logPath,
          source_selection: input.sourceSelection === undefined ? existing.source_selection : input.sourceSelection,
          method: input.method === undefined ? existing.method : input.method,
          error_message: input.errorMessage === undefined ? existing.error_message : input.errorMessage,
          last_polled_at: input.lastPolledAt === undefined ? existing.last_polled_at : input.lastPolledAt,
          stopped_at: input.stoppedAt === undefined ? existing.stopped_at : input.stoppedAt,
          time_updated: now,
        })
        .where(eq(RemoteTaskTable.task_id, existing.task_id))
        .run(),
    )
    const updated = row({ taskId: existing.task_id })
    if (updated && existing.status !== updated.status) notify(updated)
    if (opts?.sync !== false)
      ExperimentExecutionWatch.syncRemoteTask(existing.exp_id, { preserveStage: opts?.preserveStage })
    return updated
  }

  export function listByExp(expId: string) {
    return Database.use((db) => db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, expId)).all())
  }

  export function listActiveByExp(expId: string) {
    return listByExp(expId)
      .filter((task) => task.status === "pending" || task.status === "running")
      .sort((a, b) => b.time_updated - a.time_updated)
  }

  export function listActive() {
    return Database.use((db) =>
      db
        .select()
        .from(RemoteTaskTable)
        .where(
          and(
            ne(RemoteTaskTable.status, "finished"),
            ne(RemoteTaskTable.status, "failed"),
            ne(RemoteTaskTable.status, "crashed"),
            ne(RemoteTaskTable.status, "canceled"),
          ),
        )
        .all(),
    )
  }

  export function latest(expId: string) {
    return [...listByExp(expId)].sort((a, b) => b.time_updated - a.time_updated)[0]
  }

  export function deleteByExp(expId: string) {
    Database.use((db) => db.delete(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, expId)).run())
  }
}
