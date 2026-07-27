import type { CollabAgent } from "@opencode-ai/sdk/v2/client"

export function descendants(nodes: CollabAgent[], anchor: string) {
  const ids = new Set([anchor])
  let changed = true
  while (changed) {
    changed = false
    for (const node of nodes) {
      if (!node.parent_agent_id || !ids.has(node.parent_agent_id) || ids.has(node.id)) continue
      ids.add(node.id)
      changed = true
    }
  }
  return nodes.filter((node) => node.id !== anchor && ids.has(node.id))
}
