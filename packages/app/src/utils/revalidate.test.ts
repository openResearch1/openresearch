import { describe, expect, test } from "bun:test"
import { settle } from "./revalidate"

describe("revalidation", () => {
  test("retries a snapshot changed by a concurrent event", async () => {
    let version = 0
    let calls = 0
    const value = await settle(
      () => version,
      async () => {
        calls += 1
        if (calls === 1) version += 1
        return calls
      },
      2,
      0,
    )

    expect(value).toBe(2)
    expect(calls).toBe(2)
  })

  test("rejects snapshots while events continue changing the store", async () => {
    let version = 0
    const value = await settle(
      () => version,
      async () => {
        version += 1
        return version
      },
      2,
      0,
    )

    expect(value).toBeUndefined()
  })
})
