import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { SessionOwnership } from "@/session/ownership"
import { CollabAgentNode } from "./agent-node"
import { CollabMessage } from "./message"
import { CollabSupervisor } from "./supervisor"
import { CollabLoop } from "./loop"
import { CollabRuntime } from "./runtime"
import { CollabEvent } from "./events"
import { CollabDelivery } from "./delivery"
import {
  buildChildDonePart,
  buildChildFailedPart,
  buildChildProgressPart,
  buildChildWaitingPart,
  buildRemoteTaskTerminalPart,
  finalizeParts,
  matchParts,
  type PromptPartDraft,
} from "./return-parts"
import type {
  AgentError,
  AgentInfo,
  CancelPayload,
  ChildDonePayload,
  ChildFailedPayload,
  ChildProgressPayload,
  ChildWaitingPayload,
  RemoteTaskTerminalPayload,
  UserInputPayload,
} from "./types"
import { WAKE_MESSAGE_KINDS } from "./types"

export namespace CollabAutoWake {
  const log = Log.create({ service: "collab.auto-wake" })

  let enabled = true

  export function setEnabled(v: boolean) {
    enabled = v
  }

  export function isEnabled() {
    return enabled
  }

  // Test-only: when set, driveTurn will short-circuit to this fn after draining.
  // Used to bypass SessionPrompt in unit tests (which have no LLM configured).
  let driveTurnOverride: ((agentId: string) => Promise<void>) | undefined

  export function setDriveTurnOverrideForTesting(fn: ((agentId: string) => Promise<void>) | undefined) {
    driveTurnOverride = fn
  }

  const state = Instance.state(
    () => {
      const inflight = new Set<string>()
      const turns = new Map<string, { agentId: string; lifecycle?: string; cancel: () => void }>()

      const unsubMsg = Bus.subscribe(CollabEvent.MessagePosted, (e) => {
        if (!enabled) return
        const { recipientAgentId, kind } = e.properties
        if (kind === "session_remote_task_terminal") {
          void tryDriveDirectById(recipientAgentId, inflight).catch((err) =>
            log.error("onDirectMessagePosted", { recipientAgentId, error: String(err) }),
          )
          return
        }
        if (!(WAKE_MESSAGE_KINDS as readonly string[]).includes(kind)) return
        void tryDriveById(recipientAgentId, inflight).catch((err) =>
          log.error("onMessagePosted", { recipientAgentId, error: String(err) }),
        )
      })

      const unsubIdle = Bus.subscribe(SessionStatus.Event.Idle, (e) => {
        if (!enabled) return
        const { sessionID } = e.properties
        void tryDriveBySession(sessionID, inflight).catch((err) =>
          log.error("onSessionIdle", { sessionID, error: String(err) }),
        )
      })

      const unsubAgent = Bus.subscribe(CollabEvent.AgentStatus, (e) => {
        if (!enabled) return
        void tryDriveDirectById(e.properties.agentId, inflight).catch((err) =>
          log.error("onAgentStatus", { agentId: e.properties.agentId, error: String(err) }),
        )
      })

      // also scan existing idle roots on startup
      queueMicrotask(() => {
        if (!enabled) return
        try {
          scanExistingRoots(inflight)
        } catch (err) {
          log.error("initialScan failed", { error: String(err) })
        }
      })

      return { inflight, turns, unsubMsg, unsubIdle, unsubAgent }
    },
    async (s) => {
      s.unsubMsg()
      s.unsubIdle()
      s.unsubAgent()
      s.inflight.clear()
      s.turns.clear()
    },
  )

  export function ensure() {
    state()
  }

  export function wake(sessionID: string) {
    if (!enabled) return
    void tryDriveBySession(sessionID, state().inflight).catch((err) =>
      log.error("wake", { sessionID, error: String(err) }),
    )
  }

  /**
   * True while maybeWakeOrBlock is mid-flight for this session — i.e. we've
   * claimed the inflight lock and are about to or in the middle of a
   * drain / transition / SessionPrompt cycle. External waiters (like
   * Collab.waitForRootSettled) need this to avoid the race where drain
   * empties the inbox and transition flips status to "running" BEFORE the
   * LLM turn has actually started (session still reads as idle), producing
   * a phantom "settled" window that sits between the last child's report
   * and the final summary turn.
   */
  export function isDriving(sessionId: string): boolean {
    return state().inflight.has(sessionId)
  }

