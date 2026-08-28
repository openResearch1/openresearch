import { createHash, randomUUID } from "crypto"

import { and, asc, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { Bus } from "@/bus"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { CollabAgentTable, CollabMessageTable } from "./collab.sql"
import type { ChildWaitingPayload, CollabMsgKind, UserInputPayload } from "./types"
import { DIRECT_MESSAGE_KINDS, WAKE_MESSAGE_KINDS } from "./types"
import { CollabEvent } from "./events"

export namespace CollabMessage {
  const log = Log.create({ service: "collab.message" })

  const DRAIN_BATCH = 64

  const CHILD_TERMINAL_KINDS = new Set<CollabMsgKind>(["child_done", "child_failed"])
  const CHILD_REPORT_KINDS = new Set<CollabMsgKind>(["child_done", "child_failed", "child_waiting", "child_progress"])
  const ACTIVE_AGENT_STATUSES = new Set(["pending", "running", "blocked_on_children", "waiting_interaction"])

  export function isDirectKind(kind: string): kind is CollabMsgKind {
    return (DIRECT_MESSAGE_KINDS as readonly string[]).includes(kind)
  }

  export type Row = typeof CollabMessageTable.$inferSelect
  export type Claim = Pick<Row, "id" | "claim_id">

  function cancelID(recipient: string, run: string | null, spec: unknown, started: number | null, created: number) {
    const metadata = (spec as { metadata?: Record<string, unknown> }).metadata
    const root = typeof metadata?.collabLifecycle === "string" ? metadata.collabLifecycle : String(started ?? created)
    const hash = createHash("sha256")
      .update(`${recipient}\0${run ?? root}`)
      .digest("hex")
      .slice(0, 26)
    return `cmg_${hash}`
  }

  export type PostInput = {
    recipientAgentId: string
    senderAgentId?: string | null
    runId?: string | null
    expectedParentAgentId?: string | null
    expectedRunId?: string | null
    expectedErrorCode?: string | null
    expectedLifecycle?: string
    kind: CollabMsgKind
    payload: unknown
  }

  export function post(input: PostInput): string | undefined {
    const generated = Identifier.ascending("collab_msg")
    const now = Date.now()

    const result = Database.transaction((tx) => {
      const guarded =
        input.expectedParentAgentId !== undefined ||
        input.expectedRunId !== undefined ||
        input.expectedErrorCode !== undefined ||
        input.expectedLifecycle !== undefined ||
        CHILD_REPORT_KINDS.has(input.kind) ||
        input.kind === "cancel" ||
        isDirectKind(input.kind)
      const recipient = guarded
        ? tx
            .select({
              parent: CollabAgentTable.parent_agent_id,
              run: CollabAgentTable.run_id,
              error: CollabAgentTable.error_json,
              status: CollabAgentTable.status,
              spec: CollabAgentTable.spec_json,
              activeChildren: CollabAgentTable.active_children,
              started: CollabAgentTable.time_started,
              created: CollabAgentTable.time_created,
            })
            .from(CollabAgentTable)
            .where(eq(CollabAgentTable.id, input.recipientAgentId))
            .get()
        : undefined
      const sender =
        CHILD_REPORT_KINDS.has(input.kind) && input.senderAgentId
          ? tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.senderAgentId)).get()
          : undefined
      if (
        sender &&
        ((sender.spec_json as { metadata?: { stoppedByUser?: unknown } }).metadata?.stoppedByUser === true)
      ) {
        return { id: undefined, inserted: false }
      }
      const value =
        typeof input.payload === "object" && input.payload !== null && "runId" in input.payload
          ? (input.payload as { runId?: unknown }).runId
          : undefined
      const run =
        input.runId !== undefined
          ? input.runId
          : input.kind === "cancel"
            ? (recipient?.run ?? null)
            : typeof value === "string"
              ? value
              : (sender?.run_id ?? null)
      const id =
        input.kind === "cancel" && recipient
          ? cancelID(input.recipientAgentId, run, recipient.spec, recipient.started, recipient.created)
          : generated

      if (
        guarded &&
        (!recipient ||
          (input.expectedParentAgentId !== undefined && recipient.parent !== input.expectedParentAgentId) ||
          (input.expectedRunId !== undefined && recipient.run !== input.expectedRunId) ||
          (input.expectedErrorCode === null && recipient.error !== null) ||
          (typeof input.expectedErrorCode === "string" && recipient.error?.code !== input.expectedErrorCode) ||
          (input.expectedLifecycle !== undefined &&
            (recipient.spec as { metadata?: Record<string, unknown> }).metadata?.collabLifecycle !==
              input.expectedLifecycle))
      ) {
        return { id: undefined, inserted: false }
      }

      if (input.kind === "cancel" && recipient) {
        const existing = tx.select().from(CollabMessageTable).where(eq(CollabMessageTable.id, id)).get()
        if (existing) {
          if (
            existing.recipient_agent_id !== input.recipientAgentId ||
            existing.kind !== input.kind ||
            existing.run_id !== run
          ) {
            throw new Error(`Cancel message id collision: ${id}`)
          }
          if (
            ACTIVE_AGENT_STATUSES.has(recipient.status) &&
            recipient.activeChildren === 0 &&
            (existing.status === "dropped" || existing.status === "consumed")
          ) {
            tx.update(CollabMessageTable)
              .set({ status: "pending", claim_id: null, time_consumed: null, time_updated: now })
              .where(eq(CollabMessageTable.id, existing.id))
              .run()
            Database.effect(() =>
              Bus.publish(CollabEvent.MessagePosted, {
                messageId: existing.id,
                recipientAgentId: existing.recipient_agent_id,
                senderAgentId: existing.sender_agent_id,
                kind: existing.kind,
              }),
            )
            return { id: existing.id, inserted: true }
          }
          return { id: existing.id, inserted: false }
        }
      }

      if (guarded) {
        if (
          ((CHILD_REPORT_KINDS.has(input.kind) || input.kind === "cancel") &&
            !ACTIVE_AGENT_STATUSES.has(recipient!.status)) ||
          (isDirectKind(input.kind) &&
            (recipient!.spec as { metadata?: { stoppedByUser?: unknown } }).metadata?.stoppedByUser === true)
        )
          return { id: undefined, inserted: false }
      }
      const base =
        run && CHILD_REPORT_KINDS.has(input.kind) && typeof input.payload === "object" && input.payload !== null
          ? { ...input.payload, runId: run }
          : input.kind === "user_input" && typeof input.payload === "object" && input.payload !== null
            ? {
                ...input.payload,
                messageId:
                  "messageId" in input.payload && typeof input.payload.messageId === "string"
                    ? input.payload.messageId
                    : Identifier.ascending("message"),
              }
            : input.payload
      const payload =
        typeof base === "object" &&
        base !== null &&
        (CHILD_REPORT_KINDS.has(input.kind) ||
          input.kind === "remote_task_terminal" ||
          input.kind === "session_remote_task_terminal" ||
          input.kind === "scheduled_task_due" ||
          input.kind === "session_scheduled_task_due")
          ? {
              ...base,
              deliveryMessageId:
                "deliveryMessageId" in base && typeof base.deliveryMessageId === "string"
                  ? base.deliveryMessageId
                  : Identifier.ascending("message"),
            }
          : base

      if (CHILD_TERMINAL_KINDS.has(input.kind) && input.senderAgentId) {
        const existing = tx
          .select({ id: CollabMessageTable.id })
          .from(CollabMessageTable)
          .where(
            and(
              eq(CollabMessageTable.recipient_agent_id, input.recipientAgentId),
              eq(CollabMessageTable.sender_agent_id, input.senderAgentId),
              run ? eq(CollabMessageTable.run_id, run) : isNull(CollabMessageTable.run_id),
              inArray(CollabMessageTable.kind, ["child_done", "child_failed"]),
              run ? undefined : gte(CollabMessageTable.time_created, sender?.time_started ?? sender?.time_created ?? 0),
            ),
          )
          .limit(1)
          .get()
        if (existing) return { id: existing.id, inserted: false }
      }

      if (
        CHILD_REPORT_KINDS.has(input.kind) &&
        (!sender || sender.parent_agent_id !== input.recipientAgentId || sender.run_id !== run)
      ) {
        return { id: undefined, inserted: false }
      }

      const inserted = tx
        .insert(CollabMessageTable)
        .values({
          id,
          recipient_agent_id: input.recipientAgentId,
          sender_agent_id: input.senderAgentId ?? null,
          run_id: run,
          kind: input.kind,
          payload_json: payload as any,
          status: "pending",
          time_created: now,
          time_updated: now,
          time_consumed: null,
        })
        .onConflictDoNothing()
        .returning({ id: CollabMessageTable.id })
        .get()

      if (!inserted) {
        const duplicate = tx.select().from(CollabMessageTable).where(eq(CollabMessageTable.id, id)).get()
        if (duplicate) {
          if (
            duplicate.recipient_agent_id !== input.recipientAgentId ||
            duplicate.kind !== input.kind ||
            duplicate.run_id !== run
          ) {
            throw new Error(`Message id collision: ${id}`)
          }
          return { id: duplicate.id, inserted: false }
        }
        const existing = tx
          .select({ id: CollabMessageTable.id })
          .from(CollabMessageTable)
          .where(
            and(
              eq(CollabMessageTable.recipient_agent_id, input.recipientAgentId),
              input.senderAgentId
                ? eq(CollabMessageTable.sender_agent_id, input.senderAgentId)
                : isNull(CollabMessageTable.sender_agent_id),
              run ? eq(CollabMessageTable.run_id, run) : isNull(CollabMessageTable.run_id),
              inArray(CollabMessageTable.kind, ["child_done", "child_failed"]),
              run ? undefined : gte(CollabMessageTable.time_created, sender?.time_started ?? sender?.time_created ?? 0),
            ),
          )
          .limit(1)
          .get()
        if (!existing) throw new Error(`Message ${id} was not inserted`)
        return { id: existing.id, inserted: false }
      }

      if (
        CHILD_TERMINAL_KINDS.has(input.kind) &&
        sender?.parent_agent_id === input.recipientAgentId &&
        sender.run_id === run
      ) {
        tx.update(CollabAgentTable)
          .set({
            active_children: sql`max(${CollabAgentTable.active_children} - 1, 0)`,
            time_updated: now,
          })
          .where(eq(CollabAgentTable.id, input.recipientAgentId))
          .run()
      }

      Database.effect(() =>
        Bus.publish(CollabEvent.MessagePosted, {
          messageId: id,
          recipientAgentId: input.recipientAgentId,
          senderAgentId: input.senderAgentId ?? null,
          kind: input.kind,
        }),
      )
      return { id, inserted: true }
    })

    log.info(result.inserted ? "posted" : result.id ? "duplicate" : "dropped", {
      id: result.id ?? generated,
      recipient: input.recipientAgentId,
      kind: input.kind,
    })
    return result.id
  }

  export async function postChildWaiting(input: {
    agentId: string
    rootAgentId: string
    recipientAgentId: string
    payload: ChildWaitingPayload
  }): Promise<string | undefined> {
    const id = Identifier.ascending("collab_msg")
    const now = Date.now()

    const posted = Database.transaction((tx) => {
      const current = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.agentId)).get()
      const run = input.payload.runId ?? current?.run_id ?? null
      const parent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, input.recipientAgentId)).get()
      if (
        !current ||
        !parent ||
        !ACTIVE_AGENT_STATUSES.has(current.status) ||
        !ACTIVE_AGENT_STATUSES.has(parent.status) ||
        (current.spec_json as { metadata?: { stoppedByUser?: unknown } }).metadata?.stoppedByUser === true ||
        current.parent_agent_id !== input.recipientAgentId ||
        current.run_id !== run
      )
        return false

      const updated = tx
        .update(CollabAgentTable)
        .set({
          status: "waiting_interaction",
          phase: "awaiting_children",
          time_updated: now,
        })
        .where(
          and(
            eq(CollabAgentTable.id, input.agentId),
            eq(CollabAgentTable.parent_agent_id, input.recipientAgentId),
            run ? eq(CollabAgentTable.run_id, run) : isNull(CollabAgentTable.run_id),
            eq(CollabAgentTable.status, current.status),
          ),
        )
        .returning()
        .get()
      if (!updated) throw new Error(`Agent not found: ${input.agentId}`)
      const payload = {
        ...input.payload,
        ...(updated.run_id ? { runId: updated.run_id } : {}),
        deliveryMessageId: Identifier.ascending("message"),
      }

      tx.insert(CollabMessageTable)
        .values({
          id,
          recipient_agent_id: input.recipientAgentId,
          sender_agent_id: input.agentId,
          run_id: updated.run_id,
          kind: "child_waiting",
          payload_json: payload as any,
          status: "pending",
          time_created: now,
          time_updated: now,
          time_consumed: null,
        })
        .run()

      Database.effect(() => {
        Bus.publish(CollabEvent.AgentStatus, {
          agentId: input.agentId,
          rootAgentId: input.rootAgentId,
          status: "waiting_interaction",
          phase: "awaiting_children",
          active_children: updated.active_children,
          initiator: updated.initiator,
        })
        Bus.publish(CollabEvent.MessagePosted, {
          messageId: id,
          recipientAgentId: input.recipientAgentId,
          senderAgentId: input.agentId,
          kind: "child_waiting",
        })
      })
      return true
    })

    if (!posted) {
      log.info("dropped child_waiting", { recipient: input.recipientAgentId, sender: input.agentId })
      return
    }
    log.info("posted child_waiting", { id, recipient: input.recipientAgentId, sender: input.agentId })
    return id
  }

  export function drain(agentId: string, mode: "collab" | "direct" = "collab"): Row[] {
    const claimedAt = Date.now()
    const claim = randomUUID()

    return Database.transaction((tx) => {
      const cancel =
        mode === "collab"
          ? tx
              .select()
              .from(CollabMessageTable)
              .where(
                and(
                  eq(CollabMessageTable.recipient_agent_id, agentId),
                  eq(CollabMessageTable.status, "pending"),
                  eq(CollabMessageTable.kind, "cancel"),
                ),
              )
              .orderBy(asc(CollabMessageTable.id))
              .limit(1)
              .get()
          : undefined
      const wake =
        mode === "collab" && !cancel
          ? tx
              .select()
              .from(CollabMessageTable)
              .where(
                and(
                  eq(CollabMessageTable.recipient_agent_id, agentId),
                  eq(CollabMessageTable.status, "pending"),
                  inArray(CollabMessageTable.kind, [...WAKE_MESSAGE_KINDS]),
                ),
              )
              .orderBy(asc(CollabMessageTable.id))
              .limit(1)
              .get()
          : undefined
      const found = cancel || (mode === "collab" && !wake)
        ? []
        : tx
            .select()
            .from(CollabMessageTable)
            .where(
              and(
                eq(CollabMessageTable.recipient_agent_id, agentId),
                eq(CollabMessageTable.status, "pending"),
                mode === "direct"
                  ? inArray(CollabMessageTable.kind, [...DIRECT_MESSAGE_KINDS])
                  : notInArray(CollabMessageTable.kind, [...DIRECT_MESSAGE_KINDS]),
              ),
            )
            .orderBy(asc(CollabMessageTable.id))
            .limit(DRAIN_BATCH)
            .all()
      const batch = wake && !found.some((row) => row.id === wake.id) ? [...found.slice(0, DRAIN_BATCH - 1), wake] : found
      const user = mode === "collab" ? batch.findIndex((row) => row.kind === "user_input") : -1
      const rows = cancel ? [cancel] : user < 0 ? batch : batch.slice(0, user + 1)

      if (rows.length === 0) return rows

      tx.update(CollabMessageTable)
        .set({ status: "processing", claim_id: claim, time_consumed: null, time_updated: claimedAt })
        .where(
          inArray(
            CollabMessageTable.id,
            rows.map((r) => r.id),
          ),
        )
        .run()

      return rows.map((row) => ({
        ...row,
        status: "processing" as const,
        claim_id: claim,
        time_updated: claimedAt,
      }))
    })
  }

  export function ack(claims: Claim[]) {
    if (!claims.length) return
    const now = Date.now()
    Database.transaction((tx) => {
      const rows = claims.flatMap((claim) => {
        if (!claim.claim_id) return []
        return tx
          .update(CollabMessageTable)
          .set({ status: "consumed", claim_id: null, time_consumed: now, time_updated: now })
          .where(
            and(
              eq(CollabMessageTable.id, claim.id),
              eq(CollabMessageTable.status, "processing"),
              eq(CollabMessageTable.claim_id, claim.claim_id),
            ),
          )
          .returning()
          .all()
      })
      if (!rows.length) return
      Database.effect(() => {
        for (const row of rows) {
          Bus.publish(CollabEvent.MessageConsumed, {
            messageId: row.id,
            recipientAgentId: row.recipient_agent_id,
            kind: row.kind,
          })
        }
      })
    })
  }

  export function redeliver(claims: Claim[], messageId: string, failed = true) {
    if (!claims.length) return false
    const now = Date.now()
    return Database.transaction((tx) => {
      const rows = claims.flatMap((claim) => {
        if (!claim.claim_id) return []
        const row = tx
          .select({ kind: CollabMessageTable.kind, payload: CollabMessageTable.payload_json })
          .from(CollabMessageTable)
          .where(
            and(
              eq(CollabMessageTable.id, claim.id),
              eq(CollabMessageTable.status, "processing"),
              eq(CollabMessageTable.claim_id, claim.claim_id),
            ),
          )
          .get()
        if (!row || typeof row.payload !== "object" || row.payload === null) return []
        return [
          {
            id: claim.id,
            claimId: claim.claim_id,
            kind: row.kind,
            payload: row.payload as Record<string, unknown>,
          },
        ]
      })
      if (rows.length !== claims.length) return false
      const updated = rows.flatMap((row) => {
        const stale = row.kind === "user_input" ? row.payload.messageId : row.payload.deliveryMessageId
        const payload =
          row.kind === "user_input"
            ? {
                ...row.payload,
                messageId,
                deliveryAttempts:
                  (typeof row.payload.deliveryAttempts === "number" ? row.payload.deliveryAttempts : 0) +
                  (failed ? 1 : 0),
                ...(typeof stale === "string" ? { staleDeliveryMessageId: stale } : {}),
              }
            : {
                ...row.payload,
                deliveryMessageId: messageId,
                deliveryAttempts:
                  (typeof row.payload.deliveryAttempts === "number" ? row.payload.deliveryAttempts : 0) +
                  (failed ? 1 : 0),
                ...(typeof stale === "string" ? { staleDeliveryMessageId: stale } : {}),
              }
        return tx
          .update(CollabMessageTable)
          .set({ payload_json: payload, time_updated: now })
          .where(
            and(
              eq(CollabMessageTable.id, row.id),
              eq(CollabMessageTable.status, "processing"),
              eq(CollabMessageTable.claim_id, row.claimId),
            ),
          )
          .returning({ id: CollabMessageTable.id })
          .all()
      })
      return updated.length === claims.length
    })
  }

  export function drop(claims: Claim[]) {
    if (!claims.length) return
    const now = Date.now()
    Database.transaction((tx) => {
      for (const claim of claims) {
        if (!claim.claim_id) continue
        tx.update(CollabMessageTable)
          .set({ status: "dropped", claim_id: null, time_updated: now })
          .where(
            and(
              eq(CollabMessageTable.id, claim.id),
              eq(CollabMessageTable.status, "processing"),
              eq(CollabMessageTable.claim_id, claim.claim_id),
            ),
          )
          .run()
      }
    })
  }

  export function hasPending(agentId: string): boolean {
    return Database.use((db) => {
      const row = db
        .select({ id: CollabMessageTable.id })
        .from(CollabMessageTable)
        .where(and(eq(CollabMessageTable.recipient_agent_id, agentId), eq(CollabMessageTable.status, "pending")))
        .limit(1)
        .get()
      return !!row
    })
  }

  export function hasOutstanding(agentId: string, kind?: CollabMsgKind): boolean {
    return Database.use((db) => {
      const row = db
        .select({ id: CollabMessageTable.id })
        .from(CollabMessageTable)
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, agentId),
            inArray(CollabMessageTable.status, ["pending", "processing"]),
            kind ? eq(CollabMessageTable.kind, kind) : undefined,
          ),
        )
        .limit(1)
        .get()
      return !!row
    })
  }

  export function hasOutstandingCollab(agentId: string): boolean {
    return Database.use((db) => {
      const row = db
        .select({ id: CollabMessageTable.id })
        .from(CollabMessageTable)
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, agentId),
            inArray(CollabMessageTable.status, ["pending", "processing"]),
            notInArray(CollabMessageTable.kind, [...DIRECT_MESSAGE_KINDS]),
          ),
        )
        .limit(1)
        .get()
      return !!row
    })
  }

  export function findRemoteTerminal(agentId: string, taskId: string, since: number) {
    return Database.use((db) =>
      db
        .select({ id: CollabMessageTable.id, payload: CollabMessageTable.payload_json })
        .from(CollabMessageTable)
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, agentId),
            inArray(CollabMessageTable.kind, ["remote_task_terminal", "session_remote_task_terminal"]),
            gte(CollabMessageTable.time_created, since),
          ),
        )
        .all()
        .find(
          (row) =>
            typeof row.payload === "object" &&
            row.payload !== null &&
            "taskId" in row.payload &&
            row.payload.taskId === taskId,
        ),
    )
  }

  export function reconcileCallbacks(agentId: string) {
    const rows = Database.transaction((tx) => {
      const agent = tx.select().from(CollabAgentTable).where(eq(CollabAgentTable.id, agentId)).get()
      if (!agent) return []
      const found = tx
        .select()
        .from(CollabMessageTable)
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, agentId),
            inArray(CollabMessageTable.kind, ["remote_task_terminal", "scheduled_task_due"]),
            inArray(CollabMessageTable.status, ["pending", "processing"]),
          ),
        )
        .all()
        .filter(
          (row) =>
            !["pending", "running", "blocked_on_children", "waiting_interaction"].includes(agent.status) ||
            (!!agent.parent_agent_id && (!row.run_id || row.run_id !== agent.run_id)),
        )
      if (!found.length) return found
      const now = Date.now()
      const repaired = found.flatMap((row) =>
        tx
          .update(CollabMessageTable)
          .set({
            kind: row.kind === "remote_task_terminal" ? "session_remote_task_terminal" : "session_scheduled_task_due",
            run_id: null,
            status: "pending",
            claim_id: null,
            time_consumed: null,
            time_updated: now,
          })
          .where(eq(CollabMessageTable.id, row.id))
          .returning()
          .all(),
      )
      Database.effect(() => {
        for (const row of repaired) {
          Bus.publish(CollabEvent.MessagePosted, {
            messageId: row.id,
            recipientAgentId: row.recipient_agent_id,
            senderAgentId: row.sender_agent_id,
            kind: row.kind,
          })
        }
      })
      return repaired
    })
    if (rows.length) log.info("reconciled callback messages", { agentId, count: rows.length })
    return rows.length
  }

  export function hasOutstandingWakeMsg(agentId: string): boolean {
    return Database.use((db) => {
      const row = db
        .select({ id: CollabMessageTable.id })
        .from(CollabMessageTable)
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, agentId),
            inArray(CollabMessageTable.status, ["pending", "processing"]),
            inArray(CollabMessageTable.kind, [...WAKE_MESSAGE_KINDS]),
          ),
        )
        .limit(1)
        .get()
      return !!row
    })
  }

  export function hasPendingWakeMsg(agentId: string): boolean {
    return Database.use((db) => {
      const row = db
        .select({ id: CollabMessageTable.id })
        .from(CollabMessageTable)
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, agentId),
            eq(CollabMessageTable.status, "pending"),
            inArray(CollabMessageTable.kind, [...WAKE_MESSAGE_KINDS]),
          ),
        )
        .limit(1)
        .get()
      return !!row
    })
  }

  export function hasPendingKind(agentId: string, kind: CollabMsgKind): boolean {
    return Database.use((db) => {
      const row = db
        .select({ id: CollabMessageTable.id })
        .from(CollabMessageTable)
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, agentId),
            eq(CollabMessageTable.status, "pending"),
            eq(CollabMessageTable.kind, kind),
          ),
        )
        .limit(1)
        .get()
      return !!row
    })
  }

  export function hasOutstandingDirect(agentId: string): boolean {
    return Database.use((db) => {
      const row = db
        .select({ id: CollabMessageTable.id })
        .from(CollabMessageTable)
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, agentId),
            inArray(CollabMessageTable.status, ["pending", "processing"]),
            inArray(CollabMessageTable.kind, [...DIRECT_MESSAGE_KINDS]),
          ),
        )
        .limit(1)
        .get()
      return !!row
    })
  }

  export function hasPendingDirect(agentId: string): boolean {
    return Database.use((db) => {
      const row = db
        .select({ id: CollabMessageTable.id })
        .from(CollabMessageTable)
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, agentId),
            eq(CollabMessageTable.status, "pending"),
            inArray(CollabMessageTable.kind, [...DIRECT_MESSAGE_KINDS]),
          ),
        )
        .limit(1)
        .get()
      return !!row
    })
  }

  export function direct(projectId: string) {
    return Database.use((db) =>
      db
        .selectDistinct({ agentId: CollabMessageTable.recipient_agent_id })
        .from(CollabMessageTable)
        .innerJoin(CollabAgentTable, eq(CollabAgentTable.id, CollabMessageTable.recipient_agent_id))
        .where(
          and(
            eq(CollabAgentTable.project_id, projectId),
            inArray(CollabMessageTable.status, ["pending", "processing"]),
            inArray(CollabMessageTable.kind, [...DIRECT_MESSAGE_KINDS]),
          ),
        )
        .all(),
    )
  }

  export function pendingWakeKinds(agentId: string): Set<CollabMsgKind> {
    return Database.use((db) => {
      const rows = db
        .selectDistinct({ kind: CollabMessageTable.kind })
        .from(CollabMessageTable)
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, agentId),
            eq(CollabMessageTable.status, "pending"),
            inArray(CollabMessageTable.kind, [...WAKE_MESSAGE_KINDS]),
          ),
        )
        .all()
      return new Set(rows.map((r) => r.kind))
    })
  }

  export function closeInbox(agentId: string) {
    const now = Date.now()
    Database.use((db) => {
      db.update(CollabMessageTable)
        .set({ status: "dropped", claim_id: null, time_updated: now })
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, agentId),
            inArray(CollabMessageTable.status, ["pending", "processing"]),
            notInArray(CollabMessageTable.kind, [...DIRECT_MESSAGE_KINDS]),
          ),
        )
        .run()
    })
  }

  export function dropPending(agentId: string) {
    const now = Date.now()
    Database.use((db) => {
      db.update(CollabMessageTable)
        .set({ status: "dropped", claim_id: null, time_updated: now })
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, agentId),
            eq(CollabMessageTable.status, "pending"),
            notInArray(CollabMessageTable.kind, [...DIRECT_MESSAGE_KINDS]),
          ),
        )
        .run()
    })
  }

  export function retry(claims: Claim[], wake = true) {
    if (!claims.length) return
    const now = Date.now()
    return Database.transaction((tx) => {
      const rows = claims.flatMap((claim) => {
        if (!claim.claim_id) return []
        return tx
          .update(CollabMessageTable)
          .set({ status: "pending", claim_id: null, time_consumed: null, time_updated: now })
          .where(
            and(
              eq(CollabMessageTable.id, claim.id),
              eq(CollabMessageTable.status, "processing"),
              eq(CollabMessageTable.claim_id, claim.claim_id),
            ),
          )
          .returning()
          .all()
      })
      if (!rows.length) return
      if (!wake) return
      Database.effect(() => {
        setTimeout(() => {
          for (const row of rows) {
            Bus.publish(CollabEvent.MessagePosted, {
              messageId: row.id,
              recipientAgentId: row.recipient_agent_id,
              senderAgentId: row.sender_agent_id,
              kind: row.kind,
            })
          }
        }, 0)
      })
    })
  }

  export function retryProcessing(agentId: string) {
    const claims = Database.use((db) =>
      db
        .select({ id: CollabMessageTable.id, claim_id: CollabMessageTable.claim_id })
        .from(CollabMessageTable)
        .where(and(eq(CollabMessageTable.recipient_agent_id, agentId), eq(CollabMessageTable.status, "processing")))
        .all(),
    )
    return retry(claims)
  }

  export function resumeInput(
    agentId: string,
    runId: string | null,
    text: string,
    model?: { providerID: string; modelID: string },
  ) {
    const now = Date.now()
    return Database.transaction((tx) => {
      const row = tx
        .select()
        .from(CollabMessageTable)
        .where(
          and(
            eq(CollabMessageTable.recipient_agent_id, agentId),
            runId ? eq(CollabMessageTable.run_id, runId) : isNull(CollabMessageTable.run_id),
            eq(CollabMessageTable.kind, "user_input"),
            inArray(CollabMessageTable.status, ["pending", "processing"]),
          ),
        )
        .orderBy(asc(CollabMessageTable.time_created), asc(CollabMessageTable.id))
        .limit(1)
        .get()
      if (!row) return false
      const payload = row.payload_json as UserInputPayload
      tx.update(CollabMessageTable)
        .set({
          payload_json: {
            ...payload,
            text: `${payload.text}\n\nParent follow-up: ${text}`,
            model: model ?? payload.model,
            messageId: Identifier.ascending("message"),
          },
          status: "pending",
          claim_id: null,
          time_consumed: null,
          time_updated: now,
        })
        .where(eq(CollabMessageTable.id, row.id))
        .run()
      Database.effect(() =>
        Bus.publish(CollabEvent.MessagePosted, {
          messageId: row.id,
          recipientAgentId: row.recipient_agent_id,
          senderAgentId: row.sender_agent_id,
          kind: row.kind,
        }),
      )
      return true
    })
  }

  export function ackProcessing(agentId: string) {
    const claims = Database.use((db) =>
      db
        .select({ id: CollabMessageTable.id, claim_id: CollabMessageTable.claim_id })
        .from(CollabMessageTable)
        .where(and(eq(CollabMessageTable.recipient_agent_id, agentId), eq(CollabMessageTable.status, "processing")))
        .all(),
    )
    ack(claims)
  }

  export function listRun(agentId: string, runId: string) {
    return Database.use((db) =>
      db
        .select()
        .from(CollabMessageTable)
        .where(and(eq(CollabMessageTable.recipient_agent_id, agentId), eq(CollabMessageTable.run_id, runId)))
        .orderBy(asc(CollabMessageTable.id))
        .all(),
    )
  }

  export function list(agentId: string, opts?: { kind?: CollabMsgKind; limit?: number }) {
    const limit = opts?.limit ?? 200
    return Database.use((db) => {
      const where = opts?.kind
        ? and(eq(CollabMessageTable.recipient_agent_id, agentId), eq(CollabMessageTable.kind, opts.kind))
        : eq(CollabMessageTable.recipient_agent_id, agentId)
      return db
        .select()
        .from(CollabMessageTable)
        .where(where)
        .orderBy(asc(CollabMessageTable.time_created), asc(CollabMessageTable.id))
        .limit(limit)
        .all()
    })
  }
}
