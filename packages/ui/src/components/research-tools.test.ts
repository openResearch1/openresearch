import { describe, expect, test } from "bun:test"

import { children } from "./research-tools"

const row = {
  agent_id: "agent_1",
  name: "Inspect frontend",
  subagent_type: "explore",
  status: "running",
  active_children: 0,
  spawned_at: 1,
  ended_at: null,
}

describe("research tool children output", () => {
  test("parses child rows", () => {
    expect(children(JSON.stringify({ children: [row] }))).toEqual([row])
  })

  test("ignores a polling warning after the payload", () => {
    const output = `${JSON.stringify({ children: [row] }, null, 2)}\nPOLLING WARNING: Do not poll.`
    expect(children(output)).toEqual([row])
  })

  test("preserves an empty child list", () => {
    expect(children('{"children":[]}')).toEqual([])
  })

  test("rejects plain, malformed, and truncated output", () => {
    expect(children("No Collab agent bound to this session yet.")).toBeUndefined()
    expect(children('{"children":[')).toBeUndefined()
    expect(children(JSON.stringify({ children: [row] }), true)).toBeUndefined()
  })
})