  export function interrupt(agentId: string, lifecycle: string) {
    const node = CollabAgentNode.tryLoad(agentId)
    if (!node || node.parent_agent_id || CollabAgentNode.lifecycle(node.spec) !== lifecycle) return false
    const turn = state().turns.get(node.session_id)
    if (!turn || turn.agentId !== agentId || turn.lifecycle !== lifecycle) return false
    turn.cancel()
    return true
  }

  function track(node: AgentInfo) {
    const turn = {
      agentId: node.id,
      lifecycle: CollabAgentNode.lifecycle(node.spec),
      cancel: () => SessionPrompt.cancel(node.session_id),
    }
    state().turns.set(node.session_id, turn)
    return () => {
      if (state().turns.get(node.session_id) === turn) state().turns.delete(node.session_id)
    }
  }

  function scanExistingRoots(inflight: Set<string>) {
    const project = Instance.project
    for (const row of CollabMessage.direct(project.id)) {
      void tryDriveDirectById(row.agentId, inflight).catch((err) =>
        log.error("initialScan.direct", { id: row.agentId, error: String(err) }),
      )
    }
    const active = CollabAgentNode.loadActiveByProject(project.id)
    for (const node of active) {
      void tryDriveById(node.id, inflight).catch((err) =>
        log.error("initialScan.node", { id: node.id, error: String(err) }),
      )
    }
  }

  async function route(
    node: AgentInfo,
    inflight: Set<string>,
    drive: (fresh: AgentInfo, current: Set<string>) => void | Promise<void>,
  ) {
    const session = await Session.get(node.session_id)
    if (session.time.archived) return
    if (session.directory === Instance.directory) return drive(node, inflight)
    return Instance.provide({
      directory: session.directory,
      init: async () => {
        const { InstanceBootstrap } = await import("@/project/bootstrap")
        await InstanceBootstrap()
      },
      async fn() {
        ensure()
        const fresh = CollabAgentNode.tryLoad(node.id)
        if (!fresh) return
        await drive(fresh, state().inflight)
      },
    })
  }

  async function driveNode(node: AgentInfo, inflight: Set<string>) {
    CollabMessage.reconcileRemoteTerminals(node.id)
    if (CollabMessage.hasPendingKind(node.id, "session_remote_task_terminal")) {
      await maybeDriveDirect(node, inflight)
      return
    }
    if (!CollabAgentNode.isActive(node.status)) return
    if (node.parent_agent_id) {
      maybeStartLoop(node)
      return
    }
    await maybeWakeOrBlock(node, inflight)
  }

  async function tryDriveById(agentId: string, inflight: Set<string>) {
    const node = CollabAgentNode.tryLoad(agentId)
    if (!node) return
    await route(node, inflight, driveNode)
  }

  async function tryDriveBySession(sessionID: string, inflight: Set<string>) {
    const node = CollabAgentNode.loadBySessionId(sessionID)
    if (!node) return
    await route(node, inflight, driveNode)
  }

  async function tryDriveDirectById(agentId: string, inflight: Set<string>) {
    const node = CollabAgentNode.tryLoad(agentId)
    if (!node) return
    await route(node, inflight, maybeDriveDirect)
  }

  async function maybeDriveDirect(node: AgentInfo, inflight: Set<string>) {
    if (CollabAgentNode.isStopped(node)) return
    if (inflight.has(node.session_id)) return
    if (SessionStatus.get(node.session_id).type === "busy") {
      if (
        CollabMessage.hasOutstanding(node.id, "session_remote_task_terminal") ||
        CollabMessage.hasOutstandingWakeMsg(node.id)
      ) {
        CollabRuntime.schedule(node.id, 1000, () => void tryDriveById(node.id, inflight))
      }
      return
    }
    if (!CollabMessage.hasOutstanding(node.id, "session_remote_task_terminal")) return

    const release = SessionOwnership.claim(node.session_id, "collab")
    if (!release) {
      CollabRuntime.schedule(
        node.id,
        SessionOwnership.retryAfter(node.session_id),
        () => void tryDriveDirectById(node.id, inflight),
      )
      return
    }
    const lost = () => SessionPrompt.cancel(node.session_id)
    release.signal.addEventListener("abort", lost, { once: true })
    const untrack = track(node)
    inflight.add(node.session_id)
    try {
      try {
        SessionPrompt.assertNotBusy(node.session_id)
      } catch {
        CollabRuntime.schedule(node.id, 1000, () => void tryDriveDirectById(node.id, inflight))
        return
      }
      CollabMessage.retryProcessing(node.id)
      for (let i = 0; i < MAX_DRIVE_ITERATIONS; i++) {
        if (SessionStatus.get(node.session_id).type === "busy") return
        if (!CollabMessage.hasPendingKind(node.id, "session_remote_task_terminal")) return
        await driveDirect(node.id, release.signal)
      }
      log.warn("maybeDriveDirect hit MAX_DRIVE_ITERATIONS cap", { agentId: node.id })
    } finally {
      inflight.delete(node.session_id)
      untrack()
      release.signal.removeEventListener("abort", lost)
      release()
      if (
        CollabMessage.hasOutstanding(node.id, "session_remote_task_terminal") ||
        CollabMessage.hasOutstandingWakeMsg(node.id)
      ) {
        CollabRuntime.schedule(node.id, 1000, () => void tryDriveById(node.id, inflight))
      }
    }
  }

