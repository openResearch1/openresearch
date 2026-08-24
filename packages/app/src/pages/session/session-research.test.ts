import { describe, expect, test } from "bun:test"
import { getSessionResearch, primeSessionResearch, type SessionResearchSnapshot } from "./session-research"

describe("session research cache", () => {
  test("isolates snapshots by directory", () => {
    const value: SessionResearchSnapshot = { project: null, atom: null, experiment: null }
    primeSessionResearch({ directory: "/one", sessionID: "session", projectID: "project", value })

    expect(getSessionResearch("/one", "session", "project")).toBe(value)
    expect(getSessionResearch("/two", "session", "project")).toBeUndefined()
  })
})
