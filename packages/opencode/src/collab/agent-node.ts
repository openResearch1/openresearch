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
import type {
  AgentError,
  AgentInfo,
  AgentResult,
  AgentSpec,
  CollabAgentPhase,
  CollabAgentStatus,
  RunInitiator,
} from "./types"
import { CollabEvent } from "./events"

export namespace CollabAgentNode {
  const log = Log.create({ service: "collab.agent-node" })
  export const STOP_TIMEOUT = 15_000
  export const CONTROLLER_ROLES = ["controller", "research_main", "atom", "experiment", "leaf"] as const
  export type ControllerRole = (typeof CONTROLLER_ROLES)[number]

  export type Row = typeof CollabAgentTable.$inferSelect

  const ACTIVE_STATUSES: CollabAgentStatus[] = ["pending", "running", "blocked_on_children", "waiting_interaction"]

  function renew(spec: AgentSpec) {
    return {
      ...spec,
      metadata: { ...spec.metadata, collabLifecycle: randomUUID() },
    }
  }

  function stored(spec: AgentSpec) {
    const value = spec.metadata?.controllerRole
    return CONTROLLER_ROLES.find((item) => item === value)
  }

  function controller(row: Row) {
    return row.subagent_type === "controller" && !row.parent_agent_id && row.root_agent_id === row.id
  }

  function atom(row: Pick<Row, "subagent_type" | "spec_json">) {
    return row.subagent_type === "research" && typeof (row.spec_json as AgentSpec).metadata?.atomId === "string"
  }

  function experiment(row: Pick<Row, "subagent_type" | "spec_json">) {
    const metadata = (row.spec_json as AgentSpec).metadata
    return row.subagent_type === "experiment" && typeof metadata?.atomId === "string" && typeof metadata.expId === "string"
  }

  function infer(row: Row, root: Row): ControllerRole {
    const role = stored(row.spec_json as AgentSpec)
    if (role) return role
    if (row.id === root.id) return "controller"
    if (experiment(row)) return "experiment"
    if (atom(row)) return "atom"
    if (row.parent_agent_id === root.id && row.subagent_type === "research") return "research_main"
    return "leaf"
  }

  export function tag(spec: AgentSpec, role: ControllerRole): AgentSpec {
    return {
      ...spec,
      metadata: { ...spec.metadata, controllerRole: role },
    }
  }

