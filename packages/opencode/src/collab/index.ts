import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { Session } from "@/session"
import { Instance } from "@/project/instance"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { Bus } from "@/bus"
import { NotFoundError } from "@/storage/db"
import { PermissionNext } from "@/permission/next"
import { SessionStatus } from "@/session/status"
import { SessionOwnership } from "@/session/ownership"
import { CollabAgentNode } from "./agent-node"
import { CollabMessage } from "./message"
import { CollabLoop } from "./loop"
import { CollabRuntime } from "./runtime"
import { CollabSupervisor } from "./supervisor"
import { CollabProgressHook } from "./progress-hook"
import { CollabAutoWake } from "./auto-wake"
import { CollabEvent } from "./events"
import { ExperimentRemoteTaskListener } from "@/research/experiment-remote-task-listener"
import type { AgentInfo, AgentSpec, CancelPayload, UserInputPayload } from "./types"

export { CollabAgentNode } from "./agent-node"
export { CollabMessage } from "./message"
export { CollabLoop } from "./loop"
export { CollabRuntime } from "./runtime"
export { CollabSupervisor } from "./supervisor"
export { CollabProgressHook } from "./progress-hook"
export { CollabAutoWake } from "./auto-wake"
export { CollabRecovery } from "./recovery"
export { CollabEvent } from "./events"
export * from "./types"

export namespace Collab {
  const log = Log.create({ service: "collab" })

  export type SpawnInput = {
    parentAgentId?: string
    parentSessionId?: string
    name: string
    subagentType: string
    spec: AgentSpec
    permission?: PermissionNext.Ruleset
    startParent?: "human"
  }

  export async function spawn(input: SpawnInput): Promise<AgentInfo> {
    CollabProgressHook.ensure()
    CollabAutoWake.ensure()

    const agent = await Agent.get(input.subagentType)
    if (!agent) throw new Error(`Unknown agent type: ${input.subagentType}`)

    const parent = resolveParent(input)

    const maxChildren = parent?.spec.policy?.maxChildren
    if (parent && maxChildren !== undefined) {
      if (parent.active_children >= maxChildren) {
        throw new Error(
          `maxChildren (${maxChildren}) reached for parent agent ${parent.id} (active=${parent.active_children})`,
        )
      }
    }

    const expectedProjectId = parent?.project_id ?? Instance.project.id

    // Intentionally NOT passing parent's session_id. In this multi-agent
    // collaboration model, spawned peers are independent at the session
    // layer — the hierarchy lives purely in collab_agent.parent_agent_id.
    // Giving the session a parent_id would imply a subtask relationship
    // (like the `task` tool's one-shot semantics), which is not what
    // spawn_agent provides.
    const session = await createSubSession({
      title: input.name + ` (@${agent.name} collab)`,
      permission: input.permission,
    })

    if (session.projectID !== expectedProjectId) {
      throw new Error(
        `Collab.spawn project mismatch: child session ${session.id} in project ${session.projectID}, expected ${expectedProjectId} (from parent ${parent?.id ?? "(root)"})`,
      )
    }

    const agentId = Identifier.ascending("collab_agent")
    const rootAgentId = parent ? parent.root_agent_id : agentId

    const info = await Promise.resolve()
      .then(() =>
        CollabAgentNode.create({
          id: agentId,
          sessionId: session.id,
          parentAgentId: parent?.id ?? null,
          name: input.name,
          projectId: expectedProjectId,
          rootAgentId,
          subagentType: input.subagentType,
          spec: input.spec,
          startParent: input.startParent,
          activeParent: true,
          parentGeneration: parent ? CollabAgentNode.generation(parent.spec) : undefined,
        }),
      )
      .catch(async (err) => {
        await Session.remove(session.id).catch(() => undefined)
        throw err
      })

    void CollabLoop.start(agentId)
    log.info("spawn", { agentId, parentAgentId: parent?.id, sessionId: session.id, projectId: expectedProjectId })
    return info
  }

  function resolveParent(input: SpawnInput): AgentInfo | undefined {
    if (input.parentAgentId) {
      const p = CollabAgentNode.tryLoad(input.parentAgentId)
      if (!p) throw new NotFoundError({ message: `Parent agent not found: ${input.parentAgentId}` })
      return p
    }
    if (input.parentSessionId) {
      return CollabAgentNode.loadBySessionId(input.parentSessionId)
    }
    return undefined
  }

