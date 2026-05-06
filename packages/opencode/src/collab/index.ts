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
import { CollabAgentNode } from "./agent-node"
import { CollabMessage } from "./message"
import { CollabLoop } from "./loop"
import { CollabRuntime } from "./runtime"
import { CollabSupervisor } from "./supervisor"
import { CollabProgressHook } from "./progress-hook"
import { CollabAutoWake } from "./auto-wake"
import { CollabEvent } from "./events"
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

    const info = CollabAgentNode.create({
      id: agentId,
      sessionId: session.id,
      parentAgentId: parent?.id ?? null,
      name: input.name,
      projectId: expectedProjectId,
      rootAgentId,
      subagentType: input.subagentType,
      spec: input.spec,
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
    return CollabMessage.post({
      recipientAgentId: agentId,
      senderAgentId: null,
      kind: "user_input",
      payload,
    })
  }

  /**
   * Re-open a completed / failed / canceled agent and deliver a new user
   * instruction to it. The agent resumes in its existing session (history
   * preserved), transitions back to `running`, and runs a fresh LLM turn
   * consuming the new prompt. When it completes again, it will post another
   * `child_done` to its parent. Intended for multi-turn collaboration where
   * the parent wants to give additional instructions to an already-finished
   * peer.
   */
  export async function resume(input: { agentId: string; prompt: string }): Promise<AgentInfo> {
    CollabProgressHook.ensure()
    CollabAutoWake.ensure()

    const node = CollabAgentNode.tryLoad(input.agentId)
    if (!node) throw new NotFoundError({ message: `Agent not found: ${input.agentId}` })

    // Must be terminal. If it's already active, the caller should use
    // `send_to_agent` instead — no need to resume a running peer.
    if (CollabAgentNode.isActive(node.status)) {
      throw new Error(
        `Cannot resume agent ${node.id}: already active (status=${node.status}). Use send_to_agent instead.`,
      )
    }

    // If the parent has also finalized, resuming would orphan the child —
    // no one to receive `child_done`. Refuse.
    if (node.parent_agent_id) {
      const parent = CollabAgentNode.tryLoad(node.parent_agent_id)
      if (!parent || !CollabAgentNode.isActive(parent.status)) {
        throw new Error(
          `Cannot resume agent ${node.id}: parent ${node.parent_agent_id} is not active (parent status=${parent?.status ?? "missing"}).`,
        )
      }
    }

    // Avoid racing with any lingering loop registration.
    if (CollabRuntime.has(node.id)) {
      log.warn("resume: runtime still had an entry, aborting it first", { agentId: node.id })
      CollabRuntime.abort(node.id)
    }

    // 1) Transition child back to running; clear prior error but keep result
    //    history. 2) Re-bump parent's active_children so blocked_on_children
    //    works on next completion.
    CollabAgentNode.transition(node.id, "running", {
      phase: "main_loop",
      error: null,
      timeEnded: null,
    })
    if (node.parent_agent_id) {
      CollabAgentNode.bumpActiveChildren(node.parent_agent_id, 1)
    }

    // Post the instruction into its inbox BEFORE starting the loop, so the
    // loop's first drain picks it up and injects it instead of re-running
    // spec.initialPrompt.
    await CollabMessage.post({
      recipientAgentId: node.id,
      senderAgentId: null,
      kind: "user_input",
      payload: { text: input.prompt },
    })

    void CollabLoop.start(node.id)
    log.info("resume", { agentId: node.id, parentAgentId: node.parent_agent_id })
    return CollabAgentNode.load(node.id)
  }

  export async function cancel(agentId: string, reason?: string): Promise<void> {
    const cancelPayload: CancelPayload = {
      reason: reason ?? "canceled by request",
      initiator: "user",
    }
    await CollabMessage.post({
      recipientAgentId: agentId,
      senderAgentId: null,
      kind: "cancel",
      payload: cancelPayload,
    })
    await CollabSupervisor.cancelDescendants(agentId, { reason: cancelPayload.reason, initiator: "user" })
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

  export function children(agentId: string): AgentInfo[] {
    return CollabAgentNode.loadChildren(agentId)
  }

  export function tree(rootAgentId: string): AgentInfo[] {
    return CollabAgentNode.loadTree(rootAgentId)
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
  export function waitForRootSettled(
    sessionId: string,
    rootAgentId: string,
    abort?: AbortSignal,
  ): Promise<void> {
    const isSettled = () => {
      const node = CollabAgentNode.tryLoad(rootAgentId)
      if (!node) return true
      if (!CollabAgentNode.isActive(node.status)) return true
      if (node.active_children > 0) return false
      if (CollabMessage.hasPendingWakeMsg(rootAgentId)) return false
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
