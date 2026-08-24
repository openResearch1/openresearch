import type { CollabAgent } from "@opencode-ai/sdk/v2/client"

const ACTIVE_STATUSES = new Set(["pending", "running", "blocked_on_children", "waiting_interaction"])

export function failure(code: string): CollabAgent["status"] {
  return code === "CANCELED" ? "canceled" : "failed"
}

export function isAgentControlled(root: CollabAgent | null) {
  const metadata = root?.spec.metadata
  if (!root?.parent_agent_id) return false
  if (typeof metadata?.atomId !== "string" || typeof metadata.expId !== "string") return true
  return ACTIVE_STATUSES.has(root.status) && root.initiator !== "human"
}

export function canStopController(root: CollabAgent | null, dedicated: boolean) {
  if (!dedicated) return false
  return !!root && ACTIVE_STATUSES.has(root.status)
}
