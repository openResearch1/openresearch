import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session"
import { CollabAgentNode } from "./agent-node"
import { CollabMessage } from "./message"
import type { ChildProgressPayload } from "./types"

export namespace CollabProgressHook {
  const log = Log.create({ service: "collab.progress" })
  const MAX_TEXT = 8 * 1024

  type Seen = Set<string>

  const state = Instance.state(
    () => {
      const seen: Seen = new Set()
      const turnCounter = new Map<string, number>()

      const unsubscribe = Bus.subscribe(MessageV2.Event.Updated, (e) => {
        try {
          const info = e.properties.info
          if (info.role !== "assistant") return
          if (!info.finish) return
          const key = `${info.sessionID}:${info.id}`
          if (seen.has(key)) return
          seen.add(key)
          void handleFinishedAssistant(info, turnCounter).catch((err) => {
            log.warn("handleFinishedAssistant failed", { error: String(err) })
          })
        } catch (err) {
          log.warn("progress hook error", { error: String(err) })
        }
      })

      return { seen, turnCounter, unsubscribe }
    },
    async (s) => {
      s.unsubscribe()
      s.seen.clear()
      s.turnCounter.clear()
    },
  )

  export function ensure() {
    // Force state initialization (side-effect: subscribes to bus).
    state()
  }

  async function handleFinishedAssistant(info: MessageV2.Assistant, turnCounter: Map<string, number>) {
    const node = CollabAgentNode.loadBySessionId(info.sessionID)
    if (!node) return
    if (!node.parent_agent_id) return
    if (!CollabAgentNode.isActive(node.status)) return

    const prevTurn = turnCounter.get(node.id) ?? 0
    const turn = prevTurn + 1
    turnCounter.set(node.id, turn)

    const assistant_text = await extractAssistantText(info.sessionID, info.id)
    const tools = extractToolSummary(info)

    const payload: ChildProgressPayload = {
      childAgentId: node.id,
      childName: node.name,
      turn,
      assistant_text: truncate(assistant_text, MAX_TEXT),
      tools,
    }

    await CollabMessage.post({
      recipientAgentId: node.parent_agent_id,
      senderAgentId: node.id,
      kind: "child_progress",
      payload,
    })
  }

  async function extractAssistantText(sessionID: string, messageID: string): Promise<string> {
    try {
      const msgs = await Session.messages({ sessionID })
      const target = msgs.find((m) => m.info.id === messageID)
      if (!target) return ""
      const chunks: string[] = []
      for (const part of target.parts) {
        if (part.type === "text" && typeof (part as MessageV2.TextPart).text === "string") {
          const t = (part as MessageV2.TextPart).text
          if (t && t.trim().length > 0) chunks.push(t)
        }
      }
      return chunks.join("\n\n")
    } catch (err) {
      log.warn("extractAssistantText failed", { sessionID, messageID, error: String(err) })
      return ""
    }
  }

  function extractToolSummary(_info: MessageV2.Assistant): ChildProgressPayload["tools"] {
    // Tool details live in parts; keep empty for now, populate in a follow-up once we track them.
    return []
  }

  function truncate(text: string, max: number): string {
    if (text.length <= max) return text
    return text.slice(0, max) + "\n...[truncated]"
  }
}
