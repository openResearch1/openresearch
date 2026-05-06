import { Log } from "@/util/log"
import { CollabAgentNode } from "./agent-node"
import { CollabMessage } from "./message"
import type { CancelPayload } from "./types"

export namespace CollabSupervisor {
  const log = Log.create({ service: "collab.supervisor" })

  export async function cancelDescendants(
    agentId: string,
    cancel: { reason: string; initiator: CancelPayload["initiator"] },
  ) {
    const root = CollabAgentNode.tryLoad(agentId)
    if (!root) return
    const tree = CollabAgentNode.loadTree(root.root_agent_id)
    const toCancel = tree.filter((n) => {
      if (!CollabAgentNode.isActive(n.status)) return false
      if (n.id === agentId) return false
      return isDescendant(tree, n.id, agentId)
    })
    log.info("cancelDescendants", { agentId, count: toCancel.length })
    for (const n of toCancel) {
      await CollabMessage.post({
        recipientAgentId: n.id,
        senderAgentId: agentId,
        kind: "cancel",
        payload: { reason: cancel.reason, initiator: cancel.initiator } satisfies CancelPayload,
      })
    }
  }

  function isDescendant(tree: { id: string; parent_agent_id: string | null }[], id: string, ancestorId: string) {
    const byId = new Map(tree.map((n) => [n.id, n]))
    let cur = byId.get(id)
    while (cur && cur.parent_agent_id) {
      if (cur.parent_agent_id === ancestorId) return true
      cur = byId.get(cur.parent_agent_id)
    }
    return false
  }
}
