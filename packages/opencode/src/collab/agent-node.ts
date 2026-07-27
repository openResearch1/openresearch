import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { Database, NotFoundError } from "@/storage/db"
import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { CollabAgentTable } from "./collab.sql"
import { SessionTable } from "@/session/session.sql"
import type { AgentError, AgentInfo, AgentResult, AgentSpec, CollabAgentPhase, CollabAgentStatus } from "./types"
import { CollabEvent } from "./events"

export namespace CollabAgentNode {
  const log = Log.create({ service: "collab.agent-node" })

  export type Row = typeof CollabAgentTable.$inferSelect

  const ACTIVE_STATUSES: CollabAgentStatus[] = ["pending", "running", "blocked_on_children", "waiting_interaction"]

  export function fromRow(row: Row): AgentInfo {
    return {
      id: row.id,
      session_id: row.session_id,
      parent_agent_id: row.parent_agent_id,
      name: row.name,
      project_id: row.project_id,
      root_agent_id: row.root_agent_id,
      subagent_type: row.subagent_type,
      status: row.status,
      phase: row.phase,
      spec: row.spec_json as AgentSpec,
      result: (row.result_json as AgentResult | null) ?? null,
      error: (row.error_json as AgentError | null) ?? null,
      active_children: row.active_children,
      spawned_total: row.spawned_total,
      time_created: row.time_created,
      time_updated: row.time_updated,
      time_started: row.time_started,
      time_ended: row.time_ended,
    }
  }

  export type CreateInput = {
    id: string
    sessionId: string
    parentAgentId?: string | null
    name: string
    projectId: string
    rootAgentId: string
    subagentType: string
    spec: AgentSpec
    status?: CollabAgentStatus
  }

