import { Agent } from "@/agent/agent"
import PROMPT_RESEARCH_ATOM from "@/agent/prompt/research-atom.txt"
import PROMPT_RESEARCH_MAIN from "@/agent/prompt/research-main.txt"
import { Session } from "@/session"
import { Database, eq } from "@/storage/db"
import { ControllerAgent } from "./controller-agent"
import { CollabAgentNode } from "@/collab/agent-node"
import { AtomTable, ExperimentTable, ResearchProjectTable } from "./research.sql"

export namespace ResearchSessionAgent {
  const policies = {
    controller: { agents: ["controller"], default: "controller", pinned: true },
    reviewer: { agents: ["reviewer"], default: "reviewer", pinned: true },
    experiment: { agents: ["experiment", "plan", "build"], default: "experiment" },
    atom: { agents: ["plan", "build", "research"], default: "research" },
    main: { agents: ["research", "deep_research", "plan", "build"], default: "research" },
  } as const

  export type Kind = keyof typeof policies
  export type Policy = { kind: Kind; agents: readonly string[]; default: string; pinned?: boolean }

  export function approval(input: {
    sessionID: string
    permission: string
    actions: ("allow" | "deny" | "ask")[]
  }) {
    if (input.permission !== "research_doc_edit") return
    const node = CollabAgentNode.loadBySessionId(input.sessionID)
    if (!node || CollabAgentNode.role(node.id) !== "research_main") return
    if (input.actions.some((action) => action === "deny")) return "deny" as const
    if (input.actions.some((action) => action === "ask")) return "allow" as const
  }

  export async function policy(sessionID: string): Promise<Policy | undefined> {
    const session = await Session.get(sessionID)
    if (ControllerAgent.get(sessionID)) return { kind: "controller", ...policies.controller }
    const node = CollabAgentNode.loadBySessionId(sessionID)
    if (node?.subagent_type === "reviewer") {
      return { kind: "reviewer", ...policies.reviewer }
    }

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

    const role = node ? CollabAgentNode.role(node.id) : undefined
    if (session.parentID || (role && role !== "research_main") || (session.collabPeer && role !== "research_main")) {
      return
    }
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

  export async function compose(input: { sessionID: string; agent: Agent.Info }) {
    if (input.agent.name !== "research") return input.agent
    const current = await policy(input.sessionID)
    if (current && current.kind !== "atom" && current.kind !== "main") return input.agent
    const session = await Session.get(input.sessionID)
    const project = Database.use((db) =>
      db
        .select({ id: ResearchProjectTable.research_project_id })
        .from(ResearchProjectTable)
        .where(eq(ResearchProjectTable.project_id, session.projectID))
        .get(),
    )
    const kind = current?.kind ?? (project ? "main" : undefined)
    if (kind !== "atom" && kind !== "main") return input.agent
    const delegated =
      kind === "main" && current?.kind !== "main"
        ? [
            "## Delegated Research constraint",
            "You are an independent Research peer, not the owning Main Session. Read project Paths for context, but do not create, update, complete, or cancel them. Return durable Atom and evidence changes plus a concise handoff to your parent.",
          ].join("\n\n")
        : undefined
    return {
      ...input.agent,
      prompt: [input.agent.prompt, kind === "atom" ? PROMPT_RESEARCH_ATOM : PROMPT_RESEARCH_MAIN, delegated]
        .filter(Boolean)
        .join("\n\n"),
    }
  }
}
