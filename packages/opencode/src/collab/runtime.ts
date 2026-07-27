import { Instance } from "@/project/instance"
import { Log } from "@/util/log"

export namespace CollabRuntime {
  const log = Log.create({ service: "collab.runtime" })

  type Entry = {
    abort: AbortController
    promise: Promise<void>
    runId: string | null
    parentId: string | null
  }

  const state = Instance.state(
    () => ({ loops: new Map<string, Entry>(), retries: new Map<string, ReturnType<typeof setTimeout>>() }),
    async (s) => {
      for (const [id, entry] of s.loops) {
        log.info("disposing", { id })
        entry.abort.abort()
      }
      await Promise.allSettled([...s.loops.values()].map((e) => e.promise.catch(() => {})))
      s.loops.clear()
      for (const timer of s.retries.values()) clearTimeout(timer)
      s.retries.clear()
    },
  )

  export function register(
    agentId: string,
    abort: AbortController,
    promise: Promise<void>,
    identity: { runId: string | null; parentId: string | null } = { runId: null, parentId: null },
  ) {
    const s = state()
    const retry = s.retries.get(agentId)
    if (retry) clearTimeout(retry)
    s.retries.delete(agentId)
    const existing = s.loops.get(agentId)
    if (existing) {
      log.warn("overwriting existing loop entry", { agentId })
      existing.abort.abort()
    }
    s.loops.set(agentId, { abort, promise, ...identity })
    void promise.finally(() => {
      const current = s.loops.get(agentId)
      if (current && current.promise === promise) {
        s.loops.delete(agentId)
      }
    })
  }

  export function get(agentId: string): Entry | undefined {
    return state().loops.get(agentId)
  }

  export function has(agentId: string): boolean {
    return state().loops.has(agentId)
  }

  export function matches(agentId: string, identity: { runId: string | null; parentId: string | null }) {
    const entry = state().loops.get(agentId)
    return !!entry && entry.runId === identity.runId && entry.parentId === identity.parentId
  }

  export function unregister(agentId: string) {
    state().loops.delete(agentId)
  }

  export function abort(agentId: string) {
    const entry = state().loops.get(agentId)
    if (!entry) return
    entry.abort.abort()
  }

  export function abortAndUnregister(agentId: string) {
    const entry = state().loops.get(agentId)
    if (!entry) return
    entry.abort.abort()
    state().loops.delete(agentId)
  }

  export function abortAll() {
    for (const entry of state().loops.values()) entry.abort.abort()
  }

  export function list(): string[] {
    return [...state().loops.keys()]
  }

  export function schedule(agentId: string, delay: number, fn: () => void) {
    const s = state()
    const existing = s.retries.get(agentId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      s.retries.delete(agentId)
      fn()
    }, delay)
    timer.unref?.()
    s.retries.set(agentId, timer)
  }
}