  export async function ensureRootFromSession(
    sessionId: string,
    rootSpec: {
      name: string
      subagentType: string
      spec: AgentSpec
    },
  ): Promise<AgentInfo> {
    CollabProgressHook.ensure()
    CollabAutoWake.ensure()

    const existing = CollabAgentNode.loadBySessionId(sessionId)
    if (existing) return existing

    await Session.get(sessionId)

    const loaded = CollabAgentNode.loadBySessionId(sessionId)
    if (loaded) return loaded

    const agentId = Identifier.ascending("collab_agent")
    const info = CollabAgentNode.create({
      id: agentId,
      sessionId,
      parentAgentId: null,
      name: rootSpec.name,
      projectId: Instance.project.id,
      rootAgentId: agentId,
      subagentType: rootSpec.subagentType,
      spec: rootSpec.spec,
    })
    log.info("ensureRootFromSession", { agentId, sessionId })
    return info
  }

  export async function post(input: Parameters<typeof CollabMessage.post>[0]) {
    return CollabMessage.post(input)
  }

  export async function sendUserInput(agentId: string, payload: UserInputPayload) {
    const node = CollabAgentNode.tryLoad(agentId)
    return CollabMessage.post({
      recipientAgentId: agentId,
      senderAgentId: null,
      runId: node?.run_id,
      kind: "user_input",
      payload,
    })
  }

