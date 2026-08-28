import { randomUUID } from "crypto"

import { and, asc, eq, gt, gte, inArray, isNull, ne, notInArray, sql } from "drizzle-orm"
import { Database, NotFoundError } from "@/storage/db"
import { Bus } from "@/bus"
import { Identifier } from "@/id/id"
import { SessionTable } from "@/session/session.sql"
import { SessionDeletionTable } from "@/session/deletion.sql"
import { SessionOwnershipTable } from "@/session/ownership.sql"
import { Log } from "@/util/log"
import { RemoteTaskListenerTable } from "@/research/remote-task-listener.sql"
import { ScheduledTaskTable } from "@/scheduler/scheduled-task.sql"
import { CollabAgentTable, CollabMessageTable } from "./collab.sql"
import { ControllerPolicy } from "./controller-policy"
import type {
  AgentError,
  AgentInfo,
  AgentResult,
  AgentSpec,
  CollabAgentPhase,
  CollabAgentStatus,
  RunInitiator,
} from "./types"
import { DIRECT_MESSAGE_KINDS, WAKE_MESSAGE_KINDS } from "./types"
import { CollabEvent } from "./events"

export namespace CollabAgentNode {
  const log = Log.create({ service: "collab.agent-node" })
  export const STOP_TIMEOUT = 15_000
  export const CONTROLLER_ROLES = ControllerPolicy.Roles
  export type ControllerRole = ControllerPolicy.Role

  export type Row = typeof CollabAgentTable.$inferSelect

  const ACTIVE_STATUSES: CollabAgentStatus[] = ["pending", "running", "blocked_on_children", "waiting_interaction"]

