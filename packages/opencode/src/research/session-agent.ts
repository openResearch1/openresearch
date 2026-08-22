import path from "path"

import { Agent } from "@/agent/agent"
import PROMPT_EXPERIMENT_SESSION_PLAN from "@/agent/prompt/experiment-session-plan.txt"
import PROMPT_RESEARCH_ATOM from "@/agent/prompt/research-atom.txt"
import PROMPT_RESEARCH_MAIN from "@/agent/prompt/research-main.txt"
import { CollabAgentNode } from "@/collab/agent-node"
import { PermissionNext } from "@/permission/next"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { Database, eq } from "@/storage/db"
import { ControllerAgent } from "./controller-agent"
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

  export function approval(input: { sessionID: string; permission: string; actions: ("allow" | "deny" | "ask")[] }) {
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
    if (project) {
      if (role === "research_main") {
        return { kind: "main", ...policies.main, agents: CollabAgentNode.targets(sessionID, "direct") ?? [] }
      }
      return { kind: "main", ...policies.main }
    }
  }

  export async function resolve(input: { sessionID: string; agent?: string }) {
    const context = CollabAgentNode.spawnContext(input.sessionID)
    if (context.controller && context.role === "blocked") {
      throw new Error("This Controller session is blocked by an invalid legacy agent topology")
    }
    if (context.controller && context.role !== "task" && context.role !== "controller" && input.agent) {
      if (!CollabAgentNode.allows(input.sessionID, "direct", input.agent)) {
        throw new Error(`${input.agent} is not available in Controller ${context.role} sessions`)
      }
    }
    if (context.controller && context.role === "leaf") {
      const name = input.agent ?? context.agent
      if (name && CollabAgentNode.allows(input.sessionID, "direct", name)) return name
      throw new Error(`${input.agent ?? "default agent"} is not available in Controller leaf sessions`)
    }
    if (context.controller && context.role === "task") {
      const session = await Session.get(input.sessionID)
      if (!session.parentID) throw new Error("Controller task session has no parent")
      const bound = (await Session.messages({ sessionID: input.sessionID })).find(
        (message) => message.info.role === "user",
      )?.info.agent
      const name = bound ?? input.agent
      if (!name || !CollabAgentNode.allows(session.parentID, "task", name)) {
        throw new Error(`${name ?? "default agent"} is not available in Controller task sessions`)
      }
      if (!bound || !input.agent || input.agent === bound) return name
      throw new Error(`${input.agent} is not available in Controller task sessions`)
    }
    const current = await policy(input.sessionID)
    if (!current) {
      if (input.agent === "controller") throw new Error("Controller prompts require a dedicated Controller session")
      if (context.controller) return input.agent ?? context.agent
      return input.agent
    }
    if (current.pinned) return current.default

    const name = input.agent ?? current.default
    if ((current.agents as readonly string[]).includes(name)) return name
    if (name === "controller") throw new Error("Controller prompts require a dedicated Controller session")
    const agent = await Agent.get(name)
    if (agent?.hidden && !context.controller) return name
    throw new Error(`${name} is not available in ${current.kind} sessions`)
  }

  export async function compose(input: { sessionID: string; agent: Agent.Info }) {
    if (input.agent.name === "plan") {
      const current = await policy(input.sessionID)
      if (current?.kind !== "experiment") return input.agent
      const experiment = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_session_id, input.sessionID)).get(),
      )
      if (!experiment) return input.agent
      const plan = experiment.exp_plan_path
      return {
        ...input.agent,
        prompt: PROMPT_EXPERIMENT_SESSION_PLAN,
        permission: PermissionNext.merge(
          input.agent.permission,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            glob: "allow",
            grep: "allow",
            webfetch: "allow",
            question: "allow",
            plan_exit: "allow",
            experiment_query: "allow",
            atom_query: "allow",
            atom_relation_query: "allow",
            research_code_query: "allow",
            project_runtime_server_query: "allow",
            project_runtime_env_spec_inspect: "allow",
            project_runtime_env_query: "allow",
            project_runtime_resource_query: "allow",
            task: {
              "*": "deny",
              explore: "allow",
            },
            external_directory: {
              "*": "deny",
              [path.join(experiment.code_path, "*").replaceAll("\\", "/")]: "allow",
              ...(plan ? { [path.join(path.dirname(plan), "*").replaceAll("\\", "/")]: "allow" as const } : {}),
            },
            edit: {
              "*": "deny",
              ...(plan ? { [path.relative(Instance.worktree, plan)]: "allow" as const } : {}),
            },
          }),
        ),
      }
    }
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
