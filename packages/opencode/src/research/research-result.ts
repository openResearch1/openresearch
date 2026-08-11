import z from "zod"

import { Bus } from "@/bus"
import { CollabAgentNode } from "@/collab/agent-node"
import { Database, and, desc, eq, inArray } from "@/storage/db"
import { AtomRelationTable, AtomTable, linkKinds, normalizeLinks } from "./research.sql"
import { ResearchResultTable, type ResearchResultAtom } from "./research-result.sql"
import { Research } from "./research"

export namespace ResearchResult {
  export const Atom = z.object({
    atom_id: z.string(),
    atom_name: z.string(),
    available: z.boolean(),
    atom_type: z.enum(["fact", "method", "theorem", "verification"]).nullable(),
    atom_evidence_type: z.enum(["math", "experiment"]).nullable(),
    atom_evidence_status: z.enum(["pending", "in_progress", "proven", "disproven"]).nullable(),
    locked: z.boolean().nullable(),
    session_id: z.string().nullable(),
  })
  export const Relation = z.object({
    atom_id_source: z.string(),
    atom_id_target: z.string(),
    relation_type: z.enum(linkKinds),
    note: z.string().nullable(),
  })
  export const Info = z.object({
    research_result_id: z.string(),
    research_project_id: z.string(),
    source_session_id: z.string(),
    reviewer_session_id: z.string(),
    title: z.string(),
    summary: z.string(),
    evaluation: z.string(),
    time_created: z.number(),
    time_updated: z.number(),
    atoms: Atom.array(),
    relations: Relation.array(),
  })

  export type Info = z.infer<typeof Info>