  function renew(spec: AgentSpec) {
    return {
      ...spec,
      metadata: { ...spec.metadata, collabLifecycle: randomUUID() },
    }
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

  export function isExperiment(node: Pick<AgentInfo, "subagent_type" | "spec">) {
    return (
      node.subagent_type === "experiment" &&
      typeof node.spec.metadata?.atomId === "string" &&
      typeof node.spec.metadata.expId === "string"
    )
  }

  function structural(rows: Row[], row: Row, root: Row): ControllerRole | "blocked" {
    if (row.id === root.id) return "controller"
    const index = new Map(rows.map((item) => [item.id, item]))
    const path: Row[] = []
    const seen = new Set<string>()
    let current: Row | undefined = row
    while (current && current.id !== root.id && !seen.has(current.id)) {
      seen.add(current.id)
      path.unshift(current)
      current = current.parent_agent_id ? index.get(current.parent_agent_id) : undefined
    }
    if (current?.id !== root.id) return "blocked"

    let role: ControllerRole | "blocked" = "controller"
    for (const child of path) {
      if (role === "controller") {
        role = child.subagent_type === "research" ? "research_main" : "blocked"
        continue
      }
      if (role === "research_main" && atom(child) && (child.spec_json as AgentSpec).policy?.detach_on_terminal) {
        role = "atom"
        continue
      }
      if (role === "atom" && experiment(child)) {
        role = "experiment"
        continue
      }
      role = ControllerPolicy.allows({ role, channel: "spawn", target: child.subagent_type }) ? "leaf" : "blocked"
    }
    return role
  }

  function context(db: Database.TxOrDb, row: Row) {
    const fallback = () => {
      const root = db.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, row.root_agent_id)).get()
      return root && controller(root) ? { root, role: "blocked" as const } : undefined
    }
    const rows = [row]
    const seen = new Set([row.id])
    let current = row
    while (current.parent_agent_id && !seen.has(current.parent_agent_id)) {
      const parent = db.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, current.parent_agent_id)).get()
      if (!parent) return fallback()
      rows.unshift(parent)
      seen.add(parent.id)
      current = parent
    }
    const root = rows[0]
    if (current.parent_agent_id) return fallback()
    if (!controller(root)) return fallback()
    if (rows.some((item) => item.root_agent_id !== root.id)) {
      return { root, role: "blocked" as const }
    }
    return { root, role: structural(rows, row, root) }
  }

  function topology(rows: Row[], id: string, initial: ControllerRole) {
    const roles = new Map<string, ControllerRole>([[id, initial]])
    const pending = [id]
    while (pending.length) {
      const parent = pending.shift()!
      const role = roles.get(parent)!
      for (const row of rows) {
        if (row.parent_agent_id !== parent || roles.has(row.id)) continue
        const next =
          role === "atom" && experiment(row)
            ? "experiment"
            : ControllerPolicy.allows({ role, channel: "spawn", target: row.subagent_type })
              ? "leaf"
              : undefined
        if (!next) throw new Error(`Controller topology denied: ${role} cannot contain ${row.subagent_type}`)
        roles.set(row.id, next)
        pending.push(row.id)
      }
    }
    if (roles.size !== rows.length) throw new Error("Controller topology denied: imported branch is disconnected")
    return roles
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
      return context(db, row)?.role
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
          const resolved = context(db, row)
          if (resolved) {
            if (resolved.role === "blocked") {
              return { controller: true as const, role: resolved.role, agent: row.subagent_type }
            }
            if (task || session.parent_id) {
              return { controller: true as const, role: "task" as const, agent: undefined }
            }
            return {
              controller: true as const,
              role: resolved.role,
              agent: row.subagent_type,
            }
          }
        }
        task = true
        id = session.parent_id
      }
      return { controller: false as const }
    })
  }

  export function controlled(sessionId: string) {
    const context = spawnContext(sessionId)
    return context.controller && context.role !== "controller"
  }

  export function targets(sessionId: string, channel: ControllerPolicy.Channel) {
    const context = spawnContext(sessionId)
    if (!context.controller) return
    return ControllerPolicy.targets({ role: context.role, channel, agent: context.agent })
  }

  export function allows(sessionId: string, channel: ControllerPolicy.Channel, target: string) {
    const context = spawnContext(sessionId)
    if (!context.controller) return true
    return ControllerPolicy.allows({ role: context.role, channel, target, agent: context.agent })
  }

  export function canSpawn(sessionId: string) {
    const targets = CollabAgentNode.targets(sessionId, "spawn")
    return targets === undefined || targets.length > 0
  }

  export function canTask(sessionId: string) {
    const targets = CollabAgentNode.targets(sessionId, "task")
    return targets === undefined || targets.length > 0
  }

  export function assertSpawn(sessionId: string, type: string) {
    const context = spawnContext(sessionId)
    if (!context.controller) return
    if (ControllerPolicy.allows({ role: context.role, channel: "spawn", target: type, agent: context.agent })) return
    throw new Error(`Controller spawn denied: ${context.role} cannot spawn ${type}`)
  }

  export function assertTask(sessionId: string, type: string) {
    const context = spawnContext(sessionId)
    if (!context.controller) return
    if (ControllerPolicy.allows({ role: context.role, channel: "task", target: type, agent: context.agent })) return
    throw new Error(`Controller task denied: ${context.role} cannot invoke ${type}`)
  }

  export function assertWorkflow(sessionId: string) {
    const context = spawnContext(sessionId)
    if (!context.controller) return
    throw new Error(`Controller workflow denied: workflows are unavailable to ${context.role}`)
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

  function promote(tx: Database.TxOrDb, parent: Row, now: number) {
    if (!parent.parent_agent_id) throw new Error(`Parent agent ${parent.id} cannot start a human run`)
    if ((parent.spec_json as AgentSpec).metadata?.stoppedByUser === true) {
      throw new Error(`Parent agent ${parent.id} was stopped by the user`)
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
    if (!owner) throw new Error(`Parent agent ${parent.id} is not owned by a human turn`)
    const ancestor = tx
      .select({ status: CollabAgentTable.status })
      .from(CollabAgentTable)
      .where(eq(CollabAgentTable.id, parent.parent_agent_id))
      .get()
    const independent = experiment(parent)
    if (!ancestor || (!isActive(ancestor.status) && !independent)) {
      throw new Error(`Parent agent ${parent.id} has no active Atom`)
    }
    if (isActive(parent.status)) {
      if (parent.initiator === "human") return parent
      throw new Error(`Parent agent ${parent.id} cannot start a human run`)
    }
    if (parent.active_children > 0) throw new Error(`Parent agent ${parent.id} cannot start a human run`)
    return tx
      .update(CollabAgentTable)
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
      .where(eq(CollabAgentTable.id, parent.id))
      .returning()
      .get()!
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
      if (parentId && !parent) throw new Error(`Parent agent ${parentId} does not exist`)
      const scope = parent ? context(tx, parent) : undefined
      if (scope?.role === "blocked") throw new Error(`Controller topology denied: parent ${parentId} is blocked`)
      if (parent && (parent.root_agent_id !== input.rootAgentId || parent.project_id !== input.projectId)) {
        throw new Error(`Parent agent ${parentId} does not match the requested root and project`)
      }
      if (parent && input.activeParent) {
        if (!isActive(parent.status) && input.startParent !== "human") {
          throw new Error(`Parent agent ${parentId} is not active`)
        }
        if ((parent.spec_json as AgentSpec).metadata?.stoppedByUser === true) {
          throw new Error(`Parent agent ${parentId} was stopped by the user`)
        }
        if (isActive(parent.status) && terminating(parent.error_json)) {
          throw new Error(`Parent agent ${parentId} is terminating`)
        }
        if (generation(parent.spec_json as AgentSpec) !== input.parentGeneration) {
          throw new Error(`Parent agent ${parentId} changed before child creation`)
        }
      }
      const saved = (() => {
        if (!parent || !scope) return spec
        const role = scope.role
        if (!isActive(status)) {
          const row = { subagent_type: input.subagentType, spec_json: spec }
          if (role === "atom" && experiment(row)) return tag(spec, "experiment")
          throw new Error("Controller topology denied: only Experiment domain nodes may be created inactive")
        }
        if (!ControllerPolicy.allows({ role, channel: "spawn", target: input.subagentType, agent: parent.subagent_type })) {
          throw new Error(`Controller spawn denied: ${role} cannot spawn ${input.subagentType}`)
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
              const independent = experiment(parent) && (parent.spec_json as AgentSpec).metadata?.stoppedByUser !== true
              if (!ancestor || (!isActive(ancestor.status) && !independent)) {
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
            notInArray(CollabMessageTable.kind, [...DIRECT_MESSAGE_KINDS]),
          ),
        )
        .run()

      const exps = tree.filter((item) => ids.has(item.id) && experiment(item)).map((item) => item.id)
      const rest = [...ids].filter((id) => !exps.includes(id))
      if (rest.length) {
        tx.update(CollabMessageTable)
          .set({ status: "dropped", claim_id: null, time_updated: now })
          .where(
            and(
              inArray(CollabMessageTable.recipient_agent_id, rest),
              inArray(CollabMessageTable.status, ["pending", "processing"]),
              inArray(CollabMessageTable.kind, [...DIRECT_MESSAGE_KINDS]),
            ),
          )
          .run()
      }

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

  export function restoreExperiment(id: string) {
    const result = Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get()
      if (!current) throw new NotFoundError({ message: `Agent not found: ${id}` })
      const spec = current.spec_json as AgentSpec
      if (!experiment(current) || spec.metadata?.stoppedByUser !== true) {
        return { row: current, restored: false }
      }
      const root = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, current.root_agent_id)).get()
      const metadata = root ? (root.spec_json as AgentSpec).metadata : undefined
      if (root?.status === "canceled" && metadata?.stoppedByUser === true && metadata.stopReady !== true) {
        return { row: current, restored: false }
      }
      const now = Date.now()
      tx.delete(RemoteTaskListenerTable)
        .where(
          and(
            eq(RemoteTaskListenerTable.agent_id, id),
            eq(RemoteTaskListenerTable.mode, "collab"),
          ),
        )
        .run()
      tx.update(ScheduledTaskTable)
        .set({ status: "canceled", canceled_at: now, time_updated: now })
        .where(
          and(
            eq(ScheduledTaskTable.agent_id, id),
            eq(ScheduledTaskTable.status, "pending"),
            eq(ScheduledTaskTable.mode, "collab"),
          ),
        )
        .run()
      tx.update(CollabMessageTable)
        .set({ status: "dropped", claim_id: null, time_updated: now })
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, id),
            inArray(CollabMessageTable.status, ["pending", "processing"]),
            notInArray(CollabMessageTable.kind, [...DIRECT_MESSAGE_KINDS]),
          ),
        )
        .run()
      const row = tx
        .update(CollabAgentTable)
        .set({
          status: "idle",
          run_id: null,
          initiator: null,
          phase: "main_loop",
          spec_json: clearStop(spec),
          result_json: null,
          error_json: null,
          active_children: 0,
          time_started: null,
          time_ended: null,
          time_updated: now,
        })
        .where(eq(CollabAgentTable.id, id))
        .returning()
        .get()!
      return { row, restored: true }
    })
    const info = fromRow(result.row)
    if (!result.restored) return info
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
    log.info("restored experiment", { id })
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
            inArray(CollabMessageTable.kind, [...WAKE_MESSAGE_KINDS]),
          ),
        )
        .limit(1)
        .get()
      if (pending) return

      const task = tx
        .select({ id: ScheduledTaskTable.id })
        .from(ScheduledTaskTable)
        .where(
          and(
            eq(ScheduledTaskTable.agent_id, current.id),
            eq(ScheduledTaskTable.status, "pending"),
            eq(ScheduledTaskTable.mode, "collab"),
            input.runId ? eq(ScheduledTaskTable.run_id, input.runId) : isNull(ScheduledTaskTable.run_id),
          ),
        )
        .limit(1)
        .get()
      if (task) return

      const human = current.initiator === "human"
      const row = tx
        .update(CollabAgentTable)
        .set({
          status: human ? "idle" : input.status,
          run_id: human ? null : current.run_id,
          initiator: human ? null : current.initiator,
          phase: input.phase,
          result_json: input.result ?? null,
          error_json: human ? null : (input.error ?? null),
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
            notInArray(CollabMessageTable.kind, [...DIRECT_MESSAGE_KINDS]),
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
    expected?: {
      runId: string | null
      parentId: string | null
      generation?: number
      resume?: boolean
      startParent?: "human"
    },
    initiator: RunInitiator = "agent",
  ): AgentInfo {
    const now = Date.now()
    return Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, id)).get()
      if (!current) throw new NotFoundError({ message: `Agent not found: ${id}` })
      const spec = current.spec_json as AgentSpec
      if (
        expected &&
        (current.run_id !== expected.runId ||
          current.parent_agent_id !== expected.parentId ||
          (expected.generation !== undefined && generation(spec) !== expected.generation))
      ) {
        throw new Error(`Agent ${id} ownership changed before activation`)
      }
      if (isActive(current.status)) return fromRow(current)
      const stopped = spec.metadata?.stoppedByUser === true
      if (stopped && (!current.parent_agent_id || expected?.resume !== true)) {
        throw new Error(`Agent ${id} was stopped by the user`)
      }
      let promoted: Row | undefined
      if (current.parent_agent_id) {
        let parent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, current.parent_agent_id)).get()
        if (parent && expected?.startParent === "human") {
          promoted = promote(tx, parent, now)
          parent = promoted
        }
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
          spec_json: current.parent_agent_id ? (stopped ? clearStop(spec) : spec) : renew(spec),
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
        if (promoted) {
          promoted = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, current.parent_agent_id)).get()
        }
      }

      const info = fromRow(row)
      Database.effect(() => {
        if (promoted) {
          const parent = fromRow(promoted)
          Bus.publish(CollabEvent.AgentStatus, {
            agentId: parent.id,
            rootAgentId: parent.root_agent_id,
            status: parent.status,
            phase: parent.phase,
            active_children: parent.active_children,
            initiator: parent.initiator,
          })
        }
        Bus.publish(CollabEvent.AgentStatus, {
          agentId: info.id,
          rootAgentId: info.root_agent_id,
          status: info.status,
          phase: info.phase,
          active_children: info.active_children,
          initiator: info.initiator,
        })
      })
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
      const tree = root
        ? tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.root_agent_id, root.id)).all()
        : []
      const resolved = root && controller(root) ? structural(tree, current, root) : undefined
      const role = resolved && resolved !== "blocked" ? resolved : undefined
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
      const scope = context(tx, parent)
      if (scope?.role === "blocked") throw new Error(`Controller topology denied: parent ${parent.id} is blocked`)
      const metadata = { ...(current.spec_json as AgentSpec).metadata, ...input.metadata }
      if (
        scope &&
        (scope.role !== "atom" ||
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
      const saved = scope ? tag(next, "experiment") : next

      const tree = tx
        .select()
        .from(CollabAgentTable)
        .where(eq(CollabAgentTable.root_agent_id, current.root_agent_id))
        .all()
      const ids = new Set([current.id])
      let changed = true
      while (changed) {
        changed = false
        for (const item of tree) {
          if (!item.parent_agent_id || !ids.has(item.parent_agent_id) || ids.has(item.id)) continue
          ids.add(item.id)
          changed = true
        }
      }
      if (ids.has(parent.id)) throw new Error(`Attaching ${input.id} would create a cycle`)

      const branch = tree.filter((item) => ids.has(item.id))
      const roles = scope ? topology(branch, current.id, "experiment") : undefined
      if (roles) {
        for (const item of branch) {
          tx.update(CollabAgentTable)
            .set({
              root_agent_id: input.rootId,
              spec_json: tag(item.spec_json as AgentSpec, roles.get(item.id)!),
              time_updated: now,
            })
            .where(eq(CollabAgentTable.id, item.id))
            .run()
        }
      } else {
        tx.update(CollabAgentTable)
          .set({ root_agent_id: input.rootId, time_updated: now })
          .where(inArray(CollabAgentTable.id, [...ids]))
          .run()
      }
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
      const scope = context(tx, parent)
      if (scope?.role === "blocked") throw new Error(`Controller topology denied: parent ${parent.id} is blocked`)
      if (scope && (scope.role !== "research_main" || !atom(current))) {
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
      const saved = scope ? tag(next, "atom") : next

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
