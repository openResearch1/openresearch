import { eq } from "drizzle-orm"

import { Bus } from "@/bus"
import { CollabAgentNode } from "@/collab/agent-node"
import { CollabEvent } from "@/collab/events"
import { CollabMessage } from "@/collab/message"
import { CollabRuntime } from "@/collab/runtime"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { SessionStatus } from "@/session/status"
import { SessionTable } from "@/session/session.sql"
import { SessionOwnership } from "@/session/ownership"
import { Database } from "@/storage/db"
import { Log } from "@/util/log"
import { ExperimentRemoteTaskListener } from "./experiment-remote-task-listener"
import { AtomTable, ExperimentTable, ResearchProjectTable } from "./research.sql"

export namespace ExperimentAgent {
  const log = Log.create({ service: "experiment-agent" })

  export type Result = {
    status: "attached" | "deferred" | "unbound" | "conflict"
    agentId?: string
    reason?: string
  }

  export class BusyError extends Error {
    constructor(public readonly sessionID: string) {
      super(`Experiment session ${sessionID} is controlled by its Atom agent`)
    }
  }

  const state = Instance.state(
    () => {
      const retry = (sessionID: string) => {
        const exp = Database.use((db) =>
          db
            .select({ exp_id: ExperimentTable.exp_id })
            .from(ExperimentTable)
            .where(eq(ExperimentTable.exp_session_id, sessionID))
            .get(),
        )
        if (!exp) return
        void attach(exp.exp_id).catch((err) => log.warn("retry failed", { expId: exp.exp_id, error: String(err) }))
      }
      const idle = Bus.subscribe(SessionStatus.Event.Idle, (event) => retry(event.properties.sessionID))
      const drive = Bus.subscribe(CollabEvent.RootDriveEnded, (event) => retry(event.properties.sessionID))
      const status = Bus.subscribe(CollabEvent.AgentStatus, (event) => {
        const node = CollabAgentNode.tryLoad(event.properties.agentId)
        if (node) setTimeout(() => retry(node.session_id), 0)
      })
      return { idle, drive, status }
    },
    async (value) => {
      value.idle()
      value.drive()
      value.status()
    },
  )
  const tasks = Instance.state(() => new Map<string, Promise<Result>>())

  export function ensure() {
    state()
  }

  export async function scan() {
    ensure()
    const exps = Database.use((db) =>
      db
        .select({ id: ExperimentTable.exp_id })
        .from(ExperimentTable)
        .innerJoin(
          ResearchProjectTable,
          eq(ResearchProjectTable.research_project_id, ExperimentTable.research_project_id),
        )
        .where(eq(ResearchProjectTable.project_id, Instance.project.id))
        .all(),
    )
    await Promise.all(exps.map((exp) => attach(exp.id)))
  }

  export async function atom(atomId: string) {
    ensure()
    const exps = Database.use((db) =>
      db.select({ id: ExperimentTable.exp_id }).from(ExperimentTable).where(eq(ExperimentTable.atom_id, atomId)).all(),
    )
    return Promise.all(exps.map((exp) => attach(exp.id)))
  }

  export function attach(expId: string, opts?: { force?: boolean }): Promise<Result> {
    ensure()
    const key = opts?.force ? `${expId}:force` : expId
    const current = tasks().get(key)
    if (current) return current
    const task = run(expId, opts?.force === true).finally(() => {
      if (tasks().get(key) === task) tasks().delete(key)
    })
    tasks().set(key, task)
    return task
  }

  export async function recover(agentId: string) {
    const node = CollabAgentNode.tryLoad(agentId)
    const expId = node?.spec.metadata?.expId
    if (typeof expId !== "string") return node
    const result = await attach(expId, { force: true })
    if (!result.agentId) return node
    return CollabAgentNode.load(result.agentId)
  }

