import { createContext, useContext, onCleanup, type JSX, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"

type DirectoryState = {
  ids: string[]
  loaded: boolean
}

type CollabPeersValue = {
  peersOf: (directory: string) => string[]
}

const CollabPeersContext = createContext<CollabPeersValue>()

/**
 * App-global tracker for Collab peer session ids, indexed by directory.
 *
 * Peer sessions (`collab_agent.parent_agent_id != null`) are hidden from
 * the flat session list in the sidebar — they are only reached via the
 * parent agent's dock. Atom and experiment sessions are NOT in this set,
 * so they still render normally in the research tree.
 */
export function CollabPeersProvider(props: { children: JSX.Element }) {
  const sdk = useGlobalSDK()
  const [store, setStore] = createStore<Record<string, DirectoryState>>({})
  const hydrating = new Set<string>()
  const subscribed = new Map<string, () => void>()

  async function refresh(directory: string) {
    if (hydrating.has(directory)) return
    hydrating.add(directory)
    try {
      const res = await sdk.client.collab.peerSessions.list({ directory })
      const next = res.data?.session_ids ?? []
      setStore(directory, { ids: next, loaded: true })
    } catch (err) {
      console.warn("[collab-peers] refresh failed", { directory, err })
      setStore(directory, (prev) => ({ ids: prev?.ids ?? [], loaded: true }))
    } finally {
      hydrating.delete(directory)
    }
  }

  function subscribe(directory: string) {
    if (subscribed.has(directory)) return
    const off = sdk.event.on(directory, (e) => {
      if (e.type !== "collab.agent.created") return
      const info = e.properties.info as { session_id: string; parent_agent_id: string | null }
      if (!info?.session_id || !info.parent_agent_id) return
      const existing = store[directory]?.ids ?? []
      if (existing.includes(info.session_id)) return
      setStore(directory, (prev) => ({
        ids: prev ? [...prev.ids, info.session_id] : [info.session_id],
        loaded: prev?.loaded ?? true,
      }))
    })
    subscribed.set(directory, off)
  }

  onCleanup(() => {
    for (const off of subscribed.values()) off()
    subscribed.clear()
  })

  const value: CollabPeersValue = {
    peersOf: (directory) => {
      if (!directory) return []
      // Lazy hydrate + live-subscribe the first time any consumer queries
      // this directory. These are idempotent and cheap to retry.
      if (!store[directory]) {
        // seed synchronously so store[directory].ids is a tracked path even
        // before the async refresh resolves
        setStore(directory, { ids: [], loaded: false })
        void refresh(directory)
        subscribe(directory)
      } else if (!store[directory].loaded && !hydrating.has(directory)) {
        void refresh(directory)
      }
      return store[directory]?.ids ?? []
    },
  }

  return <CollabPeersContext.Provider value={value}>{props.children}</CollabPeersContext.Provider>
}

export function useCollabPeers(directory: string | Accessor<string>): Accessor<ReadonlySet<string>> {
  const ctx = useContext(CollabPeersContext)
  const dir = typeof directory === "function" ? directory : () => directory
  if (!ctx) return () => new Set<string>()
  // Return a plain accessor. Each consumer that wraps this in its own memo
  // (e.g., sessions = createMemo(() => sortedRootSessions(...).filter(...)))
  // naturally establishes a store-path subscription on `ctx.peersOf(d)`.
  // No extra reactive primitives created here — important because some call
  // sites (sidebar-project's workspaceSessions) invoke this from inside a
  // For-each row, and creating memos there would pile up and churn.
  return () => new Set(ctx.peersOf(dir()))
}
