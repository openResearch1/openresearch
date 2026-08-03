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

  export function cancelDescendants(
    agentId: string,
    cancel: { reason: string; initiator: CancelPayload["initiator"] },
  ) {
    const root = CollabAgentNode.tryLoad(agentId)
    if (!root) return
    const tree = CollabAgentNode.loadTree(root.root_agent_id)
    const toCancel = tree.filter((n) => {
      if (!CollabAgentNode.isActive(n.status)) return false
      if (n.id === agentId) return false
      if (n.initiator === "human") return false
      return isDescendant(tree, n.id, agentId)
    })
    log.info("cancelDescendants", { agentId, count: toCancel.length })
    for (const n of toCancel) {
      CollabMessage.post({
        recipientAgentId: n.id,
        senderAgentId: agentId,
        runId: n.run_id,
        expectedParentAgentId: n.parent_agent_id,
        expectedRunId: n.run_id,
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

  function isDescendant(
    tree: { id: string; parent_agent_id: string | null; initiator?: "human" | "agent" | null }[],
    id: string,
    ancestorId: string,
  ) {
    const byId = new Map(tree.map((n) => [n.id, n]))
    let cur = byId.get(id)
    while (cur && cur.parent_agent_id) {
      if (cur.parent_agent_id === ancestorId) return true
      cur = byId.get(cur.parent_agent_id)
      if (cur?.initiator === "human") return false
    }
    return false
  }
}
