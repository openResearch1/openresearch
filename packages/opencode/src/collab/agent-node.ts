import { randomUUID } from "crypto"

import { and, asc, eq, gt, gte, inArray, isNull, ne, sql } from "drizzle-orm"
import { Database, NotFoundError } from "@/storage/db"
import { Bus } from "@/bus"
import { Identifier } from "@/id/id"
import { SessionTable } from "@/session/session.sql"
import { SessionDeletionTable } from "@/session/deletion.sql"
import { SessionOwnershipTable } from "@/session/ownership.sql"
import { Log } from "@/util/log"
import { CollabAgentTable, CollabMessageTable } from "./collab.sql"
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
      run_id: row.run_id,
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
    const run = parentId && isActive(status) ? randomUUID() : null

    return Database.transaction((tx) => {
      // Serialize creators across processes through the authoritative session row.
      tx.update(SessionTable)
        .set({ time_updated: sql`${SessionTable.time_updated}` })
        .where(eq(SessionTable.id, input.sessionId))
        .run()
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.session_id, input.sessionId)).get()
      if (current) return fromRow(current)

      const inserted = tx
        .insert(CollabAgentTable)
        .values({
          id: input.id,
          session_id: input.sessionId,
          parent_agent_id: parentId,
          name: input.name,
          project_id: input.projectId,
          root_agent_id: input.rootAgentId,
          run_id: run,
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
        .onConflictDoNothing()
        .returning({ id: CollabAgentTable.id })
        .get()

      if (!inserted) {
        const existing = tx
          .select()
          .from(CollabAgentTable)
          .where(eq(CollabAgentTable.session_id, input.sessionId))
          .get()
        if (existing) return fromRow(existing)
        throw new NotFoundError({ message: `Agent not inserted: ${input.id}` })
      }

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

  export function loadByProject(projectId: string): AgentInfo[] {
    return Database.use((db) =>
      db
        .select()
        .from(CollabAgentTable)
        .where(eq(CollabAgentTable.project_id, projectId))
        .orderBy(asc(CollabAgentTable.id))
        .all(),
    ).map(fromRow)
  }

  export function isActive(status: CollabAgentStatus) {
    return ACTIVE_STATUSES.includes(status)
  }

  export function isAncestor(ancestorId: string, descendantId: string) {
    if (ancestorId === descendantId) return false
    const node = tryLoad(descendantId)
    if (!node) return false
    const tree = loadTree(node.root_agent_id)
    const nodes = new Map(tree.map((item) => [item.id, item]))
    let current = node
    while (current.parent_agent_id) {
      if (current.parent_agent_id === ancestorId) return true
      const parent = nodes.get(current.parent_agent_id)
      if (!parent) return false
      current = parent
    }
    return false
  }

  export function loadBranch(agentId: string) {
    const anchor = load(agentId)
    const tree = loadTree(anchor.root_agent_id)
    const ids = new Set([anchor.id])
    let changed = true
    while (changed) {
      changed = false
      for (const item of tree) {
        if (!item.parent_agent_id || !ids.has(item.parent_agent_id) || ids.has(item.id)) continue
        ids.add(item.id)
        changed = true
      }
    }
    return tree.filter((item) => ids.has(item.id))
  }

  export function isBranchSettled(agentId: string) {
    const anchor = tryLoad(agentId)
    if (!anchor) return true
    return loadBranch(agentId).every((item) => item.id === anchor.id || !isActive(item.status))
  }

  export type TransitionExtra = {
    phase?: CollabAgentPhase
    result?: AgentResult | null
    error?: AgentError | null
    timeStarted?: number | null
    timeEnded?: number | null
  }

  export function transition(
    id: string,
    status: CollabAgentStatus,
    extra?: TransitionExtra,
    expected?: { runId: string | null; parentId: string | null; status?: CollabAgentStatus },
  ): AgentInfo {
    const now = Date.now()
    const row = Database.use((db) => {
      const updates: Partial<typeof CollabAgentTable.$inferInsert> = {
        status,
        time_updated: now,
      }
      if (status === "idle") updates.run_id = null
      if (extra?.phase !== undefined) updates.phase = extra.phase
      if (extra?.result !== undefined) updates.result_json = extra.result as any
      if (extra?.error !== undefined) updates.error_json = extra.error as any
      if (extra?.timeStarted !== undefined) updates.time_started = extra.timeStarted
      if (extra?.timeEnded !== undefined) updates.time_ended = extra.timeEnded
      const updated = db
        .update(CollabAgentTable)
        .set(updates)
        .where(
          and(
            eq(CollabAgentTable.id, id),
            expected?.runId === undefined
              ? undefined
              : expected.runId
                ? eq(CollabAgentTable.run_id, expected.runId)
                : isNull(CollabAgentTable.run_id),
            expected?.parentId === undefined
              ? undefined
              : expected.parentId
                ? eq(CollabAgentTable.parent_agent_id, expected.parentId)
                : isNull(CollabAgentTable.parent_agent_id),
            expected?.status ? eq(CollabAgentTable.status, expected.status) : undefined,
          ),
        )
        .returning()
        .get()
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

  export function finish(input: {
    id: string
    runId: string | null
    parentId: string | null
    status: "completed" | "failed" | "canceled"
    phase: CollabAgentPhase
    result?: AgentResult
    error?: AgentError
    timeEnded: number
    leaseToken?: string
    report?: { kind: "child_done" | "child_failed"; payload: Record<string, unknown> }
  }) {
    const now = Date.now()
    return Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.id)).get()
      if (!current) throw new NotFoundError({ message: `Agent not found: ${input.id}` })
      if (current.run_id !== input.runId || current.parent_agent_id !== input.parentId || !isActive(current.status))
        return
      if (input.leaseToken) {
        const lease = tx
          .select({ id: SessionOwnershipTable.session_id })
          .from(SessionOwnershipTable)
          .where(
            and(
              eq(SessionOwnershipTable.session_id, current.session_id),
              eq(SessionOwnershipTable.token, input.leaseToken),
              gt(SessionOwnershipTable.expires_at, now),
            ),
          )
          .get()
        if (!lease) return
      }

      const row = tx
        .update(CollabAgentTable)
        .set({
          status: input.status,
          phase: input.phase,
          result_json: input.result ?? null,
          error_json: input.error ?? null,
          time_ended: input.timeEnded,
          time_updated: now,
        })
        .where(
          and(
            eq(CollabAgentTable.id, input.id),
            input.runId ? eq(CollabAgentTable.run_id, input.runId) : isNull(CollabAgentTable.run_id),
            input.parentId
              ? eq(CollabAgentTable.parent_agent_id, input.parentId)
              : isNull(CollabAgentTable.parent_agent_id),
            inArray(CollabAgentTable.status, ACTIVE_STATUSES),
          ),
        )
        .returning()
        .get()
      if (!row) return

      tx.update(CollabMessageTable)
        .set({ status: "dropped", claim_id: null, time_updated: now })
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, input.id),
            inArray(CollabMessageTable.status, ["pending", "processing"]),
            ne(CollabMessageTable.kind, "session_remote_task_terminal"),
          ),
        )
        .run()

      let message: string | undefined
      if (input.parentId && input.report) {
        const existing = tx
          .select({ id: CollabMessageTable.id })
          .from(CollabMessageTable)
          .where(
            and(
              eq(CollabMessageTable.recipient_agent_id, input.parentId),
              eq(CollabMessageTable.sender_agent_id, input.id),
              input.runId ? eq(CollabMessageTable.run_id, input.runId) : isNull(CollabMessageTable.run_id),
              inArray(CollabMessageTable.kind, ["child_done", "child_failed"]),
              input.runId ? undefined : gte(CollabMessageTable.time_created, row.time_started ?? row.time_created),
            ),
          )
          .limit(1)
          .get()
        if (!existing) {
          message = Identifier.ascending("collab_msg")
          const inserted = tx
            .insert(CollabMessageTable)
            .values({
              id: message,
              recipient_agent_id: input.parentId,
              sender_agent_id: input.id,
              run_id: input.runId,
              kind: input.report.kind,
              payload_json: {
                ...input.report.payload,
                ...(input.runId ? { runId: input.runId } : {}),
                deliveryMessageId: Identifier.ascending("message"),
              },
              status: "pending",
              claim_id: null,
              time_created: now,
              time_updated: now,
              time_consumed: null,
            })
            .onConflictDoNothing()
            .returning({ id: CollabMessageTable.id })
            .get()
          if (!inserted) message = undefined
          if (inserted) {
            tx.update(CollabAgentTable)
              .set({
                active_children: sql`max(${CollabAgentTable.active_children} - 1, 0)`,
                time_updated: now,
              })
              .where(eq(CollabAgentTable.id, input.parentId))
              .run()
          }
        }
      }

      const info = fromRow(row)
      Database.effect(() => {
        Bus.publish(CollabEvent.AgentStatus, {
          agentId: info.id,
          rootAgentId: info.root_agent_id,
          status: info.status,
          phase: info.phase,
          active_children: info.active_children,
        })
        if (!message || !input.parentId || !input.report) return
        Bus.publish(CollabEvent.MessagePosted, {
          messageId: message,
          recipientAgentId: input.parentId,
          senderAgentId: input.id,
          kind: input.report.kind,
        })
      })
      log.info("finished", { id: input.id, status: input.status, run: input.runId })
      return info
    })
  }

  export function activate(id: string, expected?: { runId: string | null; parentId: string | null }): AgentInfo {
    const now = Date.now()
    return Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get()
      if (!current) throw new NotFoundError({ message: `Agent not found: ${id}` })
      if (expected && (current.run_id !== expected.runId || current.parent_agent_id !== expected.parentId)) {
        throw new Error(`Agent ${id} ownership changed before activation`)
      }
      if (isActive(current.status)) return fromRow(current)

      const row = tx
        .update(CollabAgentTable)
        .set({
          status: "running",
          run_id: current.parent_agent_id ? randomUUID() : null,
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

  export function ensureRun(id: string): AgentInfo {
    const now = Date.now()
    const row = Database.use((db) => {
      const current = db.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get()
      if (!current) throw new NotFoundError({ message: `Agent not found: ${id}` })
      if (!current.parent_agent_id || !isActive(current.status) || current.run_id) return current
      const updated = db
        .update(CollabAgentTable)
        .set({ run_id: randomUUID(), time_updated: now })
        .where(
          and(
            eq(CollabAgentTable.id, id),
            isNull(CollabAgentTable.run_id),
            eq(CollabAgentTable.parent_agent_id, current.parent_agent_id),
            eq(CollabAgentTable.status, current.status),
          ),
        )
        .returning()
        .get()
      if (updated) return updated
      const fresh = db.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get()
      if (!fresh) throw new NotFoundError({ message: `Agent not found: ${id}` })
      return fresh
    })
    const info = fromRow(row)
    if (info.parent_agent_id && isActive(info.status) && !info.run_id) return ensureRun(id)
    return info
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
      if (parent.root_agent_id !== input.rootId)
        throw new Error(`Parent ${input.parentId} is not in root ${input.rootId}`)
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
          run_id: null,
          name: input.name,
          subagent_type: input.subagentType,
          status: "idle",
          phase: "main_loop",
          spec_json: {
            ...(current.spec_json as AgentSpec),
            policy: {
              ...(current.spec_json as AgentSpec).policy,
              detach_on_terminal: false,
            },
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
      Database.effect(() => {
        Bus.publish(CollabEvent.AgentCreated, { info })
        Bus.publish(CollabEvent.AgentReparented, {
          info,
          oldParentAgentId: current.parent_agent_id,
          newParentAgentId: input.parentId,
          oldRootAgentId: current.root_agent_id,
          newRootAgentId: input.rootId,
        })
      })
      log.info("attached", { id: input.id, parent: input.parentId, root: input.rootId })
      return info
    })
  }

  export function lease(input: {
    agentId: string
    parentAgentId: string
    prompt: string
    model?: { providerID: string; modelID: string }
    runId?: string
  }): AgentInfo {
    const run = input.runId ?? randomUUID()
    if (!run) throw new Error("Lease run id must not be empty")
    const now = Date.now()

    return Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.agentId)).get()
      if (!current) throw new NotFoundError({ message: `Agent not found: ${input.agentId}` })
      const parent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.parentAgentId)).get()
      if (!parent) throw new NotFoundError({ message: `Parent agent not found: ${input.parentAgentId}` })
      const deleting = tx
        .select({ id: SessionDeletionTable.session_id })
        .from(SessionDeletionTable)
        .where(eq(SessionDeletionTable.session_id, parent.session_id))
        .get()
      if (deleting) throw new Error(`Parent session ${parent.session_id} is being deleted`)
      const existing = tx
        .select({ id: CollabMessageTable.id })
        .from(CollabMessageTable)
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, input.agentId),
            eq(CollabMessageTable.kind, "user_input"),
            eq(CollabMessageTable.run_id, run),
          ),
        )
        .limit(1)
        .get()
      if (existing) {
        if (current.parent_agent_id === parent.id && current.run_id === run) return fromRow(current)
        throw new Error(`Agent ${input.agentId} run ${run} is no longer active`)
      }
      if (current.parent_agent_id) throw new Error(`Agent ${input.agentId} is already parented`)
      if (current.root_agent_id !== current.id) throw new Error(`Agent ${input.agentId} is not an independent root`)
      if (!isActive(parent.status)) throw new Error(`Parent ${input.parentAgentId} is not active`)
      if (parent.project_id !== current.project_id) throw new Error(`Agent ${input.agentId} project mismatch`)

      const tree = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.root_agent_id, current.id)).all()
      if (tree.some((item) => item.id === parent.id)) throw new Error(`Leasing ${input.agentId} would create a cycle`)
      if (tree.some((item) => item.id !== current.id && isActive(item.status))) {
        throw new Error(`Agent ${input.agentId} branch has active descendants`)
      }

      tx.update(CollabAgentTable)
        .set({ root_agent_id: parent.root_agent_id, time_updated: now })
        .where(
          inArray(
            CollabAgentTable.id,
            tree.map((item) => item.id),
          ),
        )
        .run()
      const row = tx
        .update(CollabAgentTable)
        .set({
          parent_agent_id: parent.id,
          root_agent_id: parent.root_agent_id,
          run_id: run,
          status: "running",
          phase: "main_loop",
          spec_json: {
            ...(current.spec_json as AgentSpec),
            policy: {
              ...(current.spec_json as AgentSpec).policy,
              detach_on_terminal: true,
            },
          },
          error_json: null,
          time_started: now,
          time_ended: null,
          time_updated: now,
        })
        .where(eq(CollabAgentTable.id, current.id))
        .returning()
        .get()
      if (!row) throw new NotFoundError({ message: `Agent not found: ${input.agentId}` })

      tx.update(CollabAgentTable)
        .set({
          active_children: sql`${CollabAgentTable.active_children} + 1`,
          spawned_total: sql`${CollabAgentTable.spawned_total} + 1`,
          time_updated: now,
        })
        .where(eq(CollabAgentTable.id, parent.id))
        .run()

      const message = Identifier.ascending("collab_msg")
      tx.insert(CollabMessageTable)
        .values({
          id: message,
          recipient_agent_id: current.id,
          sender_agent_id: null,
          run_id: run,
          kind: "user_input",
          payload_json: { text: input.prompt, model: input.model, messageId: Identifier.ascending("message") },
          status: "pending",
          time_created: now,
          time_updated: now,
          time_consumed: null,
        })
        .run()

      const info = fromRow(row)
      Database.effect(() => {
        Bus.publish(CollabEvent.AgentReparented, {
          info,
          oldParentAgentId: null,
          newParentAgentId: parent.id,
          oldRootAgentId: current.root_agent_id,
          newRootAgentId: parent.root_agent_id,
        })
        Bus.publish(CollabEvent.AgentStatus, {
          agentId: info.id,
          rootAgentId: info.root_agent_id,
          status: info.status,
          phase: info.phase,
          active_children: info.active_children,
        })
        Bus.publish(CollabEvent.MessagePosted, {
          messageId: message,
          recipientAgentId: info.id,
          senderAgentId: null,
          kind: "user_input",
        })
      })
      log.info("leased", { id: info.id, parent: parent.id, root: parent.root_agent_id, run })
      return info
    })
  }

  export function release(id: string): AgentInfo {
    const now = Date.now()
    return Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get()
      if (!current) throw new NotFoundError({ message: `Agent not found: ${id}` })
      if (!current.parent_agent_id) return fromRow(current)
      if (isActive(current.status)) throw new Error(`Cannot release active agent ${id}`)

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
        .set({ root_agent_id: current.id, time_updated: now })
        .where(inArray(CollabAgentTable.id, [...ids]))
        .run()
      const row = tx
        .update(CollabAgentTable)
        .set({
          parent_agent_id: null,
          root_agent_id: current.id,
          run_id: null,
          status: "running",
          phase: "main_loop",
          spec_json: {
            ...(current.spec_json as AgentSpec),
            policy: {
              ...(current.spec_json as AgentSpec).policy,
              detach_on_terminal: false,
            },
          },
          error_json: null,
          time_started: now,
          time_ended: null,
          time_updated: now,
        })
        .where(eq(CollabAgentTable.id, id))
        .returning()
        .get()
      if (!row) throw new NotFoundError({ message: `Agent not found: ${id}` })

      const info = fromRow(row)
      Database.effect(() => {
        Bus.publish(CollabEvent.AgentReparented, {
          info,
          oldParentAgentId: current.parent_agent_id,
          newParentAgentId: null,
          oldRootAgentId: current.root_agent_id,
          newRootAgentId: current.id,
        })
        Bus.publish(CollabEvent.AgentStatus, {
          agentId: info.id,
          rootAgentId: info.root_agent_id,
          status: info.status,
          phase: info.phase,
          active_children: info.active_children,
        })
      })
      log.info("released", { id, parent: current.parent_agent_id, root: current.id })
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

  export function detach(id: string): AgentInfo | undefined {
    return Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get()
      if (!current?.parent_agent_id) return
      const now = Date.now()
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
        .set({ root_agent_id: current.id, time_updated: now })
        .where(inArray(CollabAgentTable.id, [...ids]))
        .run()
      const row = tx
        .update(CollabAgentTable)
        .set({
          parent_agent_id: null,
          root_agent_id: current.id,
          run_id: null,
          spec_json: {
            ...(current.spec_json as AgentSpec),
            policy: {
              ...(current.spec_json as AgentSpec).policy,
              detach_on_terminal: false,
            },
          },
          time_updated: now,
        })
        .where(eq(CollabAgentTable.id, current.id))
        .returning()
        .get()
      if (!row) throw new NotFoundError({ message: `Agent not found: ${id}` })
      if (isActive(current.status)) {
        tx.update(CollabAgentTable)
          .set({
            active_children: sql`max(${CollabAgentTable.active_children} - 1, 0)`,
            time_updated: now,
          })
          .where(eq(CollabAgentTable.id, current.parent_agent_id))
          .run()
      }
      const info = fromRow(row)
      Database.effect(() =>
        Bus.publish(CollabEvent.AgentReparented, {
          info,
          oldParentAgentId: current.parent_agent_id,
          newParentAgentId: null,
          oldRootAgentId: current.root_agent_id,
          newRootAgentId: current.id,
        }),
      )
      log.info("detached", { id, parent: current.parent_agent_id, root: current.id })
      return info
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
