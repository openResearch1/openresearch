import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm"
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

  const ACTIVE_STATUSES: CollabAgentStatus[] = ["pending", "running", "blocked_on_children"]

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
  }

  export function create(input: CreateInput): AgentInfo {
    const now = Date.now()
    const parentId = input.parentAgentId ?? null

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
          status: "pending",
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
            active_children: sql`${CollabAgentTable.active_children} + 1`,
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
        .where(and(eq(CollabAgentTable.project_id, projectId), isNotNull(CollabAgentTable.parent_agent_id)))
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
            isNotNull(CollabAgentTable.parent_agent_id),
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