  async function driveDirect(agentId: string, abort: AbortSignal) {
    if (driveTurnOverride) {
      await driveTurnOverride(agentId)
      if (abort.aborted) {
        CollabMessage.retryProcessing(agentId)
        return
      }
      CollabMessage.ackProcessing(agentId)
      return
    }
    const node = CollabAgentNode.load(agentId)
    const msgs = CollabMessage.drain(agentId, "direct")
    try {
      const parts = msgs.map((msg) => buildRemoteTaskTerminalPart(msg.payload_json as RemoteTaskTerminalPayload))
      if (!parts.length) return
      const drafts = finalizeParts(parts)
      const delivery = (msgs[0].payload_json as { deliveryMessageId?: unknown }).deliveryMessageId
      const messageID = typeof delivery === "string" ? delivery : undefined
      if (abort.aborted) throw new Error("Session ownership lost during direct delivery")
      const turn = await CollabDelivery.deliver({
        node,
        msgs,
        messageID,
        match: (msg) => matchParts(msg.parts, drafts),
        prompt: (id) =>
          SessionPrompt.prompt({
            sessionID: node.session_id,
            messageID: id,
            agent: node.subagent_type,
            model: node.spec.model,
            parts: drafts,
          }),
      })
      if (abort.aborted) throw new Error("Session ownership lost during direct delivery")
      if (!(await CollabDelivery.delivered(turn.result, node, turn.messageID))) {
        throw new Error("Direct callback did not produce its assistant turn")
      }
      CollabMessage.ack(msgs)
    } catch (err) {
      if (err instanceof CollabDelivery.Exhausted) {
        CollabMessage.drop(err.claims)
        CollabMessage.retry(
          msgs.filter((msg) => !err.claims.some((claim) => claim.id === msg.id)),
          false,
        )
        return
      }
      CollabMessage.retry(msgs, false)
      if (err instanceof CollabDelivery.ClaimChanged || err instanceof CollabDelivery.Stale) return
      const fresh = CollabAgentNode.tryLoad(agentId)
      if (fresh && !CollabAgentNode.isStopped(fresh)) {
        CollabRuntime.schedule(agentId, 1000, () => void tryDriveDirectById(agentId, state().inflight))
      }
      throw err
    }
  }

  function maybeStartLoop(node: AgentInfo) {
    if (CollabRuntime.has(node.id)) return
    if (SessionStatus.get(node.session_id).type === "busy") return
    if (
      node.status === "waiting_interaction" &&
      node.error?.code === "MODEL_UNAVAILABLE" &&
      !CollabMessage.hasPendingKind(node.id, "user_input")
    )
      return
    if (
      !CollabMessage.hasPendingWakeMsg(node.id) &&
      !(node.initiator === "human" && node.status === "waiting_interaction")
    )
      return
    void CollabLoop.start(node.id)
  }

  // Safety cap: if driveTurn keeps producing new wake messages (e.g. runaway child
  // cascade), bail out after this many iterations per session acquisition and let
  // the next Bus event re-enter. Prevents pathological spin.
  const MAX_DRIVE_ITERATIONS = 64

