import type { Message } from "@opencode-ai/sdk/v2/client"

const id = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function compare(a: Message, b: Message) {
  return a.time.created - b.time.created || id(a.id, b.id)
}

export function sort(messages: Message[]) {
  return [...messages].sort(compare)
}

export function upsert(messages: Message[], message: Message) {
  const next = messages.filter((item) => item.id !== message.id)
  const index = next.findIndex((item) => compare(item, message) > 0)
  next.splice(index === -1 ? next.length : index, 0, message)
  return next
}

export function remove(messages: Message[], messageID: string) {
  const index = messages.findIndex((message) => message.id === messageID)
  if (index === -1) return messages
  return [...messages.slice(0, index), ...messages.slice(index + 1)]
}

export function prefix(messages: Message[], messageID: string | undefined) {
  if (!messageID) return messages
  const index = messages.findIndex((message) => message.id === messageID)
  if (index === -1) return messages.filter((message) => message.id < messageID)
  return messages.slice(0, index)
}
