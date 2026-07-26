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
  export function prompt(sessionID: string) {
    const parent = root(sessionID)
    const direct = Database.use((db) =>
      db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_session_id, parent)).get(),
    )
    const node = direct ? undefined : CollabAgentNode.loadBySessionId(sessionID)
    const agent = node ? CollabAgentNode.tryLoad(node.root_agent_id) : undefined
    const ancestor = agent ? root(agent.session_id) : undefined
    const experiment =
      direct ??
      (ancestor
        ? Database.use((db) =>
            db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_session_id, ancestor)).get(),
          )
        : undefined)
    if (!experiment) return
    return `<experiment-workspace code_path=${JSON.stringify(experiment.code_path)}>Use code_path for experiment code operations. Other workspace files may be read for context.</experiment-workspace>`
  }
}