  export function role(id: string) {
    return Database.use((db) => {
      const row = db.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get()
      if (!row) throw new NotFoundError({ message: `Agent not found: ${id}` })
      const root = db.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, row.root_agent_id)).get()
      if (!root || !controller(root)) return
      return infer(row, root)
    })
  }

  export function spawnContext(sessionId: string) {
    return Database.use((db) => {
      const seen = new Set<string>()
      let id: string | null = sessionId
      let task = false
      while (id && !seen.has(id)) {
        seen.add(id)
        const session = db.select().from(SessionTable).where(eq(SessionTable.id, id)).get()
        if (!session) break
        const row = db.select().from(CollabAgentTable).where(eq(CollabAgentTable.session_id, id)).get()
        if (row) {
          const root = db.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, row.root_agent_id)).get()
          if (root && controller(root)) {
            if (task || session.parent_id) return { controller: true as const, role: "task" as const, allowed: false }
            const role = infer(row, root)
            return {
              controller: true as const,
              role,
              allowed: role !== "leaf",
            }
          }
        }
        task = true
        id = session.parent_id
      }
      return { controller: false as const, allowed: true }
    })
  }

  export function canSpawn(sessionId: string) {
    return spawnContext(sessionId).allowed
  }

  export function assertSpawn(sessionId: string, type: string) {
    const context = spawnContext(sessionId)
    if (!context.controller) return
    if (context.role === "task") {
      throw new Error("Controller spawn denied: task subagents cannot spawn agents")
    }
    if (context.role === "leaf") {
      throw new Error("Controller spawn denied: agents created by spawn_agent cannot spawn additional agents")
    }
    if (context.role === "controller" && type !== "research") {
      throw new Error("Controller spawn denied: Controller may only spawn research agents")
    }
  }

  export function lifecycle(spec: AgentSpec) {
    const value = spec.metadata?.collabLifecycle
    return typeof value === "string" ? value : undefined
  }

  export function ensureLifecycle(id: string) {
    const row = Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get()
      if (!current) throw new NotFoundError({ message: `Agent not found: ${id}` })
      const spec = current.spec_json as AgentSpec
      if (current.parent_agent_id || lifecycle(spec)) return current
      const updated = tx
        .update(CollabAgentTable)
        .set({ spec_json: renew(spec), time_updated: Date.now() })
        .where(
          and(
            eq(CollabAgentTable.id, id),
            isNull(CollabAgentTable.parent_agent_id),
            eq(CollabAgentTable.time_updated, current.time_updated),
          ),
        )
        .returning()
        .get()
      if (updated) return updated
      const fresh = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get()
      if (!fresh) throw new NotFoundError({ message: `Agent not found: ${id}` })
      return fresh
    })
    const info = fromRow(row)
    if (!info.parent_agent_id && !lifecycle(info.spec)) return ensureLifecycle(id)
    return info
  }

  function terminating(error: AgentError | null) {
    return !!error && error.code !== "MODEL_UNAVAILABLE"
  }

  export function fromRow(row: Row): AgentInfo {
    return {
      id: row.id,
      session_id: row.session_id,
      parent_agent_id: row.parent_agent_id,
      name: row.name,
      project_id: row.project_id,
      root_agent_id: row.root_agent_id,
      run_id: row.run_id,
      initiator: row.initiator,
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
    initiator?: RunInitiator
    startParent?: "human"
    activeParent?: boolean
    parentGeneration?: number
  }

  export function create(input: CreateInput): AgentInfo {
    const now = Date.now()
    const parentId = input.parentAgentId ?? null
    const status = input.status ?? "pending"
    const run = parentId && isActive(status) ? randomUUID() : null
    const initiator = isActive(status) ? (input.initiator ?? "agent") : null
    const spec = parentId ? input.spec : renew(input.spec)

    return Database.transaction((tx) => {
      // Serialize creators across processes through the authoritative session row.
      tx.update(SessionTable)
        .set({ time_updated: sql`${SessionTable.time_updated}` })
        .where(eq(SessionTable.id, input.sessionId))
        .run()
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.session_id, input.sessionId)).get()
      if (current) return fromRow(current)
      const parent = parentId
        ? tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, parentId)).get()
        : undefined
      if (parentId && input.activeParent) {
        if (!parent || (!isActive(parent.status) && input.startParent !== "human")) {
          throw new Error(`Parent agent ${parentId} is not active`)
        }
        if ((parent.spec_json as AgentSpec).metadata?.stoppedByUser === true) {
          throw new Error(`Parent agent ${parentId} was stopped by the user`)
        }
        if (terminating(parent.error_json)) throw new Error(`Parent agent ${parentId} is terminating`)
        if (generation(parent.spec_json as AgentSpec) !== input.parentGeneration) {
          throw new Error(`Parent agent ${parentId} changed before child creation`)
        }
        if (parent.root_agent_id !== input.rootAgentId || parent.project_id !== input.projectId) {
          throw new Error(`Parent agent ${parentId} changed before child creation`)
        }
      }
      const saved = (() => {
        if (!parent) return spec
        const root = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, parent.root_agent_id)).get()
        if (!root || !controller(root)) return spec
        const role = infer(parent, root)
        if (!isActive(status)) {
          const row = { subagent_type: input.subagentType, spec_json: spec }
          if (role === "atom" && experiment(row)) return tag(spec, "experiment")
          throw new Error("Controller topology denied: only Experiment domain nodes may be created inactive")
        }
        if (role === "leaf") {
          throw new Error("Controller spawn denied: agents created by spawn_agent cannot spawn additional agents")
        }
        if (role === "controller" && input.subagentType !== "research") {
          throw new Error("Controller spawn denied: Controller may only spawn research agents")
        }
        return tag(spec, role === "controller" ? "research_main" : "leaf")
      })()

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
          initiator,
          subagent_type: input.subagentType,
          status,
          phase: "main_loop",
          spec_json: saved as any,
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

      const promoted =
        input.startParent === "human"
          ? (() => {
              if (!parentId || !isActive(status)) {
                throw new Error("Human promotion requires an active child and parent")
              }
              const parent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, parentId)).get()
              if (!parent?.parent_agent_id) throw new Error(`Parent agent ${parentId} cannot start a human run`)
              if (parent.root_agent_id !== input.rootAgentId || parent.project_id !== input.projectId) {
                throw new Error(`Parent agent ${parentId} changed before the human run started`)
              }
              const owner = tx
                .select({ id: SessionOwnershipTable.session_id })
                .from(SessionOwnershipTable)
                .where(
                  and(
                    eq(SessionOwnershipTable.session_id, parent.session_id),
                    eq(SessionOwnershipTable.owner, "human"),
                    gt(SessionOwnershipTable.expires_at, now),
                  ),
                )
                .get()
              if (!owner) throw new Error(`Parent agent ${parentId} is not owned by a human turn`)
              const ancestor = tx
                .select({ status: CollabAgentTable.status })
                .from(CollabAgentTable)
                .where(eq(CollabAgentTable.id, parent.parent_agent_id))
                .get()
              if (!ancestor || !isActive(ancestor.status)) {
                throw new Error(`Parent agent ${parentId} has no active Atom`)
              }
              if (isActive(parent.status)) {
                if (parent.initiator === "human") return parent
                throw new Error(`Parent agent ${parentId} cannot start a human run`)
              }
              if (parent.active_children > 0) throw new Error(`Parent agent ${parentId} cannot start a human run`)
              tx.update(CollabAgentTable)
                .set({
                  status: "running",
                  run_id: randomUUID(),
                  initiator: "human",
                  phase: "main_loop",
                  error_json: null,
                  time_started: now,
                  time_ended: null,
                  time_updated: now,
                })
                .where(eq(CollabAgentTable.id, parentId))
                .run()
              return tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, parentId)).get()
            })()
          : undefined

      if (parentId) {
        tx.update(CollabAgentTable)
          .set({
            active_children: sql`${CollabAgentTable.active_children} + ${isActive(status) && initiator !== "human" ? 1 : 0}`,
            spawned_total: sql`${CollabAgentTable.spawned_total} + 1`,
            time_updated: now,
          })
          .where(eq(CollabAgentTable.id, parentId))
          .run()
      }

      const row = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.id)).get()
      if (!row) throw new NotFoundError({ message: `Agent not inserted: ${input.id}` })
      const info = fromRow(row)
      const promotedRow = promoted
        ? tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, promoted.id)).get()
        : undefined

      Database.effect(() => {
        if (promotedRow) {
          Bus.publish(CollabEvent.AgentStatus, {
            agentId: promotedRow.id,
            rootAgentId: promotedRow.root_agent_id,
            status: promotedRow.status,
            phase: promotedRow.phase,
            active_children: promotedRow.active_children,
            initiator: promotedRow.initiator,
          })
        }
        Bus.publish(CollabEvent.AgentCreated, { info })
      })
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

  export function isStopped(node: AgentInfo) {
    return node.status === "canceled" && node.spec.metadata?.stoppedByUser === true
  }

  export function generation(spec: AgentSpec) {
    const value = spec.metadata?.collabGeneration
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
  }

  function clearStop(spec: AgentSpec) {
    return {
      ...spec,
      metadata: Object.fromEntries(
        Object.entries(spec.metadata ?? {}).filter(
          ([key]) =>
            key !== "stoppedByUser" && key !== "stopReady" && key !== "stopToken" && key !== "stopClaimedAt",
        ),
      ),
    }
  }

  export function stop(agentId: string, expected?: number) {
    const now = Date.now()
    const token = randomUUID()
    const result = Database.transaction((tx) => {
      const root = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, agentId)).get()
      if (!root) throw new NotFoundError({ message: `Agent not found: ${agentId}` })
      if (root.parent_agent_id || root.root_agent_id !== root.id) {
        throw new Error(`Agent ${agentId} is not a Collab root`)
      }
      const spec = root.spec_json as AgentSpec
      const stopped = spec.metadata?.stoppedByUser === true
      const claimed = spec.metadata?.stopClaimedAt
      if (expected === undefined && stopped) {
        return {
          root,
          rows: [],
          valid: false,
          generation: generation(spec),
          token: typeof spec.metadata?.stopToken === "string" ? spec.metadata.stopToken : "",
        }
      }
      if (
        expected !== undefined &&
        (root.status !== "canceled" ||
          !stopped ||
          spec.metadata?.stopReady === true ||
          generation(spec) !== expected ||
          (typeof claimed === "number" && claimed + STOP_TIMEOUT > now))
      ) {
        return {
          root,
          rows: [],
          valid: false,
          generation: expected,
          token: typeof spec.metadata?.stopToken === "string" ? spec.metadata.stopToken : "",
        }
      }
      const version = stopped ? generation(spec) : generation(spec) + 1

      const tree = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.root_agent_id, root.id)).all()
      const ids = new Set([root.id])
      let changed = true
      while (changed) {
        changed = false
        for (const item of tree) {
          if (!item.parent_agent_id || !ids.has(item.parent_agent_id) || ids.has(item.id)) continue
          if (item.initiator === "human") continue
          ids.add(item.id)
          changed = true
        }
      }
      if (
        !isActive(root.status) &&
        !(root.status === "canceled" && spec.metadata?.stoppedByUser === true) &&
        !tree.some((item) => ids.has(item.id) && isActive(item.status))
      ) {
        throw new Error(`Agent ${agentId} is not active`)
      }

      const rows = tree.flatMap((item) => {
        if (!ids.has(item.id)) return []
        const current = item.spec_json as AgentSpec
        const active = item.id === root.id || isActive(item.status)
        const next = {
          ...current,
          metadata: {
            ...current.metadata,
            stoppedByUser: true,
            collabGeneration: item.id === root.id ? version : generation(current) + 1,
            ...(item.id === root.id ? { stopReady: false, stopToken: token, stopClaimedAt: now } : {}),
          },
        }
        const children = tree.filter(
          (child) =>
            child.parent_agent_id === item.id &&
            !ids.has(child.id) &&
            child.initiator !== "human" &&
            isActive(child.status),
        ).length
        const row = tx
          .update(CollabAgentTable)
          .set({
            status: active ? "canceled" : item.status,
            spec_json: next,
            result_json: active ? null : item.result_json,
            error_json: active ? { code: "CANCELED", message: "Controller stopped by user" } : item.error_json,
            active_children: children,
            time_ended: active ? now : item.time_ended,
            time_updated: now,
          })
          .where(eq(CollabAgentTable.id, item.id))
          .returning()
          .get()
        return row ? [row] : []
      })

      tx.update(CollabMessageTable)
        .set({ status: "dropped", claim_id: null, time_updated: now })
        .where(
          and(
            inArray(CollabMessageTable.recipient_agent_id, [...ids]),
            inArray(CollabMessageTable.status, ["pending", "processing"]),
          ),
        )
        .run()

      return {
        root: rows.find((item) => item.id === root.id) ?? root,
        rows,
        valid: true,
        generation: version,
        token,
      }
    })
    const rows = result.rows.map(fromRow)
    Database.effect(() => {
      for (const info of rows) {
        Bus.publish(CollabEvent.AgentStatus, {
          agentId: info.id,
          rootAgentId: info.root_agent_id,
          status: info.status,
          phase: info.phase,
          active_children: info.active_children,
          initiator: info.initiator,
        })
      }
    })
    log.info("stopped", { id: agentId, count: rows.length })
    return {
      root: fromRow(result.root),
      agents: rows,
      valid: result.valid,
      generation: result.generation,
      token: result.token,
    }
  }

  export function claimed(agentId: string, generation: number, token: string) {
    const node = tryLoad(agentId)
    return (
      !!node &&
      isStopped(node) &&
      CollabAgentNode.generation(node.spec) === generation &&
      node.spec.metadata?.stopToken === token
    )
  }

  export function ready(agentId: string, generation: number, token: string) {
    const row = Database.use((db) => {
      const current = db.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, agentId)).get()
      if (!current) throw new NotFoundError({ message: `Agent not found: ${agentId}` })
      const spec = current.spec_json as AgentSpec
      if (
        current.status !== "canceled" ||
        spec.metadata?.stoppedByUser !== true ||
        CollabAgentNode.generation(spec) !== generation ||
        spec.metadata.stopToken !== token
      )
        return current
      return db
        .update(CollabAgentTable)
        .set({
          spec_json: { ...spec, metadata: { ...spec.metadata, stopReady: true } },
          time_updated: Date.now(),
        })
        .where(eq(CollabAgentTable.id, current.id))
        .returning()
        .get()!
    })
    return fromRow(row)
  }

  export function restart(agentId: string) {
    const now = Date.now()
    const row = Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, agentId)).get()
      if (!current) throw new NotFoundError({ message: `Agent not found: ${agentId}` })
      const spec = current.spec_json as AgentSpec
      if (current.parent_agent_id || current.root_agent_id !== current.id || spec.metadata?.stoppedByUser !== true) {
        return current
      }
      if (spec.metadata.stopReady !== true) throw new Error(`Controller ${agentId} is still stopping`)
      const active = tx
        .select({ id: CollabAgentTable.id })
        .from(CollabAgentTable)
        .where(
          and(
            eq(CollabAgentTable.parent_agent_id, current.id),
            inArray(CollabAgentTable.status, ACTIVE_STATUSES),
            ne(CollabAgentTable.initiator, "human"),
          ),
        )
        .all().length
      tx.update(CollabMessageTable)
        .set({ status: "dropped", claim_id: null, time_updated: now })
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, current.id),
            inArray(CollabMessageTable.status, ["pending", "processing"]),
          ),
        )
        .run()
      return tx
        .update(CollabAgentTable)
        .set({
          status: "running",
          initiator: "human",
          phase: "main_loop",
          spec_json: renew(clearStop(spec)),
          result_json: null,
          error_json: null,
          active_children: active,
          time_started: now,
          time_ended: null,
          time_updated: now,
        })
        .where(eq(CollabAgentTable.id, current.id))
        .returning()
        .get()!
    })
    const info = fromRow(row)
    if (!isActive(info.status)) return info
    Database.effect(() =>
      Bus.publish(CollabEvent.AgentStatus, {
        agentId: info.id,
        rootAgentId: info.root_agent_id,
        status: info.status,
        phase: info.phase,
        active_children: info.active_children,
        initiator: info.initiator,
      }),
    )
    log.info("restarted", { id: agentId })
    return info
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
    expected?: {
      runId: string | null
      parentId: string | null
      status?: CollabAgentStatus
      timeUpdated?: number
      error?: null
    },
  ): AgentInfo {
    const now = Date.now()
    const row = Database.use((db) => {
      const updates: Partial<typeof CollabAgentTable.$inferInsert> = {
        status,
        time_updated: now,
      }
      if (!isActive(status)) updates.active_children = 0
      if (status === "idle") updates.run_id = null
      if (status === "idle") updates.initiator = null
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
            expected?.timeUpdated ? eq(CollabAgentTable.time_updated, expected.timeUpdated) : undefined,
            expected?.error === null ? isNull(CollabAgentTable.error_json) : undefined,
            isActive(status) ? inArray(CollabAgentTable.status, ACTIVE_STATUSES) : undefined,
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
        initiator: info.initiator,
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

      const pending = tx
        .select({ id: CollabMessageTable.id })
        .from(CollabMessageTable)
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, current.id),
            eq(CollabMessageTable.status, "pending"),
            inArray(CollabMessageTable.kind, [
              "child_done",
              "child_failed",
              "child_waiting",
              "remote_task_terminal",
              "cancel",
              "user_input",
            ]),
          ),
        )
        .limit(1)
        .get()
      if (pending) return

      const human = current.initiator === "human"
      const row = tx
        .update(CollabAgentTable)
        .set({
          status: human ? "idle" : input.status,
          run_id: human ? null : current.run_id,
          initiator: human ? null : current.initiator,
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
            input.status === "completed" ? isNull(CollabAgentTable.error_json) : undefined,
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
      const parent = input.parentId
        ? tx.select({ status: CollabAgentTable.status }).from(CollabAgentTable).where(eq(CollabAgentTable.id, input.parentId)).get()
        : undefined
      if (!human && input.parentId && input.report && parent && isActive(parent.status)) {
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
          initiator: info.initiator,
        })
        if (!message || !input.parentId || !input.report) return
        Bus.publish(CollabEvent.MessagePosted, {
          messageId: message,
          recipientAgentId: input.parentId,
          senderAgentId: input.id,
          kind: input.report.kind,
        })
      })
      log.info("finished", { id: input.id, status: info.status, run: input.runId })
      return info
    })
  }

  export function activate(
    id: string,
    expected?: { runId: string | null; parentId: string | null },
    initiator: RunInitiator = "agent",
  ): AgentInfo {
    const now = Date.now()
    return Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get()
      if (!current) throw new NotFoundError({ message: `Agent not found: ${id}` })
      if (expected && (current.run_id !== expected.runId || current.parent_agent_id !== expected.parentId)) {
        throw new Error(`Agent ${id} ownership changed before activation`)
      }
      if (isActive(current.status)) return fromRow(current)
      if ((current.spec_json as AgentSpec).metadata?.stoppedByUser === true) {
        throw new Error(`Agent ${id} was stopped by the user`)
      }
      if (current.parent_agent_id) {
        const parent = tx
          .select()
          .from(CollabAgentTable)
          .where(eq(CollabAgentTable.id, current.parent_agent_id))
          .get()
        if (!parent || !isActive(parent.status) || terminating(parent.error_json)) {
          throw new Error(`Parent agent ${current.parent_agent_id} is not available`)
        }
        if ((parent.spec_json as AgentSpec).metadata?.stoppedByUser === true) {
          throw new Error(`Parent agent ${current.parent_agent_id} was stopped by the user`)
        }
      }

      const row = tx
        .update(CollabAgentTable)
        .set({
          status: "running",
          run_id: current.parent_agent_id ? randomUUID() : null,
          initiator,
          phase: "main_loop",
          spec_json: current.parent_agent_id ? current.spec_json : renew(current.spec_json as AgentSpec),
          error_json: null,
          time_ended: null,
          time_started: now,
          time_updated: now,
        })
        .where(eq(CollabAgentTable.id, id))
        .returning()
        .get()
      if (!row) throw new NotFoundError({ message: `Agent not found: ${id}` })

      if (current.parent_agent_id && initiator === "agent") {
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
          initiator: info.initiator,
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
    const row = Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get()
      if (!current) throw new NotFoundError({ message: `Agent not found: ${id}` })
      const prior = current.spec_json as AgentSpec
      const root = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, current.root_agent_id)).get()
      const role = stored(prior) ?? (root && controller(root) ? infer(current, root) : undefined)
      const metadata = Object.fromEntries(
        Object.entries(spec.metadata ?? {}).filter(
          ([key]) =>
            key !== "stoppedByUser" &&
            key !== "stopReady" &&
            key !== "stopToken" &&
            key !== "stopClaimedAt" &&
            key !== "collabGeneration" &&
            key !== "collabLifecycle" &&
            key !== "controllerRole",
        ),
      )
      const next = {
        ...spec,
        metadata: {
          ...metadata,
          ...(typeof prior.metadata?.collabGeneration === "number"
            ? { collabGeneration: generation(prior) }
            : {}),
          ...(prior.metadata?.stoppedByUser === true ? { stoppedByUser: true } : {}),
          ...(prior.metadata?.stopReady === true ? { stopReady: true } : {}),
          ...(typeof prior.metadata?.stopToken === "string" ? { stopToken: prior.metadata.stopToken } : {}),
          ...(typeof prior.metadata?.stopClaimedAt === "number"
            ? { stopClaimedAt: prior.metadata.stopClaimedAt }
            : {}),
          ...(lifecycle(prior) ? { collabLifecycle: lifecycle(prior) } : {}),
          ...(role ? { controllerRole: role } : {}),
        },
      }
      return tx
        .update(CollabAgentTable)
        .set({ spec_json: next, time_updated: Date.now() })
        .where(eq(CollabAgentTable.id, id))
        .returning()
        .get()!
    })
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
      if (current.initiator === "human" && isActive(current.status)) {
        throw new Error(`Cannot attach agent ${input.id}: its current run belongs to a human session`)
      }
      const owner = tx
        .select({ id: SessionOwnershipTable.session_id })
        .from(SessionOwnershipTable)
        .where(
          and(
            eq(SessionOwnershipTable.session_id, current.session_id),
            eq(SessionOwnershipTable.owner, "human"),
            gt(SessionOwnershipTable.expires_at, now),
          ),
        )
        .get()
      if (owner) throw new Error(`Cannot attach agent ${input.id}: its session is owned by a human turn`)
      const parent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.parentId)).get()
      if (!parent) throw new NotFoundError({ message: `Parent agent not found: ${input.parentId}` })
      if (parent.root_agent_id !== input.rootId)
        throw new Error(`Parent ${input.parentId} is not in root ${input.rootId}`)
      if (parent.project_id !== current.project_id) throw new Error(`Agent ${input.id} project mismatch`)
      if (!isActive(parent.status) || terminating(parent.error_json)) {
        throw new Error(`Parent ${input.parentId} is not available`)
      }
      if ((parent.spec_json as AgentSpec).metadata?.stoppedByUser === true) {
        throw new Error(`Parent ${input.parentId} was stopped by the user`)
      }
      const root = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, parent.root_agent_id)).get()
      const metadata = { ...(current.spec_json as AgentSpec).metadata, ...input.metadata }
      if (
        root &&
        controller(root) &&
        (infer(parent, root) !== "atom" ||
          input.subagentType !== "experiment" ||
          typeof metadata.atomId !== "string" ||
          typeof metadata.expId !== "string")
      ) {
        throw new Error("Controller topology denied: only Experiments may attach to Atom agents")
      }
      if (current.parent_agent_id === input.parentId && current.root_agent_id === input.rootId) return fromRow(current)
      const next = {
        ...clearStop(current.spec_json as AgentSpec),
        policy: {
          ...(current.spec_json as AgentSpec).policy,
          detach_on_terminal: false,
        },
        metadata,
      }
      const saved = root && controller(root) ? tag(next, "experiment") : next

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
          initiator: null,
          name: input.name,
          subagent_type: input.subagentType,
          status: "idle",
          phase: "main_loop",
          spec_json: saved,
          time_updated: now,
        })
        .where(eq(CollabAgentTable.id, input.id))
        .returning()
        .get()
      if (!row) throw new NotFoundError({ message: `Agent not found: ${input.id}` })

      if (current.parent_agent_id && isActive(current.status) && current.initiator !== "human") {
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
    parentGeneration?: number
  }): AgentInfo {
    const run = input.runId ?? randomUUID()
    if (!run) throw new Error("Lease run id must not be empty")
    const now = Date.now()

    return Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.agentId)).get()
      if (!current) throw new NotFoundError({ message: `Agent not found: ${input.agentId}` })
      const parent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.parentAgentId)).get()
      if (!parent) throw new NotFoundError({ message: `Parent agent not found: ${input.parentAgentId}` })
      const root = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, parent.root_agent_id)).get()
      if (root && controller(root) && (infer(parent, root) !== "research_main" || !atom(current))) {
        throw new Error("Controller topology denied: only Research Main may lease Atom agents")
      }
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
      if (terminating(parent.error_json)) throw new Error(`Parent ${input.parentAgentId} is terminating`)
      if ((parent.spec_json as AgentSpec).metadata?.stoppedByUser === true) {
        throw new Error(`Parent ${input.parentAgentId} was stopped by the user`)
      }
      if (
        input.parentGeneration !== undefined &&
        generation(parent.spec_json as AgentSpec) !== input.parentGeneration
      ) {
        throw new Error(`Parent ${input.parentAgentId} changed before lease`)
      }
      if (parent.project_id !== current.project_id) throw new Error(`Agent ${input.agentId} project mismatch`)

      const tree = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.root_agent_id, current.id)).all()
      if (tree.some((item) => item.id === parent.id)) throw new Error(`Leasing ${input.agentId} would create a cycle`)
      if (tree.some((item) => item.id !== current.id && isActive(item.status))) {
        throw new Error(`Agent ${input.agentId} branch has active descendants`)
      }
      const next = {
        ...clearStop(current.spec_json as AgentSpec),
        policy: {
          ...(current.spec_json as AgentSpec).policy,
          detach_on_terminal: true,
        },
      }
      const saved = root && controller(root) ? tag(next, "atom") : next

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
          initiator: "agent",
          status: "running",
          phase: "main_loop",
          spec_json: saved,
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
          initiator: info.initiator,
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
          initiator: "agent",
          status: "running",
          phase: "main_loop",
          spec_json: renew({
            ...clearStop(current.spec_json as AgentSpec),
            policy: {
              ...(current.spec_json as AgentSpec).policy,
              detach_on_terminal: false,
            },
          }),
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
          initiator: info.initiator,
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
      if (current.parent_agent_id && isActive(current.status) && current.initiator !== "human" && !reported) {
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
          initiator: isActive(current.status) ? "agent" : null,
          spec_json: renew({
            ...(current.spec_json as AgentSpec),
            policy: {
              ...(current.spec_json as AgentSpec).policy,
              detach_on_terminal: false,
            },
          }),
          time_updated: now,
        })
        .where(eq(CollabAgentTable.id, current.id))
        .returning()
        .get()
      if (!row) throw new NotFoundError({ message: `Agent not found: ${id}` })
      if (isActive(current.status) && current.initiator !== "human") {
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
        initiator: info.initiator,
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
    const active = children.filter((c) => ACTIVE_STATUSES.includes(c.status) && c.initiator !== "human").length
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
