export type AtomFileKind = "claim" | "evidence" | "assessment"

export type AtomFile = {
  id: string
  kind: AtomFileKind
}

const names: Record<string, AtomFileKind> = {
  "claim.md": "claim",
  "evidence.md": "evidence",
  "evidence_assessment.md": "assessment",
}

export function atomFile(input: unknown): AtomFile | undefined {
  if (typeof input !== "string") return
  const parts = input.replaceAll("\\", "/").split("/")
  if (parts.length < 3) return
  const name = parts.at(-1)!
  const kind = names[name]
  if (!kind) return
  if (parts.at(-3) !== "atom_list") return
  const id = parts.at(-2)
  if (!id) return
  return { id, kind }
}
