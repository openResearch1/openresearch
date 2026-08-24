import { describe, expect, test } from "bun:test"

import { match } from "./session-retry-state"

describe("session retry state", () => {
  test("ignores missing and non-retry states", () => {
    expect(match(undefined)).toBeUndefined()
    expect(match({ type: "idle" })).toBeUndefined()
    expect(match({ type: "busy" })).toBeUndefined()
  })

  test("returns retry state", () => {
    const status = {
      type: "retry" as const,
      attempt: 2,
      message: "Provider overloaded",
      next: Date.now() + 10_000,
    }

    expect(match(status)).toBe(status)
  })
})
