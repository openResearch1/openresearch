import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

export function match(status: SessionStatus | undefined) {
  if (status?.type !== "retry") return
  return status
}
