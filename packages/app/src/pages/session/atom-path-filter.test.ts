import { describe, expect, test } from "bun:test"
import type { ResearchAtomsListResponse } from "@opencode-ai/sdk/v2"

import { scope, stale } from "./atom-path-filter"

type Atom = ResearchAtomsListResponse["atoms"][number]
type Relation = ResearchAtomsListResponse["relations"][number]

const atom = (id: string): Atom => ({
  atom_id: id,
  research_project_id: "project",
  atom_name: id,
  atom_type: "fact",
  atom_claim_path: null,
  atom_evidence_type: "math",
  atom_evidence_status: "pending",
  atom_evidence_path: null,
  atom_evidence_assessment_path: null,
  locked: false,
  article_id: null,
  session_id: null,
  time_created: 0,
  time_updated: 0,
})

const relation = (source: string, target: string): Relation => ({
  atom_id_source: source,
  atom_id_target: target,
  relation_type: "other",
  note: null,
  time_created: 0,
  time_updated: 0,
})

describe("path graph scope", () => {
  const atoms = ["a", "b", "c", "d", "e"].map(atom)
  const relations = [relation("a", "b"), relation("c", "b"), relation("c", "d"), relation("a", "e")]

  test("returns the whole graph without a path", () => {
    const result = scope(atoms, relations)

    expect(result.atoms).toEqual(atoms)
    expect(result.relations).toEqual(relations)
    expect(result.external.size).toBe(0)
  })

  test("includes direct neighbors in either relation direction", () => {
    const result = scope(atoms, relations, new Set(["a", "b"]))

    expect(result.atoms.map((item) => item.atom_id)).toEqual(["a", "b", "c", "e"])
    expect(result.external).toEqual(new Set(["c", "e"]))
  })

  test("keeps internal and crossing edges without expanding beyond one hop", () => {
    const result = scope(atoms, relations, new Set(["a", "b"]))

    expect(result.relations).toEqual([relation("a", "b"), relation("c", "b"), relation("a", "e")])
    expect(result.atoms.some((item) => item.atom_id === "d")).toBe(false)
  })

  test("returns an empty graph for an empty path", () => {
    const result = scope(atoms, relations, new Set())

    expect(result.atoms).toEqual([])
    expect(result.relations).toEqual([])
    expect(result.external.size).toBe(0)
  })
})

describe("path selection lock", () => {
  const paths = [{ research_path_id: "path" }]

  test("keeps the selected path during initialization, refresh, and errors", () => {
    expect(stale("path", paths, { ready: false, loading: false, error: false })).toBe(false)
    expect(stale("path", [], { ready: true, loading: true, error: false })).toBe(false)
    expect(stale("path", [], { ready: true, loading: false, error: true })).toBe(false)
  })

  test("resets only after a successful response confirms deletion", () => {
    expect(stale("path", paths, { ready: true, loading: false, error: false })).toBe(false)
    expect(stale("all", [], { ready: true, loading: false, error: false })).toBe(false)
    expect(stale("path", [], { ready: true, loading: false, error: false })).toBe(true)
  })
})