  /**
   * Re-open a waiting / completed / failed / canceled agent and deliver a new
   * user instruction to it. The agent resumes in its existing session (history
   * preserved), transitions back to `running`, and runs a fresh LLM turn
   * consuming the new prompt. Waiting agents remain active children; terminal
   * agents are re-counted as active before their additional turn.
   */
  export async function resume(input: {
    agentId: string
    prompt: string
    model?: { providerID: string; modelID: string }
    expectedParentAgentId?: string | null
    expectedRunId?: string | null
  }): Promise<AgentInfo> {
    CollabProgressHook.ensure()
    CollabAutoWake.ensure()

    let node = CollabAgentNode.tryLoad(input.agentId)
    if (!node) throw new NotFoundError({ message: `Agent not found: ${input.agentId}` })
    node =
      (await import("@/research/experiment-agent").then((mod) => mod.ExperimentAgent.recover(input.agentId))) ?? node
    if (node.initiator === "human" && CollabAgentNode.isActive(node.status)) {
      throw new Error(`Cannot resume agent ${node.id}: its current run belongs to a human session.`)
    }
    if (CollabAgentNode.isActive(node.status) && node.error && node.error.code !== "MODEL_UNAVAILABLE") {
      throw new Error(`Cannot resume agent ${node.id}: its current run is terminating (${node.error.code}).`)
    }
    if (node.parent_agent_id && CollabAgentNode.isActive(node.status) && !node.run_id) {
      node = CollabAgentNode.ensureRun(node.id)
    }
    if (
      ExperimentRemoteTaskListener.has(node.id, "direct") ||
      CollabMessage.hasOutstanding(node.id, "session_remote_task_terminal")
    ) {
      throw new Error(`Cannot resume agent ${node.id}: its human session is waiting for a remote task update.`)
    }

    const lease = SessionOwnership.claim(node.session_id, "collab")
    if (!lease) throw new Session.BusyError(node.session_id)
    let released = false
    const unlock = () => {
      if (released) return
      released = true
      lease()
    }
    try {
      if (!CollabAgentNode.isActive(node.status) && SessionStatus.get(node.session_id).type === "busy") {
        throw new Session.BusyError(node.session_id)
      }

      node = CollabAgentNode.load(node.id)
      if (input.expectedParentAgentId !== undefined && node.parent_agent_id !== input.expectedParentAgentId) {
        throw new Error(`Cannot resume agent ${node.id}: parent changed before resume.`)
      }
      if (input.expectedRunId !== undefined && node.run_id !== input.expectedRunId) {
        throw new Error(`Cannot resume agent ${node.id}: run changed before resume.`)
      }

      const waiting = node.status === "waiting_interaction"
      if (node.spec.policy?.detach_on_terminal && !waiting) {
        throw new Error(`Cannot resume leased agent ${node.id} while status is ${node.status}.`)
      }

      if (node.parent_agent_id) {
        const parent = CollabAgentNode.tryLoad(node.parent_agent_id)
        if (!parent || !CollabAgentNode.isActive(parent.status)) {
          throw new Error(
            `Cannot resume agent ${node.id}: parent ${node.parent_agent_id} is not active (parent status=${parent?.status ?? "missing"}).`,
          )
        }
      }

      if (CollabAgentNode.isActive(node.status) && !waiting) {
        const posted = CollabMessage.post({
          recipientAgentId: node.id,
          senderAgentId: null,
          runId: node.run_id,
          expectedParentAgentId: node.parent_agent_id,
          expectedRunId: node.run_id,
          expectedErrorCode: null,
          kind: "user_input",
          payload: { text: input.prompt, model: input.model },
        })
        if (!posted) throw new Error(`Cannot resume agent ${node.id}: ownership changed before resume.`)

        if (SessionStatus.get(node.session_id).type !== "busy" && !CollabRuntime.has(node.id)) {
          unlock()
          void CollabLoop.start(node.id)
        }

        return CollabAgentNode.load(node.id)
      }

      // Avoid racing with any lingering loop registration.
      if (CollabRuntime.has(node.id)) {
        log.warn("resume: runtime still had an entry, aborting it first", { agentId: node.id })
        const prior = CollabRuntime.get(node.id)!
        CollabRuntime.abortAndUnregister(node.id)
        await prior.promise.catch(() => {})
      }

      // 1) Transition child back to running; clear prior error but keep result
      //    history. 2) Re-bump parent's active_children only for terminal
      //    resumes. Waiting children never left the active count.
      if (waiting) {
        node = CollabAgentNode.transition(
          node.id,
          "running",
          { phase: "main_loop" },
          { runId: node.run_id, parentId: node.parent_agent_id, status: "waiting_interaction" },
        )
      } else {
        node = CollabAgentNode.activate(node.id, { runId: node.run_id, parentId: node.parent_agent_id })
      }

      const resumed = waiting && CollabMessage.resumeInput(node.id, node.run_id, input.prompt, input.model)
      if (!resumed) {
        // Post before starting the loop so its first drain consumes this input
        // instead of replaying spec.initialPrompt.
        const posted = CollabMessage.post({
          recipientAgentId: node.id,
          senderAgentId: null,
          runId: node.run_id,
          expectedParentAgentId: node.parent_agent_id,
          expectedRunId: node.run_id,
          kind: "user_input",
          payload: { text: input.prompt, model: input.model },
        })
        if (!posted) throw new Error(`Cannot resume agent ${node.id}: ownership changed before resume.`)
      }

      unlock()
      void CollabLoop.start(node.id)
      log.info("resume", { agentId: node.id, parentAgentId: node.parent_agent_id })
      return CollabAgentNode.load(node.id)
    } finally {
      unlock()
    }
  }

  export async function leaseAndResume(input: {
    agentId: string
    parentAgentId: string
    prompt: string
    model?: { providerID: string; modelID: string }
    runId?: string
    parentGeneration?: number
  }): Promise<AgentInfo> {
    CollabProgressHook.ensure()
    CollabAutoWake.ensure()

    const info = CollabAgentNode.lease(input)
    if (
      info.parent_agent_id === input.parentAgentId &&
      info.spec.policy?.detach_on_terminal &&
      (!input.runId || info.run_id === input.runId) &&
      !CollabRuntime.has(info.id)
    ) {
      void CollabLoop.start(info.id)
    }
    return info
  }

  export async function cancel(
    agentId: string,
    reason?: string,
    expected?: { parentAgentId: string | null; runId: string | null },
  ): Promise<void> {
    const node = CollabAgentNode.tryLoad(agentId)
    const cancelPayload: CancelPayload = {
      reason: reason ?? "canceled by request",
      initiator: "user",
    }
    const posted = CollabMessage.post({
      recipientAgentId: agentId,
      senderAgentId: null,
      runId: node?.run_id,
      expectedParentAgentId: expected?.parentAgentId,
      expectedRunId: expected?.runId,
      kind: "cancel",
      payload: cancelPayload,
    })
    if (!posted) throw new Error(`Cannot cancel agent ${agentId}: ownership changed before cancel.`)
    CollabSupervisor.cancelDescendants(agentId, { reason: cancelPayload.reason, initiator: "user" })
  }

