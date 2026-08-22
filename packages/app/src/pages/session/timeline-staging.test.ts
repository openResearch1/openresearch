import { describe, expect, test } from "bun:test"
import { hasStaged, rememberStaged } from "./timeline-staging"

describe("timeline staging", () => {
  test("remembers multiple completed sessions", () => {
    const parent = rememberStaged([], "parent")
    const child = rememberStaged(parent, "child")

    expect(hasStaged(child, "parent")).toBe(true)
    expect(hasStaged(child, "child")).toBe(true)
    expect(rememberStaged(child, "parent")).toBe(child)
  })

  test("bounds completed session history", () => {
    const completed = Array.from({ length: 20 }, (_, index) => `session-${index}`).reduce(rememberStaged, [])
    expect(completed).toHaveLength(16)
    expect(completed[0]).toBe("session-4")
  })
})