  async function maybeWakeOrBlock(node: AgentInfo, inflight: Set<string>) {
    if (!CollabAgentNode.isActive(node.status)) return
    if (node.parent_agent_id) {
      maybeStartLoop(node)
      return
    }
    if (inflight.has(node.session_id)) return
    if (SessionStatus.get(node.session_id).type === "busy") {
      if (
        CollabMessage.hasOutstandingWakeMsg(node.id) ||
        CollabMessage.hasOutstanding(node.id, "session_remote_task_terminal")
      ) {
        CollabRuntime.schedule(node.id, 1000, () => void tryDriveById(node.id, inflight))
      }
      return
    }

    const release = SessionOwnership.claim(node.session_id, "collab")
    if (!release) {
      CollabRuntime.schedule(
        node.id,
        SessionOwnership.retryAfter(node.session_id),
        () => void tryDriveById(node.id, inflight),
      )
      return
    }
    const lost = () => SessionPrompt.cancel(node.session_id)
    release.signal.addEventListener("abort", lost, { once: true })
    const untrack = track(node)
    inflight.add(node.session_id)
    try {
      try {
        SessionPrompt.assertNotBusy(node.session_id)
      } catch {
        CollabRuntime.schedule(node.id, 1000, () => void tryDriveById(node.id, inflight))
        return
      }
      CollabMessage.retryProcessing(node.id)
      for (let i = 0; i < MAX_DRIVE_ITERATIONS; i++) {
        const fresh = CollabAgentNode.tryLoad(node.id)
        if (!fresh || !CollabAgentNode.isActive(fresh.status)) return
        // Something else started an LLM turn on this session (e.g. the user typed).
        // Back off; we'll be re-triggered by the next Idle or MessagePosted.
        if (SessionStatus.get(fresh.session_id).type === "busy") return

        if (!CollabMessage.hasPendingWakeMsg(fresh.id)) {
          // No (more) wake messages. Ensure blocked-on-children status is correct.
          if (fresh.active_children > 0 && fresh.status !== "blocked_on_children") {
            CollabAgentNode.transition(fresh.id, "blocked_on_children", { phase: "awaiting_children" })
          }
          return
        }

        if (!(await driveTurn(fresh.id, release.signal))) {
          const latest = CollabAgentNode.tryLoad(node.id)
          if (latest && CollabAgentNode.isActive(latest.status)) {
            CollabRuntime.schedule(node.id, 1000, () => void tryDriveById(node.id, inflight))
          }
          return
        }
        // Loop: during driveTurn more child_done/failed may have arrived. Re-check.
      }
      log.warn("maybeWakeOrBlock hit MAX_DRIVE_ITERATIONS cap", { agentId: node.id })
    } finally {
      inflight.delete(node.session_id)
      untrack()
      release.signal.removeEventListener("abort", lost)
      release()
      if (
        CollabMessage.hasOutstandingWakeMsg(node.id) ||
        CollabMessage.hasOutstanding(node.id, "session_remote_task_terminal")
      ) {
        CollabRuntime.schedule(node.id, 1000, () => void tryDriveById(node.id, inflight))
      }
      // Signal anyone waiting on this root (e.g. Collab.waitForRootSettled)
      // that the drive cycle ended — the AgentStatus / Idle events fired
      // during the cycle were filtered out by their isDriving() guard, so
      // without this notification they'd never re-check.
      Bus.publish(CollabEvent.RootDriveEnded, {
        sessionID: node.session_id,
        rootAgentId: node.id,
      })
    }
  }

