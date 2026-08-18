import { Identifier } from "@/id/id"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { CollabMessage } from "./message"
import type { AgentInfo } from "./types"

export namespace CollabDelivery {
  export class ClaimChanged extends Error {}
  export class Stale extends Error {}
  export class Exhausted extends Error {
    constructor(readonly claims: CollabMessage.Row[]) {
      super(`Callback delivery failed after ${MAX_ATTEMPTS} refresh attempts`)
    }
  }

  const MAX_ATTEMPTS = 3

  async function derived(sessionID: string, current: string, target: string, seen = new Set<string>()) {
    if (current === target) return true
    if (seen.has(current)) return false
    seen.add(current)
    const msg = await MessageV2.get({ sessionID, messageID: current }).catch(() => undefined)
    if (msg?.info.role !== "user") return false
    const origin = msg.parts.flatMap((part) => {
      if (part.type !== "text") return []
      if (part.text !== "" || part.synthetic !== true || part.ignored !== true) return []
      const value = part.metadata?.originMessageID
      return typeof value === "string" ? [value] : []
    })[0]
    if (!origin) return false
    return derived(sessionID, origin, target, seen)
  }

  async function related(result: MessageV2.WithParts, node: AgentInfo, messageID: string) {
    if (result.info.role !== "assistant") return false
    const parent = result.info.parentID
    if (typeof parent !== "string") return false
    if (parent === messageID) return true
    return derived(node.session_id, parent, messageID)
  }

  export async function delivered(result: MessageV2.WithParts, node: AgentInfo, messageID?: string) {
    if (result.info.role !== "assistant") return false
    if (result.info.error) return false
    if (!messageID) return true
    return related(result, node, messageID)
  }

  export async function deliver(input: {
    node: AgentInfo
    msgs: CollabMessage.Row[]
    messageID?: string
    match: (msg: MessageV2.WithParts) => boolean
    prompt: (messageID?: string) => Promise<MessageV2.WithParts>
  }) {
    let messageID = input.messageID
    const ids = input.msgs.flatMap((msg) => {
      const payload = msg.payload_json
      if (typeof payload !== "object" || payload === null) return []
      const id =
        msg.kind === "user_input"
          ? "messageId" in payload
            ? payload.messageId
            : undefined
          : "deliveryMessageId" in payload
            ? payload.deliveryMessageId
            : undefined
      return typeof id === "string" ? [id] : []
    })
    const stale = input.msgs.flatMap((msg) => {
      const payload = msg.payload_json
      if (typeof payload !== "object" || payload === null) return []
      const id = "staleDeliveryMessageId" in payload ? payload.staleDeliveryMessageId : undefined
      return typeof id === "string" && id !== messageID ? [id] : []
    })
    await Promise.all(
      [...new Set(stale)].map((id) =>
        Session.removeMessage({ sessionID: input.node.session_id, messageID: id }).catch(() => undefined),
      ),
    )
    if (new Set(ids).size > 1) {
      const next = Identifier.ascending("message")
      if (!CollabMessage.redeliver(input.msgs, next, false)) {
        throw new ClaimChanged("Callback delivery claim changed before batch refresh")
      }
      await Promise.all(
        [...new Set(ids)].map((id) =>
          Session.removeMessage({ sessionID: input.node.session_id, messageID: id }).catch(() => undefined),
        ),
      )
      messageID = next
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const exact = messageID
        ? await MessageV2.get({ sessionID: input.node.session_id, messageID }).catch(() => undefined)
        : undefined
      const result =
        exact?.info.role === "user" && input.match(exact)
          ? await SessionPrompt.loop({ sessionID: input.node.session_id })
          : exact
            ? undefined
            : await input.prompt(messageID)

      if (result && (!messageID || (await related(result, input.node, messageID)))) {
        if (
          exact?.info.role === "user" &&
          result.info.role === "assistant" &&
          result.info.error &&
          result.info.parentID === exact.info.id
        ) {
          await Session.removeMessage({ sessionID: input.node.session_id, messageID: result.info.id })
        }
        return { result, messageID }
      }
      if (attempt === 1) throw new Stale("Callback delivery did not produce its assistant turn")
      const exhausted = input.msgs.filter((msg) => {
        const payload = msg.payload_json
        if (typeof payload !== "object" || payload === null) return false
        return (
          "deliveryAttempts" in payload &&
          typeof payload.deliveryAttempts === "number" &&
          payload.deliveryAttempts >= MAX_ATTEMPTS
        )
      })
      if (exhausted.length > 0) {
        if (messageID) {
          await Session.removeMessage({ sessionID: input.node.session_id, messageID }).catch(() => undefined)
        }
        throw new Exhausted(exhausted)
      }

      const next = Identifier.ascending("message")
      if (!CollabMessage.redeliver(input.msgs, next)) {
        throw new ClaimChanged("Callback delivery claim changed before refresh")
      }
      if (messageID) {
        await Session.removeMessage({ sessionID: input.node.session_id, messageID }).catch(() => undefined)
      }
      messageID = next
    }

    throw new Stale("Callback delivery did not produce its assistant turn")
  }
}
