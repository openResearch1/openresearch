import { describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2/client"

import { routeSessionEvent } from "./session-event-routing"

const directories = ["/workspace/a", "/workspace/b"]
const owns = (directory: string, sessionID: string) => directory === "/workspace/a" && sessionID === "session-1"

describe("routeSessionEvent", () => {
  test("routes a mislabelled message event to the loaded session directory", () => {
    const event = {
      type: "message.updated",
      properties: { info: { id: "message-1", sessionID: "session-1", role: "user" } },
    } as Event

    expect(routeSessionEvent({ event, directory: "/workspace/b", directories, owns })).toEqual({
      directory: "/workspace/a",
      sessionID: "session-1",
    })
  })

  test("uses a cached directory for streamed part events", () => {
    const event = {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "message-1",
        partID: "part-1",
        field: "text",
        delta: "done",
      },
    } as Event

    expect(
      routeSessionEvent({
        event,
        directory: "/workspace/b",
        cached: "/workspace/a",
        directories,
        owns,
      }),
    ).toEqual({ directory: "/workspace/a", sessionID: "session-1" })
  })

  test("uses the authoritative directory from session events", () => {
    const event = {
      type: "session.updated",
      properties: { info: { id: "session-1", directory: "/workspace/a" } },
    } as Event

    expect(routeSessionEvent({ event, directory: "/workspace/b", directories, owns })).toEqual({
      directory: "/workspace/a",
      sessionID: "session-1",
    })
  })

  test("keeps the completion card and assistant stream in the same session store", () => {
    const events = [
      {
        type: "message.updated",
        properties: { info: { id: "message-user", sessionID: "session-1", role: "user" } },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-terminal",
            messageID: "message-user",
            sessionID: "session-1",
            type: "collab_return",
            kind: "remote_task_terminal",
          },
        },
      },
      {
        type: "message.updated",
        properties: {
          info: { id: "message-assistant", sessionID: "session-1", parentID: "message-user", role: "assistant" },
        },
      },
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "message-assistant",
          partID: "part-text",
          field: "text",
          delta: "Task finished.",
        },
      },
    ] as Event[]

    let cached: string | undefined
    const routed = events.map((event) => {
      const result = routeSessionEvent({ event, directory: "/workspace/b", cached, directories, owns })
      cached = result.directory
      return result.directory
    })
    expect(routed).toEqual(["/workspace/a", "/workspace/a", "/workspace/a", "/workspace/a"])
  })

  test("leaves non-session events in their envelope directory", () => {
    const event = { type: "server.heartbeat", properties: {} } as unknown as Event
    expect(routeSessionEvent({ event, directory: "/workspace/b", directories, owns })).toEqual({
      directory: "/workspace/b",
    })
  })
})
