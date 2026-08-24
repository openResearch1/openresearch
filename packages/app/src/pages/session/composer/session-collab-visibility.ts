import { createEffect, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

import type { CollabAgent } from "@opencode-ai/sdk/v2/client"

export const TERMINAL_TTL = 30_000

const ACTIVE = new Set(["pending", "running", "blocked_on_children", "waiting_interaction"])
const TERMINAL = new Set(["completed", "failed", "canceled"])

function ended(agent: CollabAgent) {
  return Math.max(agent.time_ended ?? 0, agent.time_updated)
}

export function active(agent: CollabAgent) {
  return ACTIVE.has(agent.status)
}

export function historical(agent: CollabAgent) {
  return !active(agent)
}

export function listed(agent: CollabAgent, history = false) {
  return history || active(agent)
}

export function visible(agent: CollabAgent, now: number, history = false) {
  if (history || active(agent)) return true
  if (!TERMINAL.has(agent.status)) return false
  return now - ended(agent) < TERMINAL_TTL
}

export function tree(root: CollabAgent, nodes: CollabAgent[], now: number, history = false) {
  const branches = new Map<string, CollabAgent[]>()
  for (const node of nodes) {
    if (!node.parent_agent_id) continue
    const items = branches.get(node.parent_agent_id) ?? []
    items.push(node)
    branches.set(node.parent_agent_id, items)
  }

  const ids = new Set<string>()
  const visit = (node: CollabAgent): boolean => {
    const descendant = (branches.get(node.id) ?? []).map(visit).some(Boolean)
    const keep = node.id === root.id || visible(node, now, history) || descendant
    if (keep) ids.add(node.id)
    return keep
  }
  visit(root)
  return nodes.filter((node) => ids.has(node.id))
}

export function deadline(agents: CollabAgent[], now: number) {
  return agents
    .flatMap((agent) => {
      const end = ended(agent)
      return TERMINAL.has(agent.status) && end + TERMINAL_TTL > now ? [end + TERMINAL_TTL] : []
    })
    .sort((a, b) => a - b)[0]
}

export function clock(agents: Accessor<CollabAgent[]>) {
  const [state, setState] = createStore({ now: Date.now() })
  let timer: ReturnType<typeof setTimeout> | undefined

  const schedule = () => {
    if (timer) clearTimeout(timer)
    const now = Date.now()
    setState("now", now)
    const next = deadline(agents(), now)
    if (!next) return
    timer = setTimeout(schedule, Math.max(next - now, 0) + 1)
  }

  createEffect(schedule)
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })
  return () => state.now
}
