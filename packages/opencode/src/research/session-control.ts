import { CollabAgentNode } from "@/collab/agent-node"
import { CollabAutoWake } from "@/collab/auto-wake"
import { CollabMessage } from "@/collab/message"
import { CollabRuntime } from "@/collab/runtime"
import { SessionOwnership } from "@/session/ownership"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { Database, eq } from "@/storage/db"
import { ExperimentRemoteTaskListener } from "./experiment-remote-task-listener"
import { AtomTable, ExperimentTable } from "./research.sql"

export namespace ResearchSessionControl {
  export class BusyError extends Error {
    constructor(
      public readonly sessionID: string,
      domain: "Atom" | "Experiment" = "Experiment",
      controlled = true,
    ) {
      super(
        domain === "Experiment"
          ? `Experiment session ${sessionID} is controlled by its Atom agent`
          : controlled
            ? `Atom session ${sessionID} is controlled by a project agent`
            : `Atom session ${sessionID} is busy`,
      )
    }
  }

  function domain(sessionID: string) {
    const atom = Database.use((db) =>
      db.select({ id: AtomTable.atom_id }).from(AtomTable).where(eq(AtomTable.session_id, sessionID)).get(),
    )
    if (atom) return "Atom" as const
    const exp = Database.use((db) =>
      db
        .select({ id: ExperimentTable.exp_id })
        .from(ExperimentTable)
        .where(eq(ExperimentTable.exp_session_id, sessionID))
        .get(),
    )
    if (exp) return "Experiment" as const
  }

  export function assertHuman(sessionID: string) {
    const kind = domain(sessionID)
    if (!kind) return
    const node = CollabAgentNode.loadBySessionId(sessionID)
    if (!node) return
    if (kind === "Experiment") {
      if (!node.parent_agent_id || !CollabAgentNode.isActive(node.status)) return
      throw new BusyError(sessionID, kind)
    }
    if (node.parent_agent_id) throw new BusyError(sessionID, kind)
    if (!settled(node.id, "human")) throw new BusyError(sessionID, kind, false)
  }

  export function claimHuman(sessionID: string) {
    const release = SessionOwnership.claim(sessionID, "human")
    if (!release) throw new BusyError(sessionID, domain(sessionID))
    try {
      assertHuman(sessionID)
      const lost = () => SessionPrompt.cancel(sessionID)
      release.signal.addEventListener("abort", lost, { once: true })
      return () => {
        release.signal.removeEventListener("abort", lost)
        release()
      }
    } catch (error) {
      release()
      throw error
    }
  }

  export function assertAbort(sessionID: string) {
    if (SessionOwnership.current(sessionID) === "human") {
      SessionOwnership.revoke(sessionID)
      return
    }
    assertHuman(sessionID)
  }

  export function branch(agentId: string) {
    return CollabAgentNode.loadBranch(agentId)
  }

  function settled(agentId: string, owner: SessionOwnership.Owner, strict = true) {
    const node = CollabAgentNode.load(agentId)
    if (node.parent_agent_id && CollabAgentNode.isActive(node.status)) return false
    if (SessionStatus.get(node.session_id).type !== "idle") return false
    if (CollabAutoWake.isDriving(node.session_id)) return false
    if (node.active_children > 0) return false

    return branch(agentId).every((item) => {
      if (
        CollabRuntime.has(item.id) ||
        ExperimentRemoteTaskListener.has(item.id) ||
        CollabMessage.hasOutstanding(item.id)
      )
        return false
      if (item.id !== node.id && CollabAgentNode.isActive(item.status)) return false
      if (!strict) return true
      if (SessionStatus.get(item.session_id).type !== "idle") return false
      if (CollabAutoWake.isDriving(item.session_id)) return false
      const current = SessionOwnership.current(item.session_id)
      if (item.id === node.id && current === owner) return true
      return current === undefined
    })
  }

  export function branchSettled(agentId: string, opts?: { strict?: boolean }) {
    return settled(agentId, "collab", opts?.strict ?? false)
  }
}
