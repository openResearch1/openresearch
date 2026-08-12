import type { ResearchAtomsListResponse } from "@opencode-ai/sdk/v2"

type Atom = ResearchAtomsListResponse["atoms"][number]
type Relation = ResearchAtomsListResponse["relations"][number]

export function stale(
  id: string,
  paths: readonly { research_path_id: string }[] | undefined,
  state: { ready: boolean; loading: boolean; error: boolean },
) {
  if (!state.ready || state.loading || state.error || !paths || id === "all") return false
  return !paths.some((path) => path.research_path_id === id)
}

export function scope(atoms: Atom[], relations: Relation[], members?: ReadonlySet<string>) {
  if (!members) return { atoms, relations, external: new Set<string>() }

  const ids = new Set(atoms.map((atom) => atom.atom_id))
  const external = relations.reduce((result, relation) => {
    const source = members.has(relation.atom_id_source)
    const target = members.has(relation.atom_id_target)
    if (source === target) return result

    const id = source ? relation.atom_id_target : relation.atom_id_source
    if (ids.has(id)) result.add(id)
    return result
  }, new Set<string>())
  const visible = new Set([...members, ...external])

  return {
    atoms: atoms.filter((atom) => visible.has(atom.atom_id)),
    relations: relations.filter(
      (relation) =>
        visible.has(relation.atom_id_source) &&
        visible.has(relation.atom_id_target) &&
        (members.has(relation.atom_id_source) || members.has(relation.atom_id_target)),
    ),
    external,
  }
}
