import z from "zod"

import { Bus } from "@/bus"
import { Identifier } from "@/id/id"
import { Database, and, desc, eq, inArray } from "@/storage/db"
import { AtomRelationTable, AtomTable, linkKinds, normalizeLinks } from "./research.sql"
import {
  ResearchPathAtomTable,
  ResearchPathTable,
  researchPathAtomRoles,
  researchPathStatuses,
} from "./research-path.sql"

export namespace ResearchPath {
  export const Status = z.enum(researchPathStatuses)
  export const Role = z.enum(researchPathAtomRoles)
  export const Member = z.object({
    role: Role,
    atom_id: z.string(),
    atom_name: z.string(),
    atom_type: z.enum(["fact", "method", "theorem", "verification"]),
    atom_evidence_type: z.enum(["math", "experiment"]),
    atom_evidence_status: z.enum(["pending", "in_progress", "proven", "disproven"]),
    locked: z.boolean(),
    session_id: z.string().nullable(),
  })
  export const Relation = z.object({
    atom_id_source: z.string(),
    atom_id_target: z.string(),
    relation_type: z.enum(linkKinds),
    note: z.string().nullable(),
  })
  export const Stage = z.object({
    index: z.number(),
    groups: z.array(
      z.object({
        atom_ids: z.string().array(),
        cyclic: z.boolean(),
      }),
    ),
  })
  export const Info = z.object({
    research_path_id: z.string(),
    research_project_id: z.string(),
    creator_session_id: z.string(),
    title: z.string(),
    brief: z.string(),
    summary: z.string().nullable(),
    status: Status,
    time_created: z.number(),
    time_updated: z.number(),
    atoms: Member.array(),
    relations: Relation.array(),
    stages: Stage.array(),
  })

  export type Info = z.infer<typeof Info>
  export type Member = z.infer<typeof Member>
  export type Relation = z.infer<typeof Relation>

  export const Input = z.object({
    atomID: z.string(),
    role: Role.default("member"),
  })

  const ordered = new Set(["motivates", "grounds", "formalized_by", "derives", "analyzed_by", "evaluated_by"])

  export function sequence(atoms: Member[], relations: Relation[]) {
    const data = new Map(atoms.map((atom) => [atom.atom_id, atom]))
    const compare = (a: string, b: string) => {
      const left = data.get(a)!
      const right = data.get(b)!
      return Number(right.role === "seed") - Number(left.role === "seed") || left.atom_name.localeCompare(right.atom_name) || a.localeCompare(b)
    }
    const ids = atoms.map((atom) => atom.atom_id).sort(compare)
    const edges = relations.filter(
      (relation) =>
        ordered.has(relation.relation_type) &&
        data.has(relation.atom_id_source) &&
        data.has(relation.atom_id_target),
    )
    const graph = new Map(ids.map((id) => [id, new Set<string>()]))
    edges.forEach((relation) => graph.get(relation.atom_id_source)!.add(relation.atom_id_target))

    let cursor = 0
    const indexes = new Map<string, number>()
    const lows = new Map<string, number>()
    const stack: string[] = []
    const active = new Set<string>()
    const groups: string[][] = []
    const visit = (id: string) => {
      indexes.set(id, cursor)
      lows.set(id, cursor)
      cursor++
      stack.push(id)
      active.add(id)

      for (const target of [...graph.get(id)!].sort(compare)) {
        if (!indexes.has(target)) {
          visit(target)
          lows.set(id, Math.min(lows.get(id)!, lows.get(target)!))
          continue
        }
        if (active.has(target)) lows.set(id, Math.min(lows.get(id)!, indexes.get(target)!))
      }

      if (lows.get(id) !== indexes.get(id)) return
      const group: string[] = []
      while (stack.length) {
        const atom = stack.pop()!
        active.delete(atom)
        group.push(atom)
        if (atom === id) break
      }
      groups.push(group.sort(compare))
    }
    ids.forEach((id) => {
      if (!indexes.has(id)) visit(id)
    })

    const owners = new Map(groups.flatMap((group, index) => group.map((id) => [id, index] as const)))
    const outgoing = groups.map(() => new Set<number>())
    const incoming = groups.map(() => 0)
    edges.forEach((relation) => {
      const source = owners.get(relation.atom_id_source)!
      const target = owners.get(relation.atom_id_target)!
      if (source === target || outgoing[source].has(target)) return
      outgoing[source].add(target)
      incoming[target]++
    })
    const compareGroups = (a: number, b: number) => compare(groups[a][0], groups[b][0])
    let ready = incoming
      .map((count, index) => ({ count, index }))
      .filter((item) => item.count === 0)
      .map((item) => item.index)
      .sort(compareGroups)
    const result: z.infer<typeof Stage>[] = []
    while (ready.length) {
      result.push({
        index: result.length + 1,
        groups: ready.map((index) => ({
          atom_ids: groups[index],
          cyclic:
            groups[index].length > 1 ||
            edges.some(
              (relation) =>
                relation.atom_id_source === groups[index][0] && relation.atom_id_target === groups[index][0],
            ),
        })),
      })
      const next = new Set<number>()
      ready.forEach((source) => {
        outgoing[source].forEach((target) => {
          incoming[target]--
          if (incoming[target] === 0) next.add(target)
        })
      })
      ready = [...next].sort(compareGroups)
    }
    return result
  }

