import { CollabAgentNode } from "@/collab/agent-node"
import { Collab } from "@/collab"
import { CollabAutoWake } from "@/collab/auto-wake"
import { CollabMessage } from "@/collab/message"
import { CollabRuntime } from "@/collab/runtime"
import { SessionOwnership } from "@/session/ownership"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { Database, eq } from "@/storage/db"
import { ScheduledTask } from "@/scheduler/scheduled-task"

import { ExperimentRemoteTaskListener } from "./experiment-remote-task-listener"
import { AtomTable, ExperimentTable } from "./research.sql"

export namespace ResearchSessionControl {
  export class BusyError extends Error {
    constructor(
      public readonly sessionID: string,
      domain: "Atom" | "Experiment" = "Experiment",
      controlled = true,
      human = false,
    ) {
      super(
        domain === "Experiment"
          ? human
            ? `Experiment session ${sessionID} has an active human-initiated task`
            : `Experiment session ${sessionID} is controlled by its Atom agent`
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
      if (node.initiator === "human" && node.status === "waiting_interaction") return
      if (!node.parent_agent_id || !CollabAgentNode.isActive(node.status)) return
      throw new BusyError(sessionID, kind, true, node.initiator === "human")
    }
    if (node.parent_agent_id) throw new BusyError(sessionID, kind)
    if (!settled(node.id, "human", true, false)) throw new BusyError(sessionID, kind, false)
  }

  export function canStartHumanRun(sessionID: string) {
    if (domain(sessionID) !== "Experiment") return false
    if (SessionOwnership.current(sessionID) !== "human") return false
    const node = CollabAgentNode.loadBySessionId(sessionID)
    if (!node?.parent_agent_id || CollabAgentNode.isActive(node.status) || node.active_children > 0) return false
    if (CollabAgentNode.isExperiment(node) && node.spec.metadata?.stoppedByUser !== true) return true
    const parent = CollabAgentNode.tryLoad(node.parent_agent_id)
    return !!parent && CollabAgentNode.isActive(parent.status)
  }

  export function queueHumanPrompt(sessionID: string, prompt: Omit<SessionPrompt.PromptInput, "sessionID">) {
    const node = CollabAgentNode.loadBySessionId(sessionID)
    if (!node?.parent_agent_id || node.initiator !== "human" || !CollabAgentNode.isActive(node.status)) return false
    if (node.error && node.error.code !== "MODEL_UNAVAILABLE") return false
    const text = prompt.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n")
    return !!CollabMessage.post({
      recipientAgentId: node.id,
      senderAgentId: null,
      runId: node.run_id,
      expectedParentAgentId: node.parent_agent_id,
      expectedRunId: node.run_id,
      expectedErrorCode: node.error?.code ?? null,
      kind: "user_input",
      payload: {
        text,
        messageId: prompt.messageID,
        model: prompt.model,
        prompt,
      },
    })
  }

  export function claimHuman(sessionID: string, opts?: { restart?: boolean }) {
    const release = SessionOwnership.claim(sessionID, "human")
    if (!release) throw new BusyError(sessionID, domain(sessionID))
    try {
      if (opts?.restart) Collab.restart(sessionID)
      assertHuman(sessionID)
      const lost = () => SessionPrompt.cancel(sessionID)
      release.signal.addEventListener("abort", lost, { once: true })
      return () => {
        release.signal.removeEventListener("abort", lost)
        release()
        CollabAutoWake.wake(sessionID)
      }
    } catch (error) {
      release()
      CollabAutoWake.wake(sessionID)
      throw error
    }
  }

  export function assertAbort(sessionID: string) {
    const node = CollabAgentNode.loadBySessionId(sessionID)
    const cancel = () => {
      if (!node) return
      CollabAutoWake.ensure()
      const posted = CollabMessage.post({
        recipientAgentId: node.id,
        senderAgentId: null,
        runId: node.run_id,
        expectedParentAgentId: node.parent_agent_id,
        expectedRunId: node.run_id,
        kind: "cancel",
        payload: { reason: "Canceled by human", initiator: "user" },
      })
      if (!posted) throw new Error(`Cannot cancel agent ${node.id}: ownership changed before cancel`)
    }
    if (node?.parent_agent_id && node.initiator === "human" && CollabAgentNode.isActive(node.status)) {
      cancel()
      SessionOwnership.revoke(sessionID)
      return
    }
    if (node?.parent_agent_id && CollabAgentNode.isActive(node.status)) {
      assertHuman(sessionID)
      cancel()
      if (SessionOwnership.current(sessionID) === "human") SessionOwnership.revoke(sessionID)
      return
    }
    if (SessionOwnership.current(sessionID) === "human") {
      SessionOwnership.revoke(sessionID)
      return
    }
    assertHuman(sessionID)
  }

  export function branch(agentId: string) {
    return CollabAgentNode.loadBranch(agentId)
  }

  function settled(agentId: string, owner: SessionOwnership.Owner, strict = true, direct = true) {
    const node = CollabAgentNode.load(agentId)
    if (node.parent_agent_id && CollabAgentNode.isActive(node.status)) return false
    if (SessionStatus.get(node.session_id).type !== "idle") return false
    if (CollabAutoWake.isDriving(node.session_id)) return false
    if (node.active_children > 0) return false

    return branch(agentId).every((item) => {
      if (
        CollabRuntime.has(item.id) ||
        ExperimentRemoteTaskListener.has(item.id, direct ? undefined : "collab") ||
        ScheduledTask.has(item.id, direct ? undefined : "collab") ||
        (direct ? CollabMessage.hasOutstanding(item.id) : CollabMessage.hasOutstandingCollab(item.id))
      )
        return false
      if (item.id !== node.id && CollabAgentNode.isActive(item.status)) return false
      const current = SessionOwnership.current(item.session_id)
      if (current === "human" && owner !== "human") return false
      if (!strict) return true
      if (SessionStatus.get(item.session_id).type !== "idle") return false
      if (CollabAutoWake.isDriving(item.session_id)) return false
      if (item.id === node.id && current === owner) return true
      return current === undefined
    })
  }

  export function branchSettled(agentId: string, opts?: { strict?: boolean }) {
    return settled(agentId, "collab", opts?.strict ?? false)
  }
}
