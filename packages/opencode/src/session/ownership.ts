import { randomUUID } from "crypto"

import { and, eq, gt, lte } from "drizzle-orm"
import { Instance } from "@/project/instance"
import { Database } from "@/storage/db"
import { SessionOwnershipTable } from "./ownership.sql"

export namespace SessionOwnership {
  export type Owner = "human" | "collab"
  export type Lease = (() => void) & { signal: AbortSignal; token: string; valid: () => boolean }
  type Entry = { timer: ReturnType<typeof setInterval>; token: string; abort: AbortController }

  const TTL = 15_000
  const HEARTBEAT = 1000

  const state = Instance.state(
    () => new Map<string, Entry>(),
    async (leases) => {
      for (const [sessionID, entry] of leases) {
        clearInterval(entry.timer)
        entry.abort.abort()
        Database.use((db) =>
          db
            .delete(SessionOwnershipTable)
            .where(and(eq(SessionOwnershipTable.session_id, sessionID), eq(SessionOwnershipTable.token, entry.token)))
            .run(),
        )
      }
      leases.clear()
    },
  )

  export function available(sessionID: string, _owner: Owner) {
    return Database.transaction((tx) => {
      tx.delete(SessionOwnershipTable)
        .where(and(eq(SessionOwnershipTable.session_id, sessionID), lte(SessionOwnershipTable.expires_at, Date.now())))
        .run()
      return !tx
        .select({ id: SessionOwnershipTable.session_id })
        .from(SessionOwnershipTable)
        .where(eq(SessionOwnershipTable.session_id, sessionID))
        .get()
    })
  }

  export function current(sessionID: string) {
    return Database.use(
      (db) =>
        db
          .select({ owner: SessionOwnershipTable.owner })
          .from(SessionOwnershipTable)
          .where(and(eq(SessionOwnershipTable.session_id, sessionID), gt(SessionOwnershipTable.expires_at, Date.now())))
          .get()?.owner,
    )
  }

  export function claim(sessionID: string, owner: Owner) {
    const token = randomUUID()
    const now = Date.now()
    const claimed = Database.transaction((tx) => {
      tx.delete(SessionOwnershipTable)
        .where(and(eq(SessionOwnershipTable.session_id, sessionID), lte(SessionOwnershipTable.expires_at, now)))
        .run()
      return tx
        .insert(SessionOwnershipTable)
        .values({
          session_id: sessionID,
          owner,
          token,
          expires_at: now + TTL,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .returning({ id: SessionOwnershipTable.session_id })
        .get()
    })
    if (!claimed) return

    const leases = state()
    const prior = leases.get(sessionID)
    if (prior) {
      clearInterval(prior.timer)
      prior.abort.abort()
    }
    const abort = new AbortController()
    const timer = setInterval(() => {
      const next = Date.now()
      const updated = Database.use((db) =>
        db
          .update(SessionOwnershipTable)
          .set({ expires_at: next + TTL, time_updated: next })
          .where(and(eq(SessionOwnershipTable.session_id, sessionID), eq(SessionOwnershipTable.token, token)))
          .returning({ id: SessionOwnershipTable.session_id })
          .get(),
      )
      if (updated) return
      clearInterval(timer)
      Database.use((db) =>
        db
          .delete(SessionOwnershipTable)
          .where(
            and(eq(SessionOwnershipTable.session_id, sessionID), eq(SessionOwnershipTable.token, `revoke:${token}`)),
          )
          .run(),
      )
      abort.abort()
      if (leases.get(sessionID)?.token === token) leases.delete(sessionID)
    }, HEARTBEAT)
    timer.unref?.()
    leases.set(sessionID, { timer, token, abort })

    let released = false
    const release = (() => {
      if (released) return
      released = true
      clearInterval(timer)
      if (leases.get(sessionID)?.token === token) leases.delete(sessionID)
      Database.use((db) =>
        db
          .delete(SessionOwnershipTable)
          .where(and(eq(SessionOwnershipTable.session_id, sessionID), eq(SessionOwnershipTable.token, token)))
          .run(),
      )
    }) as Lease
    release.signal = abort.signal
    release.token = token
    release.valid = () =>
      !!Database.use((db) =>
        db
          .select({ id: SessionOwnershipTable.session_id })
          .from(SessionOwnershipTable)
          .where(
            and(
              eq(SessionOwnershipTable.session_id, sessionID),
              eq(SessionOwnershipTable.token, token),
              gt(SessionOwnershipTable.expires_at, Date.now()),
            ),
          )
          .get(),
      )
    return release
  }

  export function retryAfter(sessionID: string) {
    const expires = Database.use(
      (db) =>
        db
          .select({ value: SessionOwnershipTable.expires_at })
          .from(SessionOwnershipTable)
          .where(eq(SessionOwnershipTable.session_id, sessionID))
          .get()?.value,
    )
    return Math.max((expires ?? Date.now()) - Date.now() + 100, 100)
  }

  export function revoke(sessionID: string) {
    const now = Date.now()
    const token = Database.transaction((tx) => {
      const row = tx
        .select({ token: SessionOwnershipTable.token })
        .from(SessionOwnershipTable)
        .where(eq(SessionOwnershipTable.session_id, sessionID))
        .get()
      if (!row) return
      if (row.token.startsWith("revoke:")) return row.token.slice("revoke:".length)
      const updated = tx
        .update(SessionOwnershipTable)
        .set({ token: `revoke:${row.token}`, expires_at: now + TTL, time_updated: now })
        .where(and(eq(SessionOwnershipTable.session_id, sessionID), eq(SessionOwnershipTable.token, row.token)))
        .returning({ token: SessionOwnershipTable.token })
        .get()
      return updated ? row.token : undefined
    })
    if (!token) return false
    const entry = state().get(sessionID)
    if (entry?.token !== token) return true
    clearInterval(entry.timer)
    state().delete(sessionID)
    entry.abort.abort()
    Database.use((db) =>
      db
        .delete(SessionOwnershipTable)
        .where(and(eq(SessionOwnershipTable.session_id, sessionID), eq(SessionOwnershipTable.token, `revoke:${token}`)))
        .run(),
    )
    return true
  }

  export async function wait(sessionID: string) {
    const deadline = Date.now() + TTL + 1000
    while (current(sessionID) && Date.now() < deadline) await Bun.sleep(50)
  }
}