  export function create(input: CreateInput): AgentInfo {
    const now = Date.now()
    const parentId = input.parentAgentId ?? null
    const status = input.status ?? "pending"

    return Database.transaction((tx) => {
      tx.insert(CollabAgentTable)
        .values({
          id: input.id,
          session_id: input.sessionId,
          parent_agent_id: parentId,
          name: input.name,
          project_id: input.projectId,
          root_agent_id: input.rootAgentId,
          subagent_type: input.subagentType,
          status,
          phase: "main_loop",
          spec_json: input.spec as any,
          result_json: null,
          error_json: null,
          active_children: 0,
          spawned_total: 0,
          time_created: now,
          time_updated: now,
          time_started: null,
          time_ended: null,
        })
        .run()

      if (parentId) {
        tx.update(CollabAgentTable)
          .set({
            active_children: sql`${CollabAgentTable.active_children} + ${isActive(status) ? 1 : 0}`,
            spawned_total: sql`${CollabAgentTable.spawned_total} + 1`,
            time_updated: now,
          })
          .where(eq(CollabAgentTable.id, parentId))
          .run()
      }

      const row = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.id)).get()
      if (!row) throw new NotFoundError({ message: `Agent not inserted: ${input.id}` })
      const info = fromRow(row)

      Database.effect(() => Bus.publish(CollabEvent.AgentCreated, { info }))
      log.info("created", { id: input.id, parent: parentId })
      return info
    })
  }

  export function load(id: string): AgentInfo {
    const row = Database.use((db) => db.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get())
    if (!row) throw new NotFoundError({ message: `Agent not found: ${id}` })
    return fromRow(row)
  }

  export function tryLoad(id: string): AgentInfo | undefined {
    const row = Database.use((db) => db.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get())
    return row ? fromRow(row) : undefined
  }

  export function loadBySessionId(sessionId: string): AgentInfo | undefined {
    const row = Database.use((db) =>
      db.select().from(CollabAgentTable).where(eq(CollabAgentTable.session_id, sessionId)).get(),
    )
    return row ? fromRow(row) : undefined
  }

  export function loadChildren(parentId: string): AgentInfo[] {
    const rows = Database.use((db) =>
      db
        .select()
        .from(CollabAgentTable)
        .where(eq(CollabAgentTable.parent_agent_id, parentId))
        .orderBy(asc(CollabAgentTable.time_created))
        .all(),
    )
    return rows.map(fromRow)
  }

  export function loadTree(rootId: string): AgentInfo[] {
    const rows = Database.use((db) =>
      db
        .select()
        .from(CollabAgentTable)
        .where(eq(CollabAgentTable.root_agent_id, rootId))
        .orderBy(asc(CollabAgentTable.time_created))
        .all(),
    )
    return rows.map(fromRow)
  }

  export function loadActiveByProject(projectId: string): AgentInfo[] {
    const rows = Database.use((db) =>
      db
        .select()
        .from(CollabAgentTable)
        .where(and(eq(CollabAgentTable.project_id, projectId), inArray(CollabAgentTable.status, ACTIVE_STATUSES)))
        .orderBy(asc(CollabAgentTable.id))
        .all(),
    )
    return rows.map(fromRow)
  }

  export function isActive(status: CollabAgentStatus) {
    return ACTIVE_STATUSES.includes(status)
  }

  export type TransitionExtra = {
    phase?: CollabAgentPhase
    result?: AgentResult | null
    error?: AgentError | null
    timeStarted?: number | null
    timeEnded?: number | null
  }

  export function transition(id: string, status: CollabAgentStatus, extra?: TransitionExtra): AgentInfo {
    const now = Date.now()
    const row = Database.use((db) => {
      const updates: Partial<typeof CollabAgentTable.$inferInsert> = {
        status,
        time_updated: now,
      }
      if (extra?.phase !== undefined) updates.phase = extra.phase
      if (extra?.result !== undefined) updates.result_json = extra.result as any
      if (extra?.error !== undefined) updates.error_json = extra.error as any
      if (extra?.timeStarted !== undefined) updates.time_started = extra.timeStarted
      if (extra?.timeEnded !== undefined) updates.time_ended = extra.timeEnded
      const updated = db.update(CollabAgentTable).set(updates).where(eq(CollabAgentTable.id, id)).returning().get()
      if (!updated) throw new NotFoundError({ message: `Agent not found: ${id}` })
      return updated
    })

    const info = fromRow(row)
    Database.effect(() =>
      Bus.publish(CollabEvent.AgentStatus, {
        agentId: info.id,
        rootAgentId: info.root_agent_id,
        status: info.status,
        phase: info.phase,
        active_children: info.active_children,
      }),
    )
    log.info("transition", { id, status, phase: extra?.phase })
    return info
  }

  export function activate(id: string): AgentInfo {
    const now = Date.now()
    return Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get()
      if (!current) throw new NotFoundError({ message: `Agent not found: ${id}` })
      if (isActive(current.status)) return fromRow(current)

      const row = tx
        .update(CollabAgentTable)
        .set({
          status: "running",
          phase: "main_loop",
          error_json: null,
          time_ended: null,
          time_started: now,
          time_updated: now,
        })
        .where(eq(CollabAgentTable.id, id))
        .returning()
        .get()
      if (!row) throw new NotFoundError({ message: `Agent not found: ${id}` })

      if (current.parent_agent_id) {
        tx.update(CollabAgentTable)
          .set({
            active_children: sql`${CollabAgentTable.active_children} + 1`,
            time_updated: now,
          })
          .where(eq(CollabAgentTable.id, current.parent_agent_id))
          .run()
      }

      const info = fromRow(row)
      Database.effect(() =>
        Bus.publish(CollabEvent.AgentStatus, {
          agentId: info.id,
          rootAgentId: info.root_agent_id,
          status: info.status,
          phase: info.phase,
          active_children: info.active_children,
        }),
      )
      return info
    })
  }

  export function spec(id: string, spec: AgentSpec): AgentInfo {
    const row = Database.use((db) =>
      db
        .update(CollabAgentTable)
        .set({ spec_json: spec, time_updated: Date.now() })
        .where(eq(CollabAgentTable.id, id))
        .returning()
        .get(),
    )
    if (!row) throw new NotFoundError({ message: `Agent not found: ${id}` })
    return fromRow(row)
  }

  export function attach(input: {
    id: string
    parentId: string
    rootId: string
    name: string
    subagentType: string
    metadata: Record<string, unknown>
  }): AgentInfo {
    const now = Date.now()
    return Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.id)).get()
      if (!current) throw new NotFoundError({ message: `Agent not found: ${input.id}` })
      const parent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.parentId)).get()
      if (!parent) throw new NotFoundError({ message: `Parent agent not found: ${input.parentId}` })
      if (current.parent_agent_id === input.parentId && current.root_agent_id === input.rootId) return fromRow(current)
      if (parent.root_agent_id !== input.rootId) throw new Error(`Parent ${input.parentId} is not in root ${input.rootId}`)
      if (parent.project_id !== current.project_id) throw new Error(`Agent ${input.id} project mismatch`)

      const tree = tx
        .select({ id: CollabAgentTable.id, parent: CollabAgentTable.parent_agent_id })
        .from(CollabAgentTable)
        .where(eq(CollabAgentTable.root_agent_id, current.root_agent_id))
        .all()
      const ids = new Set([current.id])
      let changed = true
      while (changed) {
        changed = false
        for (const item of tree) {
          if (!item.parent || !ids.has(item.parent) || ids.has(item.id)) continue
          ids.add(item.id)
          changed = true
        }
      }
      if (ids.has(parent.id)) throw new Error(`Attaching ${input.id} would create a cycle`)

      tx.update(CollabAgentTable)
        .set({ root_agent_id: input.rootId, time_updated: now })
        .where(inArray(CollabAgentTable.id, [...ids]))
        .run()
      const row = tx
        .update(CollabAgentTable)
        .set({
          parent_agent_id: input.parentId,
          name: input.name,
          subagent_type: input.subagentType,
          status: "idle",
          phase: "main_loop",
          spec_json: {
            ...(current.spec_json as AgentSpec),
            metadata: {
              ...(current.spec_json as AgentSpec).metadata,
              ...input.metadata,
            },
          },
          time_updated: now,
        })
        .where(eq(CollabAgentTable.id, input.id))
        .returning()
        .get()
      if (!row) throw new NotFoundError({ message: `Agent not found: ${input.id}` })

      if (current.parent_agent_id && isActive(current.status)) {
        tx.update(CollabAgentTable)
          .set({
            active_children: sql`max(${CollabAgentTable.active_children} - 1, 0)`,
            time_updated: now,
          })
          .where(eq(CollabAgentTable.id, current.parent_agent_id))
          .run()
      }

      tx.update(CollabAgentTable)
        .set({
          spawned_total: sql`${CollabAgentTable.spawned_total} + 1`,
          time_updated: now,
        })
        .where(eq(CollabAgentTable.id, input.parentId))
        .run()

      const info = fromRow(row)
      Database.effect(() => Bus.publish(CollabEvent.AgentCreated, { info }))
      log.info("attached", { id: input.id, parent: input.parentId, root: input.rootId })
      return info
    })
  }

  export function rebind(id: string, sessionId: string) {
    const row = Database.use((db) =>
      db
        .update(CollabAgentTable)
        .set({ session_id: sessionId, time_updated: Date.now() })
        .where(eq(CollabAgentTable.id, id))
        .returning()
        .get(),
    )
    if (!row) throw new NotFoundError({ message: `Agent not found: ${id}` })
    const info = fromRow(row)
    Database.effect(() => Bus.publish(CollabEvent.AgentCreated, { info }))
    return info
  }

  export function drop(id: string, reported = false) {
    Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get()
      if (!current) return
      if (current.parent_agent_id && isActive(current.status) && !reported) {
        tx.update(CollabAgentTable)
          .set({
            active_children: sql`max(${CollabAgentTable.active_children} - 1, 0)`,
            time_updated: Date.now(),
          })
          .where(eq(CollabAgentTable.id, current.parent_agent_id))
          .run()
      }
      tx.delete(CollabAgentTable).where(eq(CollabAgentTable.id, id)).run()
    })
  }

  export function detach(id: string) {
    Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get()
      if (!current?.parent_agent_id) return
      const tree = tx
        .select({ id: CollabAgentTable.id, parent: CollabAgentTable.parent_agent_id })
        .from(CollabAgentTable)
        .where(eq(CollabAgentTable.root_agent_id, current.root_agent_id))
        .all()
      const ids = new Set([current.id])
      let changed = true
      while (changed) {
        changed = false
        for (const item of tree) {
          if (!item.parent || !ids.has(item.parent) || ids.has(item.id)) continue
          ids.add(item.id)
          changed = true
        }
      }
      tx.update(CollabAgentTable)
        .set({ root_agent_id: current.id, time_updated: Date.now() })
        .where(inArray(CollabAgentTable.id, [...ids]))
        .run()
      tx.update(CollabAgentTable)
        .set({ parent_agent_id: null, time_updated: Date.now() })
        .where(eq(CollabAgentTable.id, current.id))
        .run()
      if (isActive(current.status)) {
        tx.update(CollabAgentTable)
          .set({
            active_children: sql`max(${CollabAgentTable.active_children} - 1, 0)`,
            time_updated: Date.now(),
          })
          .where(eq(CollabAgentTable.id, current.parent_agent_id))
          .run()
      }
    })
  }

  export function updatePhase(id: string, phase: CollabAgentPhase): AgentInfo {
    const now = Date.now()
    const row = Database.use((db) =>
      db
        .update(CollabAgentTable)
        .set({ phase, time_updated: now })
        .where(eq(CollabAgentTable.id, id))
        .returning()
        .get(),
    )
    if (!row) throw new NotFoundError({ message: `Agent not found: ${id}` })
    const info = fromRow(row)
    Database.effect(() =>
      Bus.publish(CollabEvent.AgentStatus, {
        agentId: info.id,
        rootAgentId: info.root_agent_id,
        status: info.status,
        phase: info.phase,
        active_children: info.active_children,
      }),
    )
    return info
  }

  export function loadPeerSessionIds(projectId: string): string[] {
    return Database.use((db) =>
      db
        .select({ session_id: CollabAgentTable.session_id })
        .from(CollabAgentTable)
        .innerJoin(SessionTable, eq(SessionTable.id, CollabAgentTable.session_id))
        .where(and(eq(CollabAgentTable.project_id, projectId), eq(SessionTable.collab_peer, true)))
        .all(),
    ).map((r) => r.session_id)
  }

  /**
   * Robust variant: match peer sessions by joining on session.directory in
   * addition to the collab_agent.project_id filter. Guards against legacy
   * rows whose project_id may not line up with the current request's
   * `Instance.project.id` but whose backing session IS in the requested
   * directory.
   */
  export function loadPeerSessionIdsByDirectory(projectId: string, directory: string): string[] {
    return Database.use((db) =>
      db
        .select({ session_id: CollabAgentTable.session_id })
        .from(CollabAgentTable)
        .innerJoin(SessionTable, eq(SessionTable.id, CollabAgentTable.session_id))
        .where(
          and(
            eq(SessionTable.collab_peer, true),
            // either project_id matches or the session directory matches —
            // be permissive so stale rows still resolve.
            sql`(${CollabAgentTable.project_id} = ${projectId} OR ${SessionTable.directory} = ${directory})`,
          ),
        )
        .all(),
    ).map((r) => r.session_id)
  }

  export function bumpActiveChildren(parentId: string, delta: number) {
    if (delta === 0) return
    const now = Date.now()
    Database.use((db) =>
      db
        .update(CollabAgentTable)
        .set({
          active_children: sql`max(${CollabAgentTable.active_children} + ${delta}, 0)`,
          time_updated: now,
        })
        .where(eq(CollabAgentTable.id, parentId))
        .run(),
    )
  }

  export function recomputeActiveChildren(parentId: string): number {
    const children = loadChildren(parentId)
    const active = children.filter((c) => ACTIVE_STATUSES.includes(c.status)).length
    const now = Date.now()
    Database.use((db) =>
      db
        .update(CollabAgentTable)
        .set({ active_children: active, time_updated: now })
        .where(eq(CollabAgentTable.id, parentId))
        .run(),
    )
    return active
  }
}
