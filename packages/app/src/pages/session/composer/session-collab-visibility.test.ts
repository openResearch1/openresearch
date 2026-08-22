import { describe, expect, test } from "bun:test"

import type { CollabAgent } from "@opencode-ai/sdk/v2/client"
import { TERMINAL_TTL, active, deadline, historical, listed, tree, visible } from "./session-collab-visibility"

function agent(input?: Partial<CollabAgent>): CollabAgent {
  return {
    id: "agent",
    session_id: "session",
    parent_agent_id: "root",
    name: "Agent",
    project_id: "project",
    root_agent_id: "root",
    run_id: "run",
    initiator: "agent",
    subagent_type: "general",
    status: "running",
    phase: "main_loop",
    spec: { initialPrompt: "" },
    result: null,
    error: null,
    active_children: 0,
    spawned_total: 0,
    time_created: 1,
    time_updated: 1,
    time_started: 1,
    time_ended: null,
    ...input,
  }
}

describe("session Collab visibility", () => {
  test("active agents remain visible", () => {
    for (const status of ["pending", "running", "blocked_on_children", "waiting_interaction"] as const) {
      const item = agent({ status })
      expect(active(item)).toBe(true)
      expect(visible(item, TERMINAL_TTL * 10)).toBe(true)
    }
  })

  test("terminal agents expire after 30 seconds", () => {
    for (const status of ["completed", "failed", "canceled"] as const) {
      const item = agent({ status, time_ended: 1_000 })
      expect(visible(item, 1_000 + TERMINAL_TTL - 1)).toBe(true)
      expect(visible(item, 1_000 + TERMINAL_TTL)).toBe(false)
      expect(visible(item, 1_000 + TERMINAL_TTL, true)).toBe(true)
    }
  })

  test("terminal agents without an end time use their update time", () => {
    const item = agent({ status: "completed", time_updated: 1_000 })
    expect(visible(item, 1_000 + TERMINAL_TTL - 1)).toBe(true)
    expect(visible(item, 1_000 + TERMINAL_TTL)).toBe(false)
  })

  test("a recent update supersedes an end time from an earlier run", () => {
    const item = agent({ status: "completed", time_ended: 1, time_updated: 10_000 })
    expect(visible(item, 10_000 + TERMINAL_TTL - 1)).toBe(true)
    expect(deadline([item], 10_000)).toBe(10_000 + TERMINAL_TTL)
  })

  test("idle agents are history only", () => {
    const item = agent({ status: "idle", run_id: null, initiator: null })
    expect(historical(item)).toBe(true)
    expect(visible(item, 1_000)).toBe(false)
    expect(visible(item, 1_000, true)).toBe(true)
  })

  test("Collab list keeps completed agents folded by default", () => {
    const running = agent({ status: "running" })
    const completed = agent({ status: "completed" })
    expect(listed(running)).toBe(true)
    expect(listed(completed)).toBe(false)
    expect(listed(completed, true)).toBe(true)
  })

  test("tree keeps expired ancestors of visible descendants", () => {
    const now = TERMINAL_TTL * 2
    const root = agent({ id: "root", parent_agent_id: null, root_agent_id: "root", subagent_type: "controller" })
    const parent = agent({ id: "parent", status: "completed", time_ended: 1 })
    const child = agent({ id: "child", parent_agent_id: "parent", status: "running" })
    const stale = agent({ id: "stale", status: "completed", time_ended: 1 })

    expect(tree(root, [root, parent, child, stale], now).map((item) => item.id)).toEqual(["root", "parent", "child"])
    expect(tree(root, [root, parent, child, stale], now, true).map((item) => item.id)).toEqual([
      "root",
      "parent",
      "child",
      "stale",
    ])
  })

  test("deadline returns the next terminal expiry", () => {
    const now = 100_000
    const later = agent({ id: "later", status: "failed", time_ended: now - 1_000, time_updated: now - 1_000 })
    const next = agent({ id: "next", status: "completed", time_ended: now - 2_000, time_updated: now - 2_000 })
    const expired = agent({
      id: "expired",
      status: "canceled",
      time_ended: now - TERMINAL_TTL,
      time_updated: now - TERMINAL_TTL,
    })
    expect(deadline([later, next, expired, agent()], now)).toBe(now - 2_000 + TERMINAL_TTL)
  })
})