  function hydrate(rows: (typeof ResearchResultTable.$inferSelect)[]) {
    if (!rows.length) return []
    const ids = [...new Set(rows.flatMap((row) => row.atoms_json.map((atom) => atom.atom_id)))]
    const atoms = ids.length
      ? Database.use((db) => db.select().from(AtomTable).where(inArray(AtomTable.atom_id, ids)).all())
      : []
    const current = new Map(atoms.map((atom) => [atom.atom_id, atom]))
    const relations = ids.length
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
                and(inArray(AtomRelationTable.atom_id_source, ids), inArray(AtomRelationTable.atom_id_target, ids)),
              )
              .all(),
          ),
        )
      : []

    return rows.map((row) => {
      const members = row.atoms_json.map((saved) => {
        const atom = current.get(saved.atom_id)
        if (!atom || atom.research_project_id !== row.research_project_id) {
          return {
            ...saved,
            available: false,
            atom_type: null,
            atom_evidence_type: null,
            atom_evidence_status: null,
            locked: null,
            session_id: null,
          }
        }
        return {
          atom_id: atom.atom_id,
          atom_name: atom.atom_name,
          available: true,
          atom_type: atom.atom_type,
          atom_evidence_type: atom.atom_evidence_type,
          atom_evidence_status: atom.atom_evidence_status,
          locked: atom.locked,
          session_id: atom.session_id,
        }
      })
      const set = new Set(members.map((atom) => atom.atom_id))
      return {
        research_result_id: row.research_result_id,
        research_project_id: row.research_project_id,
        source_session_id: row.source_session_id,
        reviewer_session_id: row.reviewer_session_id,
        title: row.title,
        summary: row.summary,
        evaluation: row.evaluation,
        time_created: row.time_created,
        time_updated: row.time_updated,
        atoms: members,
        relations: relations.filter((relation) => set.has(relation.atom_id_source) && set.has(relation.atom_id_target)),
      }
    })
  }

  export function list(researchProjectID: string) {
    return hydrate(
      Database.use((db) =>
        db
          .select()
          .from(ResearchResultTable)
          .where(eq(ResearchResultTable.research_project_id, researchProjectID))
          .orderBy(desc(ResearchResultTable.time_created))
          .all(),
      ),
    )
  }

  export function get(researchProjectID: string, researchResultID: string) {
    return hydrate(
      Database.use((db) =>
        db
          .select()
          .from(ResearchResultTable)
          .where(
            and(
              eq(ResearchResultTable.research_project_id, researchProjectID),
              eq(ResearchResultTable.research_result_id, researchResultID),
            ),
          )
          .all(),
      ),
    )[0]
  }

  export async function project(sessionID: string) {
    return Research.getResearchProjectId(sessionID)
  }

  export async function submit(input: {
    sessionID: string
    agent: string
    atomIDs: string[]
    title: string
    summary: string
    evaluation: string
  }) {
    if (input.agent !== "reviewer") throw new Error("Research results can only be submitted by the Reviewer")
    const reviewer = CollabAgentNode.loadBySessionId(input.sessionID)
    if (reviewer?.subagent_type !== "reviewer" || !reviewer.parent_agent_id) {
      throw new Error("Research results require a delegated Reviewer session")
    }
    const marker = reviewer.spec.initialPrompt.match(/^EXACT_REVIEW_ATOM_IDS=(\[[^\n]*\])$/m)?.[1]
    if (!marker) throw new Error("Reviewer task is missing the exact Atom subset marker")
    const parsed = (() => {
      try {
        return z.array(z.string()).min(1).safeParse(JSON.parse(marker))
      } catch {
        return undefined
      }
    })()
    if (!parsed?.success || new Set(parsed.data).size !== parsed.data.length) {
      throw new Error("Reviewer task has an invalid exact Atom subset marker")
    }
    if ([...parsed.data].sort().join("\n") !== [...input.atomIDs].sort().join("\n")) {
      throw new Error("Reviewer must accept or reject the exact assigned Atom subset")
    }
    const source = CollabAgentNode.load(reviewer.parent_agent_id)
    const researchProjectID = await project(input.sessionID)
    if (!researchProjectID) throw new Error("Reviewer Session is not part of a Research Project")
    if (!input.atomIDs.length) throw new Error("A Research Result must contain at least one Atom")
    if (new Set(input.atomIDs).size !== input.atomIDs.length) {
      throw new Error("A Research Result cannot contain duplicate Atoms")
    }

    const existing = Database.use((db) =>
      db.select().from(ResearchResultTable).where(eq(ResearchResultTable.reviewer_session_id, input.sessionID)).get(),
    )
    if (existing) {
      const same =
        existing.title === input.title.trim() &&
        existing.summary === input.summary.trim() &&
        existing.evaluation === input.evaluation.trim() &&
        existing.atoms_json
          .map((atom) => atom.atom_id)
          .sort()
          .join("\n") === [...input.atomIDs].sort().join("\n")
      if (!same) throw new Error("This Reviewer Session already submitted a different Research Result")
      return get(researchProjectID, existing.research_result_id)!
    }

    const id = crypto.randomUUID()
    const now = Date.now()
    Database.transaction((tx) => {
      const atoms = tx
        .select()
        .from(AtomTable)
        .where(and(eq(AtomTable.research_project_id, researchProjectID), inArray(AtomTable.atom_id, input.atomIDs)))
        .all()
      if (atoms.length !== input.atomIDs.length) {
        throw new Error("Every submitted Atom must belong to the current Research Project")
      }
      if (atoms.some((atom) => atom.atom_evidence_status !== "proven")) {
        throw new Error("Every submitted Atom must have proven evidence status")
      }
      const names = new Map(atoms.map((atom) => [atom.atom_id, atom.atom_name]))
      const saved: ResearchResultAtom[] = input.atomIDs.map((atomID) => ({
        atom_id: atomID,
        atom_name: names.get(atomID)!,
      }))
      tx.insert(ResearchResultTable)
        .values({
          research_result_id: id,
          research_project_id: researchProjectID,
          source_session_id: source.session_id,
          reviewer_session_id: input.sessionID,
          title: input.title.trim(),
          summary: input.summary.trim(),
          evaluation: input.evaluation.trim(),
          atoms_json: saved,
          time_created: now,
          time_updated: now,
        })
        .run()
      tx.update(AtomTable)
        .set({ locked: true, time_updated: now })
        .where(inArray(AtomTable.atom_id, input.atomIDs))
        .run()
      Database.effect(() =>
        Promise.all([
          Bus.publish(Research.Event.ResultsUpdated, {
            researchProjectId: researchProjectID,
            researchResultId: id,
          }),
          Bus.publish(Research.Event.AtomsUpdated, { researchProjectId: researchProjectID }),
        ]),
      )
    })
    return get(researchProjectID, id)!
  }
}