  function hydrate(paths: (typeof ResearchPathTable.$inferSelect)[]) {
    if (!paths.length) return []
    const ids = paths.map((item) => item.research_path_id)
    const members = Database.use((db) =>
      db
        .select({
          research_path_id: ResearchPathAtomTable.research_path_id,
          role: ResearchPathAtomTable.role,
          atom_id: AtomTable.atom_id,
          atom_name: AtomTable.atom_name,
          atom_type: AtomTable.atom_type,
          atom_evidence_type: AtomTable.atom_evidence_type,
          atom_evidence_status: AtomTable.atom_evidence_status,
          locked: AtomTable.locked,
          session_id: AtomTable.session_id,
        })
        .from(ResearchPathAtomTable)
        .innerJoin(AtomTable, eq(AtomTable.atom_id, ResearchPathAtomTable.atom_id))
        .where(inArray(ResearchPathAtomTable.research_path_id, ids))
        .all(),
    )
    const atomIDs = [...new Set(members.map((item) => item.atom_id))]
    const relations = atomIDs.length
      ? normalizeLinks(
          Database.use((db) =>
          db
            .select({
              atom_id_source: AtomRelationTable.atom_id_source,
              atom_id_target: AtomRelationTable.atom_id_target,
              relation_type: AtomRelationTable.relation_type,
              note: AtomRelationTable.note,
            })
            .from(AtomRelationTable)
            .where(
              and(
                inArray(AtomRelationTable.atom_id_source, atomIDs),
                inArray(AtomRelationTable.atom_id_target, atomIDs),
              ),
            )
            .all(),
          ),
        )
      : []
    return paths.map((path) => {
      const atoms = members
        .filter((item) => item.research_path_id === path.research_path_id)
        .map(({ research_path_id: _, ...item }) => item)
        .sort((a, b) => Number(b.role === "seed") - Number(a.role === "seed") || a.atom_name.localeCompare(b.atom_name))
      const set = new Set(atoms.map((item) => item.atom_id))
      const links = relations.filter((item) => set.has(item.atom_id_source) && set.has(item.atom_id_target))
      return {
        ...path,
        atoms,
        relations: links,
        stages: sequence(atoms, links),
      }
    })
  }

  export function list(researchProjectID: string) {
    return hydrate(
      Database.use((db) =>
        db
          .select()
          .from(ResearchPathTable)
          .where(eq(ResearchPathTable.research_project_id, researchProjectID))
          .orderBy(desc(ResearchPathTable.time_updated))
          .all(),
      ),
    )
  }

  export function get(researchProjectID: string, researchPathID: string) {
    return hydrate(
      Database.use((db) =>
        db
          .select()
          .from(ResearchPathTable)
          .where(
            and(
              eq(ResearchPathTable.research_project_id, researchProjectID),
              eq(ResearchPathTable.research_path_id, researchPathID),
            ),
          )
          .all(),
      ),
    )[0]
  }

  export async function project(sessionID: string) {
    const { Research } = await import("./research")
    return Research.getResearchProjectId(sessionID)
  }

  async function access(input: { sessionID: string; agent: string }) {
    const { ResearchSessionAgent } = await import("./session-agent")
    const policy = await ResearchSessionAgent.policy(input.sessionID)
    if (policy?.kind !== "main") throw new Error("Research Paths can only be changed from a main Research session")
    if (input.agent !== "research") throw new Error("Research Paths can only be changed by the research agent")
    const researchProjectID = await project(input.sessionID)
    if (!researchProjectID) throw new Error("Session is not part of a Research Project")
    return researchProjectID
  }

