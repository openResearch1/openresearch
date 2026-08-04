import { Log } from "@/util/log"
import { SessionPrompt } from "@/session/prompt"
import { SessionOwnership } from "@/session/ownership"
import { ExperimentRemoteTaskListener } from "@/research/experiment-remote-task-listener"
import { CollabAgentNode } from "./agent-node"
import { CollabMessage } from "./message"
import { CollabRuntime } from "./runtime"
import type { CancelPayload } from "./types"

export namespace CollabSupervisor {
  const log = Log.create({ service: "collab.supervisor" })

  export function cancelChildren(
    agentId: string,
    cancel: { reason: string; initiator: CancelPayload["initiator"] },
  ) {
    const children = CollabAgentNode.loadChildren(agentId).filter(
      (item) => CollabAgentNode.isActive(item.status) && item.initiator !== "human",
    )
    log.info("cancelChildren", { agentId, count: children.length })
    for (const child of children) {
      CollabMessage.post({
        recipientAgentId: child.id,
        senderAgentId: agentId,
        runId: child.run_id,
        expectedParentAgentId: agentId,
        expectedRunId: child.run_id,
        kind: "cancel",
        payload: { reason: cancel.reason, initiator: cancel.initiator } satisfies CancelPayload,
      })
    }
  }

  export async function stop(agentId: string, expected?: number) {
    const result = CollabAgentNode.stop(agentId, expected)
    if (!result.valid) return result.root
    if (!CollabAgentNode.claimed(agentId, result.generation, result.token)) return CollabAgentNode.load(agentId)
    const ids = result.agents.map((item) => item.id)
    ExperimentRemoteTaskListener.clear(ids)
    const loops: Promise<void>[] = []
    for (const item of result.agents) {
      const loop = CollabRuntime.clear(item.id)
      if (loop) loops.push(loop)
      SessionPrompt.cancel(item.session_id)
      SessionOwnership.revoke(item.session_id)
    }
    await Promise.allSettled([
      ...loops.map((loop) => Promise.race([loop, Bun.sleep(2000)]).then(() => undefined)),
      ...result.agents.map((item) => SessionOwnership.wait(item.session_id)),
    ])
    if (!CollabAgentNode.claimed(agentId, result.generation, result.token)) return CollabAgentNode.load(agentId)
    for (const item of result.agents) {
      if (!item.parent_agent_id || !item.spec.policy?.detach_on_terminal) continue
      CollabAgentNode.release(item.id)
    }
    const root = CollabAgentNode.ready(agentId, result.generation, result.token)
    log.info("stop", { agentId, count: ids.length })
    return root
  }
}
