import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { Bus } from "@/bus"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { CollabAgentTable, CollabMessageTable } from "./collab.sql"
import type { CollabMsgKind } from "./types"
import { WAKE_MESSAGE_KINDS } from "./types"
import { CollabEvent } from "./events"

export namespace CollabMessage {
  const log = Log.create({ service: "collab.message" })

  const DRAIN_BATCH = 64

  const CHILD_TERMINAL_KINDS = new Set<CollabMsgKind>(["child_done", "child_failed"])

  export type Row = typeof CollabMessageTable.$inferSelect

  export type PostInput = {
    recipientAgentId: string
    senderAgentId?: string | null
    kind: CollabMsgKind
    payload: unknown
  }

  export async function post(input: PostInput): Promise<string> {
    const id = Identifier.ascending("collab_msg")
    const now = Date.now()

    Database.transaction((tx) => {
      tx.insert(CollabMessageTable)
        .values({
          id,
          recipient_agent_id: input.recipientAgentId,
          sender_agent_id: input.senderAgentId ?? null,
          kind: input.kind,
          payload_json: input.payload as any,
          status: "pending",
          time_created: now,
          time_updated: now,
          time_consumed: null,
        })
        .run()

      if (CHILD_TERMINAL_KINDS.has(input.kind)) {
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
    })

    log.info("posted", { id, recipient: input.recipientAgentId, kind: input.kind })
    return id
  }

  export function drain(agentId: string): Row[] {
    const consumedAt = Date.now()

    return Database.transaction((tx) => {
      const rows = tx
        .select()
        .from(CollabMessageTable)
        .where(and(eq(CollabMessageTable.recipient_agent_id, agentId), eq(CollabMessageTable.status, "pending")))
        .orderBy(asc(CollabMessageTable.id))
        .limit(DRAIN_BATCH)
        .all()

      if (rows.length === 0) return rows

      tx.update(CollabMessageTable)
        .set({ status: "consumed", time_consumed: consumedAt, time_updated: consumedAt })
        .where(
          inArray(
            CollabMessageTable.id,
            rows.map((r) => r.id),
          ),
        )
        .run()

      Database.effect(() => {
        for (const row of rows) {
          Bus.publish(CollabEvent.MessageConsumed, {
            messageId: row.id,
            recipientAgentId: row.recipient_agent_id,
            kind: row.kind,
          })
        }
      })

      return rows
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
        .set({ status: "dropped", time_updated: now })
        .where(and(eq(CollabMessageTable.recipient_agent_id, agentId), eq(CollabMessageTable.status, "pending")))
        .run()
    })
  }

  export function list(agentId: string, opts?: { kind?: CollabMsgKind; limit?: number }) {
    const limit = opts?.limit ?? 200
    return Database.use((db) => {
      const where = opts?.kind
        ? and(eq(CollabMessageTable.recipient_agent_id, agentId), eq(CollabMessageTable.kind, opts.kind))
        : eq(CollabMessageTable.recipient_agent_id, agentId)
      return db.select().from(CollabMessageTable).where(where).orderBy(asc(CollabMessageTable.id)).limit(limit).all()
    })
  }
}