  export async function stop(agentId: string) {
    return CollabSupervisor.stop(agentId)
  }

  export function restart(sessionId: string) {
    const node = getBySession(sessionId)
    if (!node || !CollabAgentNode.isStopped(node)) return node
    return CollabAgentNode.restart(node.id)
  }

  export async function cancelDescendants(
    agentId: string,
    opts: { reason: string; initiator: CancelPayload["initiator"] },
  ) {
    await CollabSupervisor.cancelDescendants(agentId, opts)
  }

  export function get(agentId: string): AgentInfo {
    return CollabAgentNode.load(agentId)
  }

  export function tryGet(agentId: string): AgentInfo | undefined {
    return CollabAgentNode.tryLoad(agentId)
  }

  export function getBySession(sessionId: string): AgentInfo | undefined {
    return CollabAgentNode.loadBySessionId(sessionId)
  }

  export function model(sessionId: string, model: { providerID: string; modelID: string }) {
    const node = getBySession(sessionId)
    if (!node) return
    if (node.spec.model?.providerID === model.providerID && node.spec.model.modelID === model.modelID) return node
    return CollabAgentNode.spec(node.id, { ...node.spec, model })
  }

  export function hasOutstandingAsyncWork(sessionId: string): boolean {
    const state = workflowAsyncState(sessionId)
    return (
      state.hasRunningChildren ||
      state.hasWaitingChildren ||
      state.hasPendingWakeMessages ||
      state.hasRemoteTaskListeners
    )
  }

  export function workflowAsyncState(sessionId: string): {
    hasRunningChildren: boolean
    hasWaitingChildren: boolean
    hasPendingWakeMessages: boolean
    hasRemoteTaskListeners: boolean
  } {
    const node = CollabAgentNode.loadBySessionId(sessionId)
    if (!node || !CollabAgentNode.isActive(node.status)) {
      return {
        hasRunningChildren: false,
        hasWaitingChildren: false,
        hasPendingWakeMessages: false,
        hasRemoteTaskListeners: false,
      }
    }

    const children = CollabAgentNode.loadChildren(node.id)
    return {
      hasRunningChildren: children.some(
        (child) => CollabAgentNode.isActive(child.status) && child.status !== "waiting_interaction",
      ),
      hasWaitingChildren: children.some((child) => child.status === "waiting_interaction"),
      hasPendingWakeMessages: CollabMessage.hasOutstandingWakeMsg(node.id),
      hasRemoteTaskListeners: !!ExperimentRemoteTaskListener.has(node.id, "collab"),
    }
  }

  export function children(agentId: string): AgentInfo[] {
    return CollabAgentNode.loadChildren(agentId)
  }

  export function tree(rootAgentId: string): AgentInfo[] {
    return CollabAgentNode.loadTree(rootAgentId)
  }

  export function isAncestor(ancestorId: string, descendantId: string) {
    return CollabAgentNode.isAncestor(ancestorId, descendantId)
  }

  export function branchSettled(agentId: string) {
    return CollabAgentNode.isBranchSettled(agentId)
  }

  export function listLatestProgress(agentId: string): Record<string, unknown> {
    const msgs = CollabMessage.list(agentId, { kind: "child_progress", limit: 500 })
    const latest = new Map<string, unknown>()
    for (const m of msgs) {
      const payload = m.payload_json as { childAgentId?: string }
      if (!payload?.childAgentId) continue
      latest.set(payload.childAgentId, m.payload_json)
    }
    return Object.fromEntries(latest)
  }

  export function listMessages(
    agentId: string,
    opts?: Parameters<typeof CollabMessage.list>[1],
  ): ReturnType<typeof CollabMessage.list> {
    return CollabMessage.list(agentId, opts)
  }

