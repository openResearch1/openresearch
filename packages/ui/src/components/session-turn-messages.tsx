import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2/client"

export function assistants(messages: Message[], parentID: string) {
  return messages.filter(
    (message): message is AssistantMessage => message.role === "assistant" && message.parentID === parentID,
  )
}
