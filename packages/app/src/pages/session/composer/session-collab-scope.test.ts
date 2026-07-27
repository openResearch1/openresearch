import { describe, expect, test } from "bun:test"
import type { CollabAgent } from "@opencode-ai/sdk/v2/client"
import { descendants } from "./session-collab-scope"

function node(id: string, parent: string | null) {
  return { id, parent_agent_id: parent } as CollabAgent
}

describe("session collab scope", () => {
  test("returns only descendants of the bound agent", () => {
    const nodes = [node("project", null), node("atom-a", "project"), node("atom-b", "project"), node("exp", "atom-a")]
    expect(descendants(nodes, "project").map((item) => item.id)).toEqual(["atom-a", "atom-b", "exp"])
    expect(descendants(nodes, "atom-a").map((item) => item.id)).toEqual(["exp"])
    expect(descendants(nodes, "atom-b")).toEqual([])
  })
})
