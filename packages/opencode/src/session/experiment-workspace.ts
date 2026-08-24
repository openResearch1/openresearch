import { CollabAgentNode } from "@/collab/agent-node"
import { ExperimentTable } from "@/research/research.sql"
import { Database, eq } from "@/storage/db"
import PROMPT_EXPERIMENT_CODE from "./prompt/experiment-code-editing.txt"
import { SessionTable } from "./session.sql"

function root(sessionID: string): string {
  const session = Database.use((db) =>
    db.select({ parent_id: SessionTable.parent_id }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
  )
  if (!session?.parent_id) return sessionID
  return root(session.parent_id)
}

export namespace ExperimentWorkspace {
  export function resolve(sessionID: string) {
    const parent = root(sessionID)
    const direct = Database.use((db) =>
      db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_session_id, parent)).get(),
    )
    if (direct) return direct

    const seen = new Set<string>()
    let node = CollabAgentNode.loadBySessionId(parent)
    while (node && !seen.has(node.id)) {
      seen.add(node.id)
      const ancestor = root(node.session_id)
      const experiment = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_session_id, ancestor)).get(),
      )
      if (experiment) return experiment
      node = node.parent_agent_id ? CollabAgentNode.tryLoad(node.parent_agent_id) : undefined
    }
  }

  export function prompt(sessionID: string, agent: string) {
    const experiment = resolve(sessionID)
    if (!experiment) return
    const workspace = `<experiment-workspace code_path=${JSON.stringify(experiment.code_path)}>Use code_path for experiment code operations. Other workspace files may be read for context.</experiment-workspace>`
    if (agent === "plan") {
      return `<experiment-workspace code_path=${JSON.stringify(experiment.code_path)} exp_plan_path=${JSON.stringify(experiment.exp_plan_path)}>Use code_path for read-only experiment inspection. All files are read-only unless the user explicitly requests plan persistence; then only exp_plan_path may be edited.</experiment-workspace>`
    }
    if (agent === "project_runtime_env_setup" || agent === "experiment_resource_prepare") return workspace
    return [workspace, PROMPT_EXPERIMENT_CODE].join("\n\n")
  }
}
