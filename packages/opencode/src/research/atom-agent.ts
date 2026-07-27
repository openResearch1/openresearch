import { CollabAgentNode } from "@/collab/agent-node"
import { CollabMessage } from "@/collab/message"
import { CollabRuntime } from "@/collab/runtime"
import { CollabLoop } from "@/collab/loop"
import { Instance } from "@/project/instance"
import { SessionOwnership } from "@/session/ownership"
import { and, Database, eq, isNotNull, isNull, NotFoundError } from "@/storage/db"
import { AtomTable, ExperimentTable, ResearchProjectTable } from "./research.sql"
import { ResearchDeletionTable } from "./research-deletion.sql"
import { ResearchSessionControl } from "./session-control"

export namespace AtomAgent {
  type SessionInfo = {
    id: string
    projectID: string
    title: string
    parentID?: string
    collabPeer?: boolean
    time: { archived?: number }
  }

  export type EnsureResult = {
    atom: typeof AtomTable.$inferSelect
    session: SessionInfo
    agent: ReturnType<typeof CollabAgentNode.load>
    created: boolean
  }

  export type DelegateResult = {
    atomId: string
    agentId: string
    sessionId: string
    runId: string
    parentAgentId: string
    parentSessionId: string
    status: ReturnType<typeof CollabAgentNode.load>["status"]
  }

  export class BusyError extends Error {
    constructor(
      public readonly reason: "human_control" | "leased" | "not_quiescent",
      public readonly ownerSessionID?: string,
    ) {
      super(
        reason === "leased"
          ? `Atom is busy under session ${ownerSessionID ?? "unknown"}`
          : reason === "human_control"
            ? "Atom is busy with direct human activity"
            : "Atom is not fully idle; wait for its current work and callbacks to settle",
      )
    }
  }

  const tasks = Instance.state(() => new Map<string, Promise<EnsureResult>>())

