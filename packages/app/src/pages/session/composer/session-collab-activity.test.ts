import { describe, expect, test } from "bun:test"
import type { CollabAgent } from "@opencode-ai/sdk/v2/client"
import { canStopController, failure, isAgentControlled } from "./session-collab-control"

function agent(input?: Partial<CollabAgent>): CollabAgent {
  return {
    id: "experiment",
    session_id: "session",
    parent_agent_id: "atom",
    name: "Experiment",
    project_id: "project",
    root_agent_id: "atom",
    run_id: "run",
    initiator: "agent",
    subagent_type: "experiment",
    status: "running",
    phase: "main_loop",
    spec: { initialPrompt: "", metadata: { atomId: "atom", expId: "experiment" } },
    result: null,
    error: null,
    active_children: 1,
    spawned_total: 1,
    time_created: 1,
    time_updated: 1,
    time_started: 1,
    time_ended: null,
    ...input,
  }
}

describe("session Collab control", () => {
  test("projects canceled failures to canceled status", () => {
    expect(failure("CANCELED")).toBe("canceled")
    expect(failure("MODEL_ERROR")).toBe("failed")
  })

  test("only agent-initiated active experiments are controlled", () => {
    expect(isAgentControlled(agent())).toBe(true)
    expect(isAgentControlled(agent({ initiator: "human" }))).toBe(false)
    expect(isAgentControlled(agent({ initiator: null }))).toBe(true)
    expect(isAgentControlled(agent({ status: "idle", initiator: null, run_id: null }))).toBe(false)
  })

  test("parented Atom agents remain controlled", () => {
    expect(
      isAgentControlled(
        agent({
          subagent_type: "research",
          spec: { initialPrompt: "", metadata: { atomId: "atom" } },
        }),
      ),
    ).toBe(true)
  })

  test("only active dedicated Controller roots can be stopped", () => {
    const root = agent({
      id: "controller",
      parent_agent_id: null,
      root_agent_id: "controller",
      subagent_type: "controller",
      spec: { initialPrompt: "", metadata: {} },
    })

    expect(canStopController(root, true)).toBe(true)
    expect(canStopController(root, false)).toBe(false)
    expect(canStopController(agent({ status: "completed" }), true)).toBe(false)
  })
})
