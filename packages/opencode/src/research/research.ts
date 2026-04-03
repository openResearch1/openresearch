import { Session } from "@/session"
import { Database, eq } from "../storage/db"
import { ResearchProjectTable } from "./research.sql"
import { BusEvent } from "@/bus/bus-event"
import z from "zod"

export namespace Research {
  export const Event = {
    AtomsUpdated: BusEvent.define(
      "research.atoms.updated",
      z.object({
        researchProjectId: z.string(),
      }),
    ),
  }
  export async function getParentSessionId(sessionID: string): Promise<string | undefined> {
    let current = await Session.get(sessionID)

    while (current.parentID) {
      current = await Session.get(current.parentID)
    }
    return current.id
  }

  export async function getResearchProjectId(sessionID: string): Promise<string | undefined> {
    let current = await Session.get(sessionID)

    while (current.parentID) {
      current = await Session.get(current.parentID)
    }

    const research = Database.use((db) =>
      db
        .select({ research_project_id: ResearchProjectTable.research_project_id })
        .from(ResearchProjectTable)
        .where(eq(ResearchProjectTable.project_id, current.projectID))
        .get(),
    )

    return research?.research_project_id
  }

  export function getResearchProject(researchProjectId: string) {
    return Database.use((db) =>
      db
        .select()
        .from(ResearchProjectTable)
        .where(eq(ResearchProjectTable.research_project_id, researchProjectId))
        .get(),
    )
  }

  export function updateBackgroundPath(researchProjectId: string, backgroundPath: string) {
    Database.use((db) =>
      db
        .update(ResearchProjectTable)
        .set({ background_path: backgroundPath, time_updated: Date.now() })
        .where(eq(ResearchProjectTable.research_project_id, researchProjectId))
        .run(),
    )
  }

  export function updateGoalPath(researchProjectId: string, goalPath: string) {
    Database.use((db) =>
      db
        .update(ResearchProjectTable)
        .set({ goal_path: goalPath, time_updated: Date.now() })
        .where(eq(ResearchProjectTable.research_project_id, researchProjectId))
        .run(),
    )
  }

  export function updateMacroTablePath(researchProjectId: string, macroTablePath: string) {
    Database.use((db) =>
      db
        .update(ResearchProjectTable)
        .set({ macro_table_path: macroTablePath, time_updated: Date.now() })
        .where(eq(ResearchProjectTable.research_project_id, researchProjectId))
        .run(),
    )
  }
}
