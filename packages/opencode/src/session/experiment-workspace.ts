import { CollabAgentNode } from "@/collab/agent-node"
import { ExperimentTable } from "@/research/research.sql"
import { Database, eq } from "@/storage/db"
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

  export function prompt(sessionID: string) {
    const experiment = resolve(sessionID)
    if (!experiment) return
    return `<experiment-workspace code_path=${JSON.stringify(experiment.code_path)}>Use code_path for experiment code operations. Other workspace files may be read for context.</experiment-workspace>`
  }
}