  async function driveTurn(agentId: string, abort: AbortSignal) {
    if (driveTurnOverride) {
      await driveTurnOverride(agentId)
      if (abort.aborted) {
        CollabMessage.retryProcessing(agentId)
        return false
      }
      CollabMessage.ackProcessing(agentId)
      return true
    }
    const node = CollabAgentNode.load(agentId)
    const msgs = CollabMessage.drain(agentId)
    try {
      let cancel: CancelPayload | undefined
      const returnParts: PromptPartDraft[] = []
      const progressMsgs: ChildProgressPayload[] = []
      let failFastTrigger: ChildFailedPayload | undefined
      let messageID: string | undefined

      for (const m of msgs) {
        const payload = m.payload_json as unknown
        const delivery = (payload as { deliveryMessageId?: unknown })?.deliveryMessageId
        if (!messageID && typeof delivery === "string") messageID = delivery
        switch (m.kind) {
          case "cancel":
            cancel = payload as CancelPayload
            break
          case "child_done": {
            const p = payload as ChildDonePayload
            returnParts.push(buildChildDonePart(p))
            break
          }
          case "child_failed": {
            const p = payload as ChildFailedPayload
            const policy = node.spec.policy?.on_fail ?? "fail_fast"
            if (policy === "fail_fast" && p.reason !== "canceled") failFastTrigger = p
            else returnParts.push(buildChildFailedPart(p))
            break
          }
          case "child_waiting": {
            returnParts.push(buildChildWaitingPart(payload as ChildWaitingPayload))
            break
          }
          case "child_progress":
            progressMsgs.push(payload as ChildProgressPayload)
            break
          case "remote_task_terminal":
            returnParts.push(buildRemoteTaskTerminalPart(payload as RemoteTaskTerminalPayload))
            break
          case "user_input": {
            const input = payload as UserInputPayload
            messageID = input.messageId ?? messageID
            returnParts.push({ type: "text", text: input.text })
            break
          }
          case "system":
            break
        }
      }

      if (cancel) {
        const errorInfo: AgentError = { code: "CANCELED", message: cancel.reason }
        const latched = (() => {
          try {
            return CollabAgentNode.transition(
              node.id,
              node.status,
              { error: errorInfo },
              {
                runId: node.run_id,
                parentId: node.parent_agent_id,
                status: node.status,
                timeUpdated: node.time_updated,
              },
            )
          } catch {
            return
          }
        })()
        if (!latched) {
          CollabMessage.retry(msgs, false)
          return false
        }
        await CollabSupervisor.cancelChildren(agentId, { reason: cancel.reason, initiator: "parent" })
        if (abort.aborted) {
          CollabMessage.retry(msgs, false)
          return false
        }
        CollabAgentNode.transition(
          node.id,
          "canceled",
          { phase: "main_loop", error: errorInfo, timeEnded: Date.now() },
          {
            runId: latched.run_id,
            parentId: latched.parent_agent_id,
            status: latched.status,
            timeUpdated: latched.time_updated,
          },
        )
        CollabMessage.closeInbox(node.id)
        return true
      }

      if (failFastTrigger) {
        const errorInfo: AgentError = {
          code: "CHILD_FAILED_FAIL_FAST",
          message: `Child ${failFastTrigger.childAgentId} failed: ${failFastTrigger.message}`,
          detail: failFastTrigger.detail,
        }
        const latched = (() => {
          try {
            return CollabAgentNode.transition(
              node.id,
              node.status,
              { error: errorInfo },
              {
                runId: node.run_id,
                parentId: node.parent_agent_id,
                status: node.status,
                timeUpdated: node.time_updated,
              },
            )
          } catch {
            return
          }
        })()
        if (!latched) {
          CollabMessage.retry(msgs, false)
          return false
        }
        await CollabSupervisor.cancelChildren(agentId, {
          reason: "sibling failed (fail_fast)",
          initiator: "sibling",
        })
        if (abort.aborted) {
          CollabMessage.retry(msgs, false)
          return false
        }
        CollabAgentNode.transition(
          node.id,
          "failed",
          { phase: "main_loop", error: errorInfo, timeEnded: Date.now() },
          {
            runId: latched.run_id,
            parentId: latched.parent_agent_id,
            status: latched.status,
            timeUpdated: latched.time_updated,
          },
        )
        CollabMessage.closeInbox(node.id)
        return true
      }

      const collapsed = CollabLoop.collapseProgress(progressMsgs, node.spec.policy?.progress_injection ?? "latest")
      for (const p of collapsed) returnParts.push(buildChildProgressPart(p))
      const parts = finalizeParts(returnParts)

      if (returnParts.length === 0) {
        CollabMessage.ack(msgs)
        return true
      }

      if (node.status === "blocked_on_children") {
        CollabAgentNode.transition(agentId, "running", { phase: "main_loop" })
      }

      if (abort.aborted) {
        CollabMessage.retry(msgs, false)
        return false
      }
      const turn = await CollabDelivery.deliver({
        node,
        msgs,
        messageID,
        match: (msg) => matchParts(msg.parts, parts),
        prompt: (id) =>
          SessionPrompt.prompt({
            sessionID: node.session_id,
            messageID: id,
            agent: node.subagent_type,
            model: node.spec.model,
            parts,
          }),
      })
      if (abort.aborted) {
        CollabMessage.retry(msgs, false)
        return false
      }
      if (!(await CollabDelivery.delivered(turn.result, node, turn.messageID))) {
        throw new Error("Callback did not produce its assistant turn")
      }
      CollabMessage.ack(msgs)
      return true
    } catch (err) {
      log.error("SessionPrompt.prompt failed in auto-wake", {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      })
      if (err instanceof CollabDelivery.Exhausted) {
        CollabMessage.drop(err.claims)
        CollabMessage.retry(
          msgs.filter((msg) => !err.claims.some((claim) => claim.id === msg.id)),
          false,
        )
        return false
      }
      const fresh = CollabAgentNode.tryLoad(agentId)
      if (fresh && CollabAgentNode.isActive(fresh.status)) {
        CollabMessage.retry(msgs, false)
      } else {
        CollabMessage.closeInbox(agentId)
      }
      return false
    }
  }
}
