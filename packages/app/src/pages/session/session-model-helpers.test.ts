import { describe, expect, test } from "bun:test"
import type { Part, UserMessage } from "@opencode-ai/sdk/v2"
import { latest, resetSessionModel, syncSessionModel } from "./session-model-helpers"

const message = (input?: Partial<Pick<UserMessage, "id" | "agent" | "model" | "variant">>) =>
  ({
    id: input?.id ?? "msg",
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    agent: input?.agent ?? "build",
    model: input?.model ?? { providerID: "anthropic", modelID: "claude-sonnet-4" },
    variant: input?.variant,
  }) as UserMessage

describe("latest", () => {
  test("ignores pure callbacks and messages whose parts have not arrived", () => {
    const plan = message({ id: "plan", agent: "plan" })
    const remote = message({ id: "remote", agent: "experiment" })
    const child = message({ id: "child", agent: "experiment" })
    const pending = message({ id: "pending", agent: "build" })
    const parts = {
      plan: [{ id: "part-plan", sessionID: "session", messageID: "plan", type: "text", text: "plan" }],
      remote: [
        {
          id: "part-remote",
          sessionID: "session",
          messageID: "remote",
          type: "collab_return",
          kind: "remote_task_terminal",
          headline: "Remote task finished",
          body: "Status: finished",
        },
        {
          id: "part-switch",
          sessionID: "session",
          messageID: "remote",
          type: "text",
          text: "Mode changed",
          synthetic: true,
        },
      ],
      child: [
        {
          id: "part-child",
          sessionID: "session",
          messageID: "child",
          type: "collab_return",
          kind: "child_done",
          headline: "Child finished",
          body: "Complete",
        },
      ],
      pending: [],
    } satisfies Record<string, Part[] | undefined>

    expect(latest([plan, remote, child, pending], parts)).toBe(plan)
  })

  test("keeps user messages that also contain callbacks", () => {
    const experiment = message({ id: "experiment", agent: "experiment" })
    const plan = message({ id: "plan", agent: "plan" })
    const parts = {
      experiment: [
        { id: "part-experiment", sessionID: "session", messageID: "experiment", type: "text", text: "run" },
      ],
      plan: [
        { id: "part-plan", sessionID: "session", messageID: "plan", type: "text", text: "inspect" },
        {
          id: "part-progress",
          sessionID: "session",
          messageID: "plan",
          type: "collab_return",
          kind: "child_progress",
          headline: "Child progress",
          body: "",
        },
      ],
    } satisfies Record<string, Part[] | undefined>

    expect(latest([experiment, plan], parts)).toBe(plan)
  })
})

describe("syncSessionModel", () => {
  test("restores the last message model and variant", () => {
    const calls: unknown[] = []

    syncSessionModel(
      {
        agent: {
          current() {
            return undefined
          },
          set(value) {
            calls.push(["agent", value])
          },
        },
        model: {
          set(value) {
            calls.push(["model", value])
          },
          current() {
            return { id: "claude-sonnet-4", provider: { id: "anthropic" } }
          },
          variant: {
            set(value) {
              calls.push(["variant", value])
            },
          },
        },
      },
      message({ variant: "high" }),
    )

    expect(calls).toEqual([
      ["agent", "build"],
      ["model", { providerID: "anthropic", modelID: "claude-sonnet-4" }],
      ["variant", "high"],
    ])
  })

  test("skips variant when the model falls back", () => {
    const calls: unknown[] = []

    syncSessionModel(
      {
        agent: {
          current() {
            return undefined
          },
          set(value) {
            calls.push(["agent", value])
          },
        },
        model: {
          set(value) {
            calls.push(["model", value])
          },
          current() {
            return { id: "gpt-5", provider: { id: "openai" } }
          },
          variant: {
            set(value) {
              calls.push(["variant", value])
            },
          },
        },
      },
      message({ variant: "high" }),
    )

    expect(calls).toEqual([
      ["agent", "build"],
      ["model", { providerID: "anthropic", modelID: "claude-sonnet-4" }],
    ])
  })
})

describe("resetSessionModel", () => {
  test("restores the current agent defaults", () => {
    const calls: unknown[] = []

    resetSessionModel({
      agent: {
        current() {
          return {
            model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
            variant: "high",
          }
        },
        set() {},
      },
      model: {
        set(value) {
          calls.push(["model", value])
        },
        current() {
          return undefined
        },
        variant: {
          set(value) {
            calls.push(["variant", value])
          },
        },
      },
    })

    expect(calls).toEqual([
      ["model", { providerID: "anthropic", modelID: "claude-sonnet-4" }],
      ["variant", "high"],
    ])
  })

  test("clears the variant when the agent has none", () => {
    const calls: unknown[] = []

    resetSessionModel({
      agent: {
        current() {
          return {
            model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
          }
        },
        set() {},
      },
      model: {
        set(value) {
          calls.push(["model", value])
        },
        current() {
          return undefined
        },
        variant: {
          set(value) {
            calls.push(["variant", value])
          },
        },
      },
    })

    expect(calls).toEqual([
      ["model", { providerID: "anthropic", modelID: "claude-sonnet-4" }],
      ["variant", undefined],
    ])
  })
})
