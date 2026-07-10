import { afterEach, describe, expect, test } from "bun:test"
import { assertPassword, requiresPassword } from "../../src/cli/network"

const original = process.env.OPENCODE_SERVER_PASSWORD

afterEach(() => {
  if (original === undefined) {
    delete process.env.OPENCODE_SERVER_PASSWORD
    return
  }
  process.env.OPENCODE_SERVER_PASSWORD = original
})

describe("network password policy", () => {
  test("allows loopback without a password", () => {
    delete process.env.OPENCODE_SERVER_PASSWORD

    expect(requiresPassword({ hostname: "127.0.0.1" })).toBe(false)
    expect(() => assertPassword({ hostname: "127.0.0.1" })).not.toThrow()
  })

  test("requires a password for network hosts", () => {
    delete process.env.OPENCODE_SERVER_PASSWORD

    expect(requiresPassword({ hostname: "0.0.0.0" })).toBe(true)
    expect(() => assertPassword({ hostname: "0.0.0.0" })).toThrow("OPENCODE_SERVER_PASSWORD")
  })

  test("requires a password for mdns", () => {
    delete process.env.OPENCODE_SERVER_PASSWORD

    expect(requiresPassword({ hostname: "127.0.0.1", mdns: true })).toBe(true)
    expect(() => assertPassword({ hostname: "127.0.0.1", mdns: true })).toThrow("OPENCODE_SERVER_PASSWORD")
  })

  test("accepts network hosts with a password", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "secret"

    expect(() => assertPassword({ hostname: "0.0.0.0" })).not.toThrow()
  })
})
