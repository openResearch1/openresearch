import { createEffect, createMemo, onCleanup, on, type Accessor } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useData } from "@opencode-ai/ui/context"
import type { CollabAgent } from "@opencode-ai/sdk/v2/client"

const ACTIVE_STATUSES = new Set(["pending", "running", "blocked_on_children", "waiting_interaction"])

export type CollabActivity = {
  rootAgent: Accessor<CollabAgent | null>
  children: Accessor<CollabAgent[]>
  activeChildren: Accessor<CollabAgent[]>
  active: Accessor<boolean>
  done: Accessor<boolean>
  getAgent: (id: string) => CollabAgent | undefined
}

type LocalStore = {
  rootAgentId: string | null
  allIds: string[]
  agents: Record<string, CollabAgent>
}

/**
 * Fine-grained local store for the Collab subtree bound to a session.
 *
 * Instead of using createResource + refetch-on-any-event (which produces a
 * brand-new tree object each time and cascades through every downstream memo),
 * we hydrate once and then apply Bus events as granular store mutations.
 * This mirrors how the workflow dock consumes `sync.data.workflow[id]` —
 * individual field updates only re-run the readers of those exact paths,
 * not the entire render tree.
 */
export function useCollabActivity(sessionID: Accessor<string | undefined>): CollabActivity {
  const sdk = useGlobalSDK()
  const data = useData()
  const [state, setState] = createStore<LocalStore>({ rootAgentId: null, allIds: [], agents: {} })

  async function hydrate(sid: string | undefined) {
    if (!sid) {
      setState({ rootAgentId: null, allIds: [], agents: {} })
      return
    }
    const rootRes = await sdk.client.collab.session.agent.get({ sessionId: sid, directory: data.directory })
    const root = rootRes.data?.agent
    if (!root) {
      setState({ rootAgentId: null, allIds: [], agents: {} })
      return
    }
    const treeRes = await sdk.client.collab.tree.get({
      rootAgentId: root.root_agent_id,
      directory: data.directory,
    })
    const nodes = treeRes.data?.nodes ?? []
    const byId: Record<string, CollabAgent> = {}
    const ids: string[] = []
    for (const n of nodes) {
      byId[n.id] = n
      ids.push(n.id)
    }
    // One commit: reconcile both indices. Single downstream emit.
    setState({ rootAgentId: root.root_agent_id, allIds: ids, agents: byId })
  }

  // Re-hydrate on session change.
  createEffect(on(sessionID, (sid) => void hydrate(sid)))

  function upsert(agent: CollabAgent) {
    setState(
      produce((s) => {
        if (!s.agents[agent.id]) s.allIds.push(agent.id)
        s.agents[agent.id] = agent
        if (!s.rootAgentId && !agent.parent_agent_id) s.rootAgentId = agent.id
      }),
    )
  }

  function patchAgent(id: string, patch: Partial<CollabAgent>) {
    if (!state.agents[id]) return
    // reconcile the merged object so same-value fields keep their old refs.
    setState("agents", id, reconcile({ ...state.agents[id], ...patch } as CollabAgent, { key: "id", merge: true }))
  }

  createEffect(() => {
    const off = sdk.event.on(data.directory, (e) => {
      switch (e.type) {
        case "collab.agent.created": {
          const info = (e.properties as { info: CollabAgent }).info
          const relevant = !state.rootAgentId || info.root_agent_id === state.rootAgentId || !info.parent_agent_id
          if (!relevant) return
          upsert(info)
          return
        }
        case "collab.agent.status": {
          const p = e.properties as {
            agentId: string
            rootAgentId: string
            status: CollabAgent["status"]
            phase: CollabAgent["phase"]
            active_children: number
          }
          if (state.rootAgentId && p.rootAgentId !== state.rootAgentId) return
          patchAgent(p.agentId, {
            status: p.status,
            phase: p.phase,
            active_children: p.active_children,
          })
          return
        }
        case "collab.agent.completed": {
          const p = e.properties as { agentId: string; rootAgentId: string; summary?: string }
          if (state.rootAgentId && p.rootAgentId !== state.rootAgentId) return
          const prev = state.agents[p.agentId]
          if (!prev) return
          patchAgent(p.agentId, {
            status: "completed",
            result: { summary: p.summary, result: prev.result?.result },
            time_ended: prev.time_ended ?? Date.now(),
          })
          return
        }
        case "collab.agent.failed": {
          const p = e.properties as { agentId: string; rootAgentId: string; code: string; message: string }
          if (state.rootAgentId && p.rootAgentId !== state.rootAgentId) return
          patchAgent(p.agentId, {
            status: "failed",
            error: { code: p.code, message: p.message },
            time_ended: Date.now(),
          })
          return
        }
      }
    })
    onCleanup(() => off())
  })

  const rootAgent = createMemo(() => (state.rootAgentId ? (state.agents[state.rootAgentId] ?? null) : null))

  // children/activeChildren subscribe only to allIds + rootAgentId.
  // Individual agent status changes do NOT cause these arrays to rebuild;
  // only add/remove of agents does. That's the key to avoiding cascade.
  const children = createMemo(() => {
    const root = state.rootAgentId
    if (!root) return []
    const result: CollabAgent[] = []
    for (const id of state.allIds) {
      if (id === root) continue
      const a = state.agents[id]
      if (a) result.push(a)
    }
    return result
  })

  const activeChildren = createMemo(() => {
    // Reads each agent's status — fine-grained: only agents whose status
    // changed cause this memo to re-run. We still rebuild the filtered array
    // but the downstream <For> keys by CollabAgent reference; unchanged
    // agents keep the same ref (store reconcile preserves unchanged fields),
    // so <For> only mounts/unmounts entries that truly transitioned.
    return children().filter((c) => ACTIVE_STATUSES.has(c.status))
  })

  const active = createMemo(() => activeChildren().length > 0)
  const done = createMemo(() => !active())

  return {
    rootAgent,
    children,
    activeChildren,
    active,
    done,
    getAgent: (id) => state.agents[id],
  }
}