  function atoms(tx: Database.TxOrDb, researchProjectID: string, items: z.infer<typeof Input>[]) {
    const ids = items.map((item) => item.atomID)
    if (new Set(ids).size !== ids.length) throw new Error("A Research Path cannot contain duplicate Atoms")
    if (!ids.length) return
    const count = tx
      .select({ atom_id: AtomTable.atom_id })
      .from(AtomTable)
      .where(and(eq(AtomTable.research_project_id, researchProjectID), inArray(AtomTable.atom_id, ids)))
      .all().length
    if (count !== ids.length) throw new Error("Every Atom must belong to the same Research Project as the Path")
  }

  function owned(tx: Database.TxOrDb, input: { researchProjectID: string; researchPathID: string; sessionID: string }) {
    const path = tx
      .select()
      .from(ResearchPathTable)
      .where(
        and(
          eq(ResearchPathTable.research_project_id, input.researchProjectID),
          eq(ResearchPathTable.research_path_id, input.researchPathID),
        ),
      )
      .get()
    if (!path) throw new Error("Research Path not found")
    if (path.creator_session_id !== input.sessionID) throw new Error("Only the creating Session can change this Research Path")
    if (path.status !== "active") throw new Error("Completed or cancelled Research Paths cannot be changed")
    return path
  }

  function publish(researchProjectID: string, researchPathID: string) {
    Database.effect(async () => {
      const { Research } = await import("./research")
      return Bus.publish(Research.Event.PathsUpdated, {
        researchProjectId: researchProjectID,
        researchPathId: researchPathID,
      })
    })
  }

  export async function create(input: {
    sessionID: string
    agent: string
    title: string
    brief: string
    summary?: string
    atoms: z.infer<typeof Input>[]
  }) {
    const researchProjectID = await access(input)
    const researchPathID = Identifier.ascending("research_path")
    Database.transaction((tx) => {
      atoms(tx, researchProjectID, input.atoms)
      tx.insert(ResearchPathTable)
        .values({
          research_path_id: researchPathID,
          research_project_id: researchProjectID,
          creator_session_id: input.sessionID,
          title: input.title,
          brief: input.brief,
          summary: input.summary,
        })
        .run()
      if (input.atoms.length)
        tx.insert(ResearchPathAtomTable)
          .values(
            input.atoms.map((item) => ({
              research_path_id: researchPathID,
              atom_id: item.atomID,
              role: item.role,
            })),
          )
          .run()
      publish(researchProjectID, researchPathID)
    })
    return get(researchProjectID, researchPathID)!
  }

  export async function update(input: {
    sessionID: string
    agent: string
    researchPathID: string
    title?: string
    brief?: string
    summary?: string | null
    add: z.infer<typeof Input>[]
    remove: string[]
  }) {
    const researchProjectID = await access(input)
    Database.transaction((tx) => {
      owned(tx, { ...input, researchProjectID })
      atoms(tx, researchProjectID, input.add)
      if (input.remove.length)
        tx.delete(ResearchPathAtomTable)
          .where(
            and(
              eq(ResearchPathAtomTable.research_path_id, input.researchPathID),
              inArray(ResearchPathAtomTable.atom_id, input.remove),
            ),
          )
          .run()
      if (input.add.length)
        tx.delete(ResearchPathAtomTable)
          .where(
            and(
              eq(ResearchPathAtomTable.research_path_id, input.researchPathID),
              inArray(
                ResearchPathAtomTable.atom_id,
                input.add.map((item) => item.atomID),
              ),
            ),
          )
          .run()
      if (input.add.length)
        tx.insert(ResearchPathAtomTable)
          .values(
            input.add.map((item) => ({
              research_path_id: input.researchPathID,
              atom_id: item.atomID,
              role: item.role,
            })),
          )
          .run()
      const patch = {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.brief === undefined ? {} : { brief: input.brief }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        time_updated: Date.now(),
      }
      tx.update(ResearchPathTable)
        .set(patch)
        .where(eq(ResearchPathTable.research_path_id, input.researchPathID))
        .run()
      publish(researchProjectID, input.researchPathID)
    })
    return get(researchProjectID, input.researchPathID)!
  }

  export async function transition(input: {
    sessionID: string
    agent: string
    researchPathID: string
    status: "completed" | "cancelled"
    summary?: string
  }) {
    const researchProjectID = await access(input)
    Database.transaction((tx) => {
      owned(tx, { ...input, researchProjectID })
      tx.update(ResearchPathTable)
        .set({
          status: input.status,
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          time_updated: Date.now(),
        })
        .where(eq(ResearchPathTable.research_path_id, input.researchPathID))
        .run()
      publish(researchProjectID, input.researchPathID)
    })
    return get(researchProjectID, input.researchPathID)!
  }
}
