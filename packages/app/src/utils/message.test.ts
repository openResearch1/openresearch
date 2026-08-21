import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { assistants } from "@opencode-ai/ui/session-turn-messages"
import { prefix, remove, sort, upsert } from "./message"

const message = (id: string, created: number) =>
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

describe("message order", () => {
  test("sorts by creation time before id", () => {
    expect(sort([message("msg_1", 3), message("msg_3", 1), message("msg_2", 1)]).map((item) => item.id)).toEqual([
      "msg_2",
      "msg_3",
      "msg_1",
    ])
  })

  test("upserts by identity and relocates changed timestamps", () => {
    const current = [message("msg_1", 1), message("msg_2", 2)]
    expect(upsert(current, message("msg_1", 3)).map((item) => item.id)).toEqual(["msg_2", "msg_1"])
  })

  test("removes by identity from time ordered messages", () => {
    const current = [message("msg_9", 1), message("msg_1", 2), message("msg_5", 3)]
    expect(remove(current, "msg_1").map((item) => item.id)).toEqual(["msg_9", "msg_5"])
  })

  test("creates a revert prefix by position instead of id", () => {
    const current = [message("msg_9", 1), message("msg_1", 2), message("msg_5", 3)]
    expect(prefix(current, "msg_1").map((item) => item.id)).toEqual(["msg_9"])
  })

  test("preserves the legacy boundary while the revert target is outside the loaded page", () => {
    const current = [message("msg_1", 2), message("msg_3", 3)]
    expect(prefix(current, "msg_2").map((item) => item.id)).toEqual(["msg_1"])
  })

  test("keeps a preallocated callback after the parent turn without hiding late assistants", () => {
    const current = sort([
      message("msg_parent", 1),
      assistant("msg_general", "msg_parent", 2),
      message("msg_callback_low_id", 5),
      assistant("msg_commit", "msg_parent", 3),
      assistant("msg_summary", "msg_parent", 4),
      assistant("msg_callback_reply", "msg_callback_low_id", 6),
    ])

    expect(current.map((item) => item.id)).toEqual([
      "msg_parent",
      "msg_general",
      "msg_commit",
      "msg_summary",
      "msg_callback_low_id",
      "msg_callback_reply",
    ])
    expect(assistants(current, "msg_parent").map((item) => item.id)).toEqual([
      "msg_general",
      "msg_commit",
      "msg_summary",
    ])
  })
})
