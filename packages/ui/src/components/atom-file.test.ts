import { describe, expect, test } from "bun:test"

import { dict as en } from "../i18n/en"
import { dict as zh } from "../i18n/zh"
import { atomFile } from "./atom-file"

describe("atom file", () => {
  test("recognizes atom content paths", () => {
    expect(atomFile("/project/atom_list/atom-1/claim.md")).toEqual({ id: "atom-1", kind: "claim" })
    expect(atomFile("atom_list/atom-2/evidence.md")).toEqual({ id: "atom-2", kind: "evidence" })
    expect(atomFile("C:\\project\\atom_list\\atom-3\\evidence_assessment.md")).toEqual({
      id: "atom-3",
      kind: "assessment",
    })
  })

  test("rejects unrelated files", () => {
    expect(atomFile("/project/claim.md")).toBeUndefined()
    expect(atomFile("/project/atom_list/atom-1/notes.md")).toBeUndefined()
    expect(atomFile("/project/other/atom-1/evidence.md")).toBeUndefined()
  })

  test("provides labels in English and Chinese", () => {
    const keys = ["ui.tool.research.claim", "ui.tool.research.evidence", "ui.tool.research.assessment"] as const
    for (const key of keys) {
      expect(en[key]).toBeTruthy()
      expect(zh[key]).toBeTruthy()
    }
  })
})
