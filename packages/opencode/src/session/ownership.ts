import { Instance } from "@/project/instance"

export namespace SessionOwnership {
  export type Owner = "human" | "collab"
  type Entry = { owner: Owner; count: number }

  const state = Instance.state(() => new Map<string, Entry>())

  export function available(sessionID: string, owner: Owner) {
    const current = state().get(sessionID)
    return !current || current.owner === owner
  }

  export function current(sessionID: string) {
    return state().get(sessionID)?.owner
  }

  export function claim(sessionID: string, owner: Owner) {
    if (!available(sessionID, owner)) return
    const owners = state()
    const current = owners.get(sessionID)
    owners.set(sessionID, { owner, count: (current?.count ?? 0) + 1 })
    let released = false
    return () => {
      if (released) return
      released = true
      const next = owners.get(sessionID)
      if (!next || next.owner !== owner) return
      if (next.count === 1) {
        owners.delete(sessionID)
        return
      }
      owners.set(sessionID, { ...next, count: next.count - 1 })
    }
  }
}
