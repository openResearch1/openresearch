import { Agent } from "@/agent/agent"
import { Session } from "@/session"
import { Database, eq } from "@/storage/db"
import { ControllerAgent } from "./controller-agent"
import { AtomTable, ExperimentTable, ResearchProjectTable } from "./research.sql"

export namespace ResearchSessionAgent {
  const policies = {
    controller: { agents: ["controller"], default: "controller", pinned: true },
    experiment: { agents: ["experiment", "plan", "build"], default: "experiment" },
    atom: { agents: ["plan", "build", "research"], default: "research" },
    main: { agents: ["research", "deep_research", "plan", "build"], default: "research" },
  } as const

  export type Kind = keyof typeof policies
  export type Policy = { kind: Kind; agents: readonly string[]; default: string; pinned?: boolean }

  export async function policy(sessionID: string): Promise<Policy | undefined> {
    const session = await Session.get(sessionID)
    if (ControllerAgent.get(sessionID)) return { kind: "controller", ...policies.controller }

    const experiment = Database.use((db) =>
      db
        .select({ id: ExperimentTable.exp_id })
        .from(ExperimentTable)
        .where(eq(ExperimentTable.exp_session_id, sessionID))
        .get(),
    )
    if (experiment) return { kind: "experiment", ...policies.experiment }

    const atom = Database.use((db) =>
      db.select({ id: AtomTable.atom_id }).from(AtomTable).where(eq(AtomTable.session_id, sessionID)).get(),
    )
    if (atom) return { kind: "atom", ...policies.atom }

    if (session.parentID || session.collabPeer) return
    const project = Database.use((db) =>
      db
        .select({ id: ResearchProjectTable.research_project_id })
        .from(ResearchProjectTable)
        .where(eq(ResearchProjectTable.project_id, session.projectID))
        .get(),
    )
    if (project) return { kind: "main", ...policies.main }
  }

  export async function resolve(input: { sessionID: string; agent?: string }) {
    const current = await policy(input.sessionID)
    if (!current) {
      if (input.agent === "controller") throw new Error("Controller prompts require a dedicated Controller session")
      return input.agent
    }
    if (current.pinned) return current.default

    const name = input.agent ?? current.default
    if ((current.agents as readonly string[]).includes(name)) return name
    if (name === "controller") throw new Error("Controller prompts require a dedicated Controller session")
    const agent = await Agent.get(name)
    if (agent?.hidden) return name
    throw new Error(`${name} is not available in ${current.kind} sessions`)
  }
}
