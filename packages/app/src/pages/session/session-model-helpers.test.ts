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
  test("ignores remote task callbacks and messages whose parts have not arrived", () => {
    const plan = message({ id: "plan", agent: "plan" })
    const callback = message({ id: "callback", agent: "experiment" })
    const pending = message({ id: "pending", agent: "build" })
    const parts = {
      plan: [{ id: "part-plan", sessionID: "session", messageID: "plan", type: "text", text: "plan" }],
      callback: [
        {
          id: "part-callback",
          sessionID: "session",
          messageID: "callback",
          type: "collab_return",
          kind: "remote_task_terminal",
          headline: "Remote task finished",
          body: "Status: finished",
        },
      ],
    } satisfies Record<string, Part[] | undefined>

    expect(latest([plan, callback, pending], parts)).toBe(plan)
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