  export async function createSubSession(input: { title: string; permission?: PermissionNext.Ruleset }) {
    // Creates the session that backs a spawned Collab peer. Intentionally
    // does NOT set a session parentID — the agent hierarchy is tracked in
    // collab_agent, not at the session layer. At the session layer each
    // peer is independent (a first-class session of the same project).
    const config = await Config.get()
    const permission: PermissionNext.Ruleset = [
      { permission: "todowrite", pattern: "*", action: "deny" },
      { permission: "todoread", pattern: "*", action: "deny" },
      ...(config.experimental?.primary_tools?.map((t) => ({
        pattern: "*" as const,
        action: "allow" as const,
        permission: t,
      })) ?? []),
      ...(input.permission ?? []),
    ]
    return Session.createNext({
      directory: Instance.directory,
      title: input.title,
      permission,
      collabPeer: true,
    })
  }

  export function runtime() {
    return CollabRuntime
  }

  /**
   * Wait until a Collab root agent's supervisor loop is fully settled —
   * i.e. the tree is either terminal (completed / failed / canceled) OR
   * the root is active with no outstanding children, no pending wake-up
   * messages in its inbox, and its session is idle (no LLM turn in flight).
   *
   * This is the right thing to await when an external caller (like the
   * `task` tool) kicked off a single LLM turn that happened to spawn Collab
   * peers: the first turn returns with "I've spawned N children" but the
   * real conclusion is emitted by a later AutoWake-driven turn once the
   * children have reported back. Settling on Idle + empty inbox catches
   * both cases without tying ourselves to a single "completion" event that
   * root agents (driven by AutoWake, not CollabLoop) never emit.
   */
  export function waitForRootSettled(sessionId: string, rootAgentId: string, abort?: AbortSignal): Promise<void> {
    const isSettled = () => {
      const node = CollabAgentNode.tryLoad(rootAgentId)
      if (!node) return true
      if (!CollabAgentNode.isActive(node.status)) return true
      if (node.active_children > 0) return false
      if (ExperimentRemoteTaskListener.has(rootAgentId, "collab")) return false
      if (CollabMessage.hasOutstandingWakeMsg(rootAgentId)) return false
      if (SessionStatus.get(sessionId).type !== "idle") return false
      // AutoWake's maybeWakeOrBlock claims the inflight lock before it
      // drain+transitions+awaits SessionPrompt. Between drain and the
      // SessionPrompt.prompt call there's a window where inbox is empty,
      // status just flipped to "running", and session is still idle — all
      // our settled signals fire, but the actual summary turn hasn't
      // started. Treat "AutoWake is driving" as not-yet-settled.
      if (CollabAutoWake.isDriving(sessionId)) return false
      return true
    }

    return new Promise<void>((resolve) => {
      if (isSettled()) {
        resolve()
        return
      }

      let done = false
      const finish = () => {
        if (done) return
        done = true
        offIdle()
        offStatus()
        offDriveEnded()
        if (abort && onAbort) abort.removeEventListener("abort", onAbort)
        resolve()
      }

      const offIdle = Bus.subscribe(SessionStatus.Event.Idle, (e) => {
        if (e.properties.sessionID !== sessionId) return
        if (isSettled()) finish()
      })
      const offStatus = Bus.subscribe(CollabEvent.AgentStatus, (e) => {
        if (e.properties.agentId !== rootAgentId) return
        if (isSettled()) finish()
      })
      // AgentStatus / Idle during AutoWake's drive cycle get filtered by
      // isDriving(). RootDriveEnded fires *after* inflight is released, so
      // this is the only signal that reliably re-ticks us post-drive.
      const offDriveEnded = Bus.subscribe(CollabEvent.RootDriveEnded, (e) => {
        if (e.properties.rootAgentId !== rootAgentId) return
        if (isSettled()) finish()
      })

      const onAbort = abort
        ? () => {
            void cancel(rootAgentId, "task aborted")
              .catch(() => {})
              .finally(finish)
          }
        : undefined
      if (abort && onAbort) abort.addEventListener("abort", onAbort)

      // Close the race window between the initial isSettled() and subscribe
      // activation — an Idle / AgentStatus event could have fired between
      // them.
      if (isSettled()) finish()
    })
  }
}