  function scoped(atomId: string) {
    const atom = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, atomId)).get())
    const deleting = Database.use((db) =>
      db
        .select({ id: ResearchDeletionTable.entity_id })
        .from(ResearchDeletionTable)
        .where(and(eq(ResearchDeletionTable.kind, "atom"), eq(ResearchDeletionTable.entity_id, atomId)))
        .get(),
    )
    const research = atom
      ? Database.use((db) =>
          db
            .select({ project: ResearchProjectTable.project_id })
            .from(ResearchProjectTable)
            .where(eq(ResearchProjectTable.research_project_id, atom.research_project_id))
            .get(),
        )
      : undefined
    if (!atom || deleting || research?.project !== Instance.project.id) {
      throw new NotFoundError({ message: `Atom not found: ${atomId}` })
    }
    return atom
  }

  export function ensure(atomId: string): Promise<EnsureResult> {
    const current = tasks().get(atomId)
    if (current) return current
    const task = run(atomId).finally(() => {
      if (tasks().get(atomId) === task) tasks().delete(atomId)
    })
    tasks().set(atomId, task)
    return task
  }

  async function run(atomId: string): Promise<EnsureResult> {
    const { Collab } = await import("@/collab")
    const { Session } = await import("@/session")
    let atom = scoped(atomId)
    const existing = atom.session_id ? await Session.get(atom.session_id).catch(() => undefined) : undefined
    let created = !existing || !!existing.time.archived
    let session = existing
    if (created) {
      const next = await Session.create({ title: `Atom: ${atom.atom_name}` })
      session = next
      const winner = Database.use((db) =>
        db
          .update(AtomTable)
          .set({ session_id: next.id, time_updated: Date.now() })
          .where(
            and(
              eq(AtomTable.atom_id, atomId),
              atom.session_id ? eq(AtomTable.session_id, atom.session_id) : isNull(AtomTable.session_id),
            ),
          )
          .returning({ id: AtomTable.atom_id })
          .get(),
      )
      const fresh = (() => {
        try {
          return scoped(atomId)
        } catch (error) {
          if (NotFoundError.isInstance(error)) return
          throw error
        }
      })()
      if (!fresh) {
        await Session.remove(next.id).catch(() => {})
        throw new NotFoundError({ message: `Atom not found: ${atomId}` })
      }
      atom = fresh
      if (!winner) {
        await Session.remove(next.id)
        if (!atom.session_id) throw new Error(`Atom session claim failed: ${atomId}`)
        session = await Session.get(atom.session_id)
        created = false
      }
    }
    if (!session) throw new Error(`Atom session is unavailable: ${atomId}`)

    let agent = await Collab.ensureRootFromSession(session.id, {
      name: `Atom: ${atom.atom_name}`,
      subagentType: "research",
      spec: { initialPrompt: "", policy: { on_fail: "continue" }, metadata: { atomId } },
    })
    const root = !agent.parent_agent_id && agent.root_agent_id === agent.id
    agent = CollabAgentNode.spec(agent.id, {
      ...agent.spec,
      policy: {
        ...agent.spec.policy,
        on_fail: "continue",
        ...(root ? { detach_on_terminal: false } : {}),
      },
      metadata: { ...agent.spec.metadata, atomId },
    })
    if (root && !CollabAgentNode.isActive(agent.status)) agent = CollabAgentNode.activate(agent.id)
    await import("./experiment-agent").then((mod) => mod.ExperimentAgent.atom(atomId))
    return { atom, session, agent: CollabAgentNode.load(agent.id), created }
  }

  export async function scan() {
    const atoms = Database.use((db) =>
      db
        .select({ id: AtomTable.atom_id })
        .from(AtomTable)
        .innerJoin(ResearchProjectTable, eq(ResearchProjectTable.research_project_id, AtomTable.research_project_id))
        .where(and(eq(ResearchProjectTable.project_id, Instance.project.id), isNotNull(AtomTable.session_id)))
        .all(),
    )
    await Promise.all(atoms.map((atom) => ensure(atom.id)))
  }

  export async function delegate(input: {
    atomId: string
    sourceSessionId: string
    agent: string
    prompt: string
    model?: { providerID: string; modelID: string }
    runId: string
  }): Promise<DelegateResult> {
    if (!input.runId) throw new Error("Delegation run id must not be empty")
    const { Collab } = await import("@/collab")
    const { Session } = await import("@/session")
    const atom = scoped(input.atomId)
    const source = await Session.get(input.sourceSessionId)
    if (source.projectID !== Instance.project.id || source.parentID || source.collabPeer) {
      throw new Error("Only an ordinary root session in the current project may delegate to an Atom")
    }
    const research = Database.use((db) =>
      db
        .select({ id: ResearchProjectTable.research_project_id })
        .from(ResearchProjectTable)
        .where(eq(ResearchProjectTable.project_id, source.projectID))
        .get(),
    )
    if (research?.id !== atom.research_project_id) {
      throw new Error("Source session and Atom are not in the same research project")
    }
    const bound = Database.use((db) =>
      db.select({ id: AtomTable.atom_id }).from(AtomTable).where(eq(AtomTable.session_id, source.id)).get(),
    )
    const exp = Database.use((db) =>
      db
        .select({ id: ExperimentTable.exp_id })
        .from(ExperimentTable)
        .where(eq(ExperimentTable.exp_session_id, source.id))
        .get(),
    )
    if (bound || exp) throw new Error("Atom and Experiment sessions cannot delegate an Atom lease")

    let parent = await Collab.ensureRootFromSession(source.id, {
      name: source.title,
      subagentType: input.agent,
      spec: { initialPrompt: "", policy: { on_fail: "continue" } },
    })
    if (parent.parent_agent_id || parent.root_agent_id !== parent.id) {
      throw new Error("Source session is not an independent Collab root")
    }
    parent = CollabAgentNode.spec(parent.id, {
      ...parent.spec,
      policy: { ...parent.spec.policy, on_fail: "continue" },
    })
    if (!CollabAgentNode.isActive(parent.status)) parent = CollabAgentNode.activate(parent.id)

    const target = await ensure(input.atomId)
    const prior = CollabMessage.listRun(target.agent.id, input.runId).some((message) => message.kind === "user_input")
    if (prior && !target.agent.parent_agent_id) {
      const terminal = CollabMessage.listRun(parent.id, input.runId).find(
        (message) =>
          message.sender_agent_id === target.agent.id &&
          (message.kind === "child_done" || message.kind === "child_failed"),
      )
      if (terminal) {
        const payload = terminal.payload_json as { reason?: string }
        return {
          atomId: atom.atom_id,
          agentId: target.agent.id,
          sessionId: target.agent.session_id,
          runId: input.runId,
          parentAgentId: parent.id,
          parentSessionId: parent.session_id,
          status: terminal.kind === "child_done" ? "completed" : payload.reason === "canceled" ? "canceled" : "failed",
        }
      }
    }
    const release = SessionOwnership.claim(target.session.id, "collab")
    if (!release) {
      const fresh = CollabAgentNode.load(target.agent.id)
      if (fresh.parent_agent_id) {
        throw new BusyError("leased", CollabAgentNode.tryLoad(fresh.parent_agent_id)?.session_id)
      }
      throw new BusyError(SessionOwnership.current(target.session.id) === "human" ? "human_control" : "not_quiescent")
    }
    try {
      const fresh = CollabAgentNode.load(target.agent.id)
      if (fresh.parent_agent_id) {
        if (fresh.parent_agent_id !== parent.id || fresh.run_id !== input.runId) {
          throw new BusyError("leased", CollabAgentNode.tryLoad(fresh.parent_agent_id)?.session_id)
        }
      } else {
        if (fresh.root_agent_id !== fresh.id || !ResearchSessionControl.branchSettled(fresh.id, { strict: true })) {
          throw new BusyError("not_quiescent")
        }
      }

      if (!release.valid()) throw new BusyError("not_quiescent")
      const agent = await Collab.leaseAndResume({
        agentId: fresh.id,
        parentAgentId: parent.id,
        prompt: input.prompt,
        model: input.model,
        runId: input.runId,
      }).catch((err) => {
        const current = CollabAgentNode.load(fresh.id)
        if (current.parent_agent_id) {
          throw new BusyError("leased", CollabAgentNode.tryLoad(current.parent_agent_id)?.session_id)
        }
        throw err
      })
      queueMicrotask(() => void CollabLoop.start(agent.id))
      return {
        atomId: atom.atom_id,
        agentId: agent.id,
        sessionId: agent.session_id,
        runId: input.runId,
        parentAgentId: parent.id,
        parentSessionId: parent.session_id,
        status: agent.status,
      }
    } finally {
      release()
    }
  }

  export async function releaseParent(parentId: string) {
    const children = CollabAgentNode.loadChildren(parentId).filter(
      (child) => typeof child.spec.metadata?.atomId === "string" && child.spec.policy?.detach_on_terminal,
    )
    if (!children.length) return
    const { SessionPrompt } = await import("@/session/prompt")
    const branch = children.flatMap((child) => ResearchSessionControl.branch(child.id))
    const owners = branch.map((item) => {
      SessionOwnership.revoke(item.session_id)
      return SessionOwnership.wait(item.session_id)
    })
    const runs = branch.flatMap((item) => {
      const runtime = CollabRuntime.get(item.id)
      SessionPrompt.cancel(item.session_id)
      if (!runtime) return []
      CollabRuntime.abort(item.id)
      return [runtime.promise]
    })
    await Promise.allSettled([...runs, ...owners])
    const { ExperimentRemoteTaskListener } = await import("./experiment-remote-task-listener")
    ExperimentRemoteTaskListener.clear(branch.map((item) => item.id))

    for (const child of children) {
      const current = CollabAgentNode.tryLoad(child.id)
      if (!current || current.parent_agent_id !== parentId) continue
      for (const item of ResearchSessionControl.branch(current.id)) {
        CollabMessage.closeInbox(item.id)
        if (item.id !== current.id && CollabAgentNode.isActive(item.status)) {
          CollabAgentNode.transition(item.id, "canceled", {
            error: { code: "PARENT_DELETED", message: "Delegating session was deleted" },
            timeEnded: Date.now(),
          })
        }
      }
      if (CollabAgentNode.isActive(current.status)) {
        CollabAgentNode.transition(current.id, "canceled", {
          error: { code: "PARENT_DELETED", message: "Delegating session was deleted" },
          timeEnded: Date.now(),
        })
      }
      CollabAgentNode.detach(current.id)
      CollabAgentNode.activate(current.id)
      CollabAgentNode.recomputeActiveChildren(current.id)
    }
  }

  export const assertHuman = ResearchSessionControl.assertHuman
  export const claimHuman = ResearchSessionControl.claimHuman
}
