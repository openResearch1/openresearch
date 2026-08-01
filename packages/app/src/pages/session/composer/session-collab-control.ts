import type { CollabAgent } from "@opencode-ai/sdk/v2/client"

const ACTIVE_STATUSES = new Set(["pending", "running", "blocked_on_children", "waiting_interaction"])

export function isAgentControlled(root: CollabAgent | null) {
  const metadata = root?.spec.metadata
  if (!root?.parent_agent_id || typeof metadata?.atomId !== "string") return false
  if (typeof metadata.expId !== "string") return true
  return ACTIVE_STATUSES.has(root.status) && root.initiator !== "human"
}
