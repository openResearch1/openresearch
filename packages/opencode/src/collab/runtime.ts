import { Instance } from "@/project/instance"
import { Log } from "@/util/log"

export namespace CollabRuntime {
  const log = Log.create({ service: "collab.runtime" })

  type Entry = {
    abort: AbortController
    promise: Promise<void>
  }

  const state = Instance.state(
    () => ({ loops: new Map<string, Entry>() }),
    async (s) => {
      for (const [id, entry] of s.loops) {
        log.info("disposing", { id })
        entry.abort.abort()
      }
      await Promise.allSettled([...s.loops.values()].map((e) => e.promise.catch(() => {})))
      s.loops.clear()
    },
  )

  export function register(agentId: string, abort: AbortController, promise: Promise<void>) {
    const s = state()
    const existing = s.loops.get(agentId)
    if (existing) {
      log.warn("overwriting existing loop entry", { agentId })
      existing.abort.abort()
    }
    s.loops.set(agentId, { abort, promise })
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
}
