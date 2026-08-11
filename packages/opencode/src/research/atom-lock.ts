import path from "path"

import { and, Database, eq, or } from "@/storage/db"
import { Instance } from "@/project/instance"

import { AtomTable } from "./research.sql"

export namespace AtomLock {
  export class LockedError extends Error {
    constructor(public readonly atomId: string) {
      super(`Atom is locked and cannot be modified: ${atomId}`)
    }
  }

  export function assert(atom: typeof AtomTable.$inferSelect) {
    if (atom.locked) throw new LockedError(atom.atom_id)
  }

  export function assertId(atomId: string) {
    const atom = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, atomId)).get())
    if (atom) assert(atom)
  }

  export function assertPath(file: string) {
    const target = path.resolve(Instance.directory, file)
    const atom = Database.use((db) =>
      db
        .select({ id: AtomTable.atom_id })
        .from(AtomTable)
        .where(
          and(
            eq(AtomTable.locked, true),
            or(
              eq(AtomTable.atom_claim_path, target),
              eq(AtomTable.atom_evidence_path, target),
              eq(AtomTable.atom_evidence_assessment_path, target),
            ),
          ),
        )
        .get(),
    )
    if (atom) throw new LockedError(atom.id)
  }
}
