import type { Event } from "@opencode-ai/sdk/v2/client"

function info(event: Event) {
  if (event.type !== "session.created" && event.type !== "session.updated" && event.type !== "session.deleted") return
  return (event.properties as { info: { id: string; directory: string } }).info
}

export function sessionEventID(event: Event) {
  const session = info(event)
  if (session) return session.id
  switch (event.type) {
    case "session.status":
    case "session.diff":
    case "todo.updated":
    case "workflow.updated":
    case "message.removed":
    case "message.part.removed":
    case "message.part.delta":
      return (event.properties as { sessionID: string }).sessionID
    case "message.updated":
      return (event.properties as { info: { sessionID: string } }).info.sessionID
    case "message.part.updated":
      return (event.properties as { part: { sessionID: string } }).part.sessionID
  }
}

export function routeSessionEvent(input: {
  event: Event
  directory: string
  cached?: string
  directories: Iterable<string>
  owns: (directory: string, sessionID: string) => boolean
}) {
  const directories = new Set(input.directories)
  const session = info(input.event)
  if (session?.directory && directories.has(session.directory)) {
    return { directory: session.directory, sessionID: session.id }
  }

  const sessionID = sessionEventID(input.event)
  if (!sessionID) return { directory: input.directory }
  if (input.cached && directories.has(input.cached)) return { directory: input.cached, sessionID }
  if (directories.has(input.directory) && input.owns(input.directory, sessionID)) {
    return { directory: input.directory, sessionID }
  }
  for (const directory of directories) {
    if (input.owns(directory, sessionID)) return { directory, sessionID }
  }
  return { directory: input.directory, sessionID }
}