  async function run(expId: string, force: boolean): Promise<Result> {
    const exp = Database.use((db) => db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, expId)).get())
    if (!exp?.atom_id) return { status: "unbound", reason: "Experiment is not linked to an atom" }
    const research = Database.use((db) =>
      db
        .select({ project: ResearchProjectTable.project_id })
        .from(ResearchProjectTable)
        .where(eq(ResearchProjectTable.research_project_id, exp.research_project_id))
        .get(),
    )
    if (research?.project !== Instance.project.id) {
      return { status: "conflict", reason: "Experiment project mismatch" }
    }

    const current = exp.exp_session_id
      ? Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, exp.exp_session_id!)).get())
      : undefined
    const previous = exp.exp_session_id ? CollabAgentNode.loadBySessionId(exp.exp_session_id) : undefined
    if (!current && previous && !force && !(await settled(previous.id))) {
      return { status: "deferred", agentId: previous.id, reason: "Archived experiment agent is still active" }
    }
    if (current?.time_archived) {
      await import("@/session").then((mod) => mod.Session.setArchived({ sessionID: current.id }))
    }
    const created =
      !current
        ? await import("@/session").then((mod) => mod.Session.create({ title: `Exp: ${exp.exp_name}` }))
        : undefined
    if (created) {
      Database.transaction((db) => {
        db
          .update(ExperimentTable)
          .set({ exp_session_id: created.id, time_updated: Date.now() })
          .where(eq(ExperimentTable.exp_id, expId))
          .run()
        if (previous) CollabAgentNode.rebind(previous.id, created.id)
      })
    }
    const sessionId = created?.id ?? exp.exp_session_id
    if (!sessionId) return { status: "unbound", reason: "Experiment has no session" }

    const session = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sessionId)).get())
    if (!session) return { status: "unbound", reason: "Experiment session is unavailable" }

    const atomId = exp.atom_id
    const atom = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, atomId)).get())
    if (!atom?.session_id) return { status: "unbound", reason: "Atom has no session" }
    if (atom.research_project_id !== exp.research_project_id) {
      return { status: "conflict", reason: "Experiment atom project mismatch" }
    }

    const parent = Database.use((db) =>
      db.select().from(SessionTable).where(eq(SessionTable.id, atom.session_id!)).get(),
    )
    if (!parent || parent.time_archived) return { status: "unbound", reason: "Atom session is unavailable" }
    if (parent.project_id !== Instance.project.id)
      return { status: "conflict", reason: "Atom session project mismatch" }
    if (session.project_id !== parent.project_id) {
      return { status: "conflict", reason: "Experiment session project mismatch" }
    }

    let root = await import("@/collab").then((mod) =>
      mod.Collab.ensureRootFromSession(parent.id, {
        name: `Atom: ${atom.atom_name}`,
        subagentType: "research",
        spec: { initialPrompt: "", policy: { on_fail: "continue" }, metadata: { atomId: atom.atom_id } },
      }),
    )
    root = CollabAgentNode.spec(root.id, {
      ...root.spec,
      policy: { ...root.spec.policy, on_fail: "continue" },
      metadata: { ...root.spec.metadata, atomId: atom.atom_id },
    })
    if (!CollabAgentNode.isActive(root.status)) root = CollabAgentNode.activate(root.id)
    const node = previous ?? CollabAgentNode.loadBySessionId(session.id)
    if (!node) {
      const info = CollabAgentNode.create({
        id: Identifier.ascending("collab_agent"),
        sessionId: session.id,
        parentAgentId: root.id,
        name: `Experiment: ${exp.exp_name}`,
        projectId: session.project_id,
        rootAgentId: root.root_agent_id,
        subagentType: "experiment",
        spec: { initialPrompt: "", policy: { on_fail: "continue" }, metadata: { expId, atomId: atom.atom_id } },
        status: "idle",
      })
      return { status: "attached", agentId: info.id }
    }

    const metadata = node.spec.metadata
    if (node.parent_agent_id && (metadata?.expId !== expId || metadata.atomId !== atomId)) {
      return { status: "conflict", agentId: node.id, reason: `Experiment agent belongs to ${node.parent_agent_id}` }
    }
    CollabAgentNode.spec(node.id, {
      ...node.spec,
      policy: { ...node.spec.policy, on_fail: "continue" },
      metadata: { ...node.spec.metadata, expId, atomId },
    })
    if (node.parent_agent_id === root.id && node.root_agent_id === root.root_agent_id) {
      CollabAgentNode.recomputeActiveChildren(root.id)
      return { status: "attached", agentId: node.id }
    }
    const ready = await settled(node.id)
    if (
      !ready &&
      (!force ||
        CollabRuntime.has(node.id) ||
        SessionStatus.get(node.session_id).type !== "idle" ||
        !SessionOwnership.available(node.session_id, "collab"))
    ) {
      return { status: "deferred", agentId: node.id, reason: "Existing Collab tree is active" }
    }

    const info = CollabAgentNode.attach({
      id: node.id,
      parentId: root.id,
      rootId: root.root_agent_id,
      name: `Experiment: ${exp.exp_name}`,
      subagentType: "experiment",
      metadata: { expId, atomId: atom.atom_id },
    })
    CollabAgentNode.recomputeActiveChildren(root.id)
    return { status: "attached", agentId: info.id }
  }

  export function get(expId: string) {
    const exp = Database.use((db) =>
      db
        .select({ session: ExperimentTable.exp_session_id })
        .from(ExperimentTable)
        .where(eq(ExperimentTable.exp_id, expId))
        .get(),
    )
    if (!exp?.session) return
    return CollabAgentNode.loadBySessionId(exp.session)
  }

  export function assertHuman(sessionID: string) {
    const exp = Database.use((db) =>
      db
        .select({ id: ExperimentTable.exp_id })
        .from(ExperimentTable)
        .where(eq(ExperimentTable.exp_session_id, sessionID))
        .get(),
    )
    if (!exp) return
    const node = CollabAgentNode.loadBySessionId(sessionID)
    if (!node?.parent_agent_id || !CollabAgentNode.isActive(node.status)) return
    throw new BusyError(sessionID)
  }

  export function claimHuman(sessionID: string) {
    assertHuman(sessionID)
    const release = SessionOwnership.claim(sessionID, "human")
    if (!release) throw new BusyError(sessionID)
    return release
  }

  async function settled(agentId: string) {
    const node = CollabAgentNode.load(agentId)
    if (node.parent_agent_id && CollabAgentNode.isActive(node.status)) return false
    if (SessionStatus.get(node.session_id).type !== "idle") return false
    const { CollabAutoWake } = await import("@/collab/auto-wake")
    if (CollabAutoWake.isDriving(node.session_id)) return false
    if (
      node.active_children > 0 ||
      CollabMessage.hasPendingWakeMsg(node.id) ||
      CollabMessage.hasPendingKind(node.id, "session_remote_task_terminal")
    )
      return false
    return branch(node.id).every((item) => {
      if (
        CollabRuntime.has(item.id) ||
        ExperimentRemoteTaskListener.has(item.id) ||
        CollabMessage.hasPendingKind(item.id, "session_remote_task_terminal")
      )
        return false
      return item.id === node.id || !CollabAgentNode.isActive(item.status)
    })
  }

  function branch(agentId: string) {
    const node = CollabAgentNode.load(agentId)
    const tree = CollabAgentNode.loadTree(node.root_agent_id)
    const ids = new Set([node.id])
    let changed = true
    while (changed) {
      changed = false
      for (const item of tree) {
        if (!item.parent_agent_id || !ids.has(item.parent_agent_id) || ids.has(item.id)) continue
        ids.add(item.id)
        changed = true
      }
    }
    return tree.filter((item) => ids.has(item.id))
  }
}
