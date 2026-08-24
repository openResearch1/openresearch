import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { assistants } from "./session-turn-messages"

const user = (id: string, created: number) =>
  ({
    id,
    sessionID: "ses_1",
    role: "user",
    time: { created },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt" },
  }) as Message

const assistant = (id: string, parentID: string, created: number) =>
  ({
    id,
    sessionID: "ses_1",
    role: "assistant",
    parentID,
    time: { created },
    modelID: "gpt",
    providerID: "openai",
    mode: "assistant",
    agent: "assistant",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }) as Message

describe("session turn assistants", () => {
  test("keeps parent assistants separated by an asynchronous callback user", () => {
    const messages = [
      user("msg_parent", 1),
      assistant("msg_before", "msg_parent", 2),
      user("msg_remote_terminal", 3),
      assistant("msg_after", "msg_parent", 4),
      assistant("msg_callback", "msg_remote_terminal", 5),
    ]

    expect(assistants(messages, "msg_parent").map((message) => message.id)).toEqual(["msg_before", "msg_after"])
    expect(assistants(messages, "msg_remote_terminal").map((message) => message.id)).toEqual(["msg_callback"])
  })
})
