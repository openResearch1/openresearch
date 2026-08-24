import { and, eq, isNull } from "drizzle-orm"

import { Bus } from "@/bus"
import { CollabAgentNode } from "@/collab/agent-node"
import { CollabEvent } from "@/collab/events"
import { CollabRecovery } from "@/collab/recovery"
import { CollabRuntime } from "@/collab/runtime"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { SessionStatus } from "@/session/status"
import { SessionTable } from "@/session/session.sql"
import { SessionOwnership } from "@/session/ownership"
import { Database } from "@/storage/db"
import { Log } from "@/util/log"
import { AtomTable, ExperimentTable, ResearchProjectTable } from "./research.sql"
import { ResearchSessionControl } from "./session-control"
import { ResearchDeletionTable } from "./research-deletion.sql"

export namespace ExperimentAgent {
  const log = Log.create({ service: "experiment-agent" })

  export type Result = {
    status: "attached" | "deferred" | "unbound" | "conflict"
    agentId?: string
    reason?: string
  }

  export const BusyError = ResearchSessionControl.BusyError

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
    let node = CollabAgentNode.tryLoad(agentId)
    if (node?.initiator === "human" && CollabAgentNode.isActive(node.status)) {
      if (!node.error || node.error.code === "MODEL_UNAVAILABLE") return node
      node = (await CollabRecovery.drain(node.id)) ?? node
      if (CollabAgentNode.isActive(node.status)) return node
    }
    const expId = node?.spec.metadata?.expId
    if (typeof expId !== "string") return node
    const result = await attach(expId, { force: true })
    if (!result.agentId) return node
    return CollabAgentNode.load(result.agentId)
  }

  async function run(expId: string, force: boolean): Promise<Result> {
    const deleting = Database.use((db) =>
      db
        .select({ id: ResearchDeletionTable.entity_id })
        .from(ResearchDeletionTable)
        .where(and(eq(ResearchDeletionTable.kind, "experiment"), eq(ResearchDeletionTable.entity_id, expId)))
        .get(),
    )
    if (deleting) return { status: "unbound", reason: "Experiment is being deleted" }
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
    const { Session } = await import("@/session")
    const created = !current ? await Session.create({ title: `Exp: ${exp.exp_name}` }) : undefined
    let sessionId = exp.exp_session_id
    if (created) {
      const winner = Database.transaction((tx) => {
        const marker = tx
          .select({ id: ResearchDeletionTable.entity_id })
          .from(ResearchDeletionTable)
          .where(and(eq(ResearchDeletionTable.kind, "experiment"), eq(ResearchDeletionTable.entity_id, expId)))
          .get()
        if (marker) return
        return tx
          .update(ExperimentTable)
          .set({ exp_session_id: created.id, time_updated: Date.now() })
          .where(
            and(
              eq(ExperimentTable.exp_id, expId),
              exp.exp_session_id
                ? eq(ExperimentTable.exp_session_id, exp.exp_session_id)
                : isNull(ExperimentTable.exp_session_id),
            ),
          )
          .returning({ id: ExperimentTable.exp_id })
          .get()
      })
      if (winner) {
        sessionId = created.id
        if (previous) CollabAgentNode.rebind(previous.id, created.id)
      } else {
        await Session.remove(created.id)
        sessionId =
          Database.use(
            (db) =>
              db
                .select({ id: ExperimentTable.exp_session_id })
                .from(ExperimentTable)
                .where(eq(ExperimentTable.exp_id, expId))
                .get()?.id,
          ) ?? null
      }
    }
    if (!sessionId) return { status: "unbound", reason: "Experiment has no session" }
    if (
      Database.use((db) =>
        db
          .select({ id: ResearchDeletionTable.entity_id })
          .from(ResearchDeletionTable)
          .where(and(eq(ResearchDeletionTable.kind, "experiment"), eq(ResearchDeletionTable.entity_id, expId)))
          .get(),
      )
    ) {
      return { status: "unbound", reason: "Experiment is being deleted" }
    }

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
    if (
      !root.parent_agent_id &&
      root.root_agent_id === root.id &&
      !CollabAgentNode.isActive(root.status) &&
      !CollabAgentNode.isStopped(root)
    ) {
      root = CollabAgentNode.activate(root.id)
    }
    let node = previous ?? CollabAgentNode.loadBySessionId(session.id)
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
    node = CollabAgentNode.restoreExperiment(node.id)

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
    return ResearchSessionControl.assertHuman(sessionID)
  }

  export function claimHuman(sessionID: string) {
    return ResearchSessionControl.claimHuman(sessionID)
  }

  async function settled(agentId: string) {
    return ResearchSessionControl.branchSettled(agentId)
  }
}
