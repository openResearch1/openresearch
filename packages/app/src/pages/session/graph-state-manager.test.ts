import { beforeEach, describe, expect, test } from "bun:test"

import { GraphStateManager } from "./graph-state-manager"

describe("graph state scope", () => {
  beforeEach(() => localStorage.clear())

  test("keeps the project graph key and isolates path layouts", () => {
    const all = new GraphStateManager("project")
    const first = new GraphStateManager("project", "first")
    const second = new GraphStateManager("project", "second")
    const state = (id: string) =>
      JSON.stringify({
        positions: { [id]: { x: 1, y: 1 } },
        viewport: { zoom: 1, centerX: 0, centerY: 0 },
        metadata: { timestamp: Date.now(), version: "1.0.0", projectId: "project" },
      })

    localStorage.setItem("graph-state-project", state("all"))
    localStorage.setItem("graph-state-project-path-first", state("first"))
    localStorage.setItem("graph-state-project-path-second", state("second"))

    expect(Object.keys(all.loadState()?.positions ?? {})).toEqual(["all"])
    expect(Object.keys(first.loadState()?.positions ?? {})).toEqual(["first"])
    expect(Object.keys(second.loadState()?.positions ?? {})).toEqual(["second"])
  })
})
