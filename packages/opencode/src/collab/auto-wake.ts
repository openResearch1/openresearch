import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { CollabAgentNode } from "./agent-node"
import { CollabMessage } from "./message"
import { CollabSupervisor } from "./supervisor"
import { CollabLoop } from "./loop"
import { CollabEvent } from "./events"
import {
  buildChildDonePart,
  buildChildFailedPart,
  buildChildProgressPart,
  buildChildWaitingPart,
  finalizeParts,
  type PromptPartDraft,
} from "./return-parts"
import type {
  AgentError,
  AgentInfo,
  ChildDonePayload,
  ChildFailedPayload,
  ChildProgressPayload,
  ChildWaitingPayload,
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

      const unsubMsg = Bus.subscribe(CollabEvent.MessagePosted, (e) => {
        if (!enabled) return
        const { recipientAgentId, kind } = e.properties
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

      // also scan existing idle roots on startup
      queueMicrotask(() => {
        if (!enabled) return
        try {
          scanExistingRoots(inflight)
        } catch (err) {
          log.error("initialScan failed", { error: String(err) })
        }
      })

      return { inflight, unsubMsg, unsubIdle }
    },
    async (s) => {
      s.unsubMsg()
      s.unsubIdle()
      s.inflight.clear()
    },
  )

  export function ensure() {
    state()
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

  function scanExistingRoots(inflight: Set<string>) {
    const project = Instance.project
    const active = CollabAgentNode.loadActiveByProject(project.id)
    for (const node of active) {
      if (node.parent_agent_id) continue
      void maybeWakeOrBlock(node, inflight).catch((err) =>
        log.error("initialScan.node", { id: node.id, error: String(err) }),
      )
    }
  }

  async function tryDriveById(agentId: string, inflight: Set<string>) {
    const node = CollabAgentNode.tryLoad(agentId)
    if (!node) return
    if (node.parent_agent_id) return
    if (!CollabAgentNode.isActive(node.status)) return
    await maybeWakeOrBlock(node, inflight)
  }

  async function tryDriveBySession(sessionID: string, inflight: Set<string>) {
    const node = CollabAgentNode.loadBySessionId(sessionID)
    if (!node) return
    if (node.parent_agent_id) return
    if (!CollabAgentNode.isActive(node.status)) return
    await maybeWakeOrBlock(node, inflight)
  }

  // Safety cap: if driveTurn keeps producing new wake messages (e.g. runaway child
  // cascade), bail out after this many iterations per session acquisition and let
  // the next Bus event re-enter. Prevents pathological spin.
  const MAX_DRIVE_ITERATIONS = 64

  async function maybeWakeOrBlock(node: AgentInfo, inflight: Set<string>) {
    if (inflight.has(node.session_id)) return
    if (SessionStatus.get(node.session_id).type === "busy") return

    inflight.add(node.session_id)
    try {
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

        await driveTurn(fresh.id)
        // Loop: during driveTurn more child_done/failed may have arrived. Re-check.
      }
      log.warn("maybeWakeOrBlock hit MAX_DRIVE_ITERATIONS cap", { agentId: node.id })
    } finally {
      inflight.delete(node.session_id)
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

  async function driveTurn(agentId: string) {
    if (driveTurnOverride) {
      await driveTurnOverride(agentId)
      return
    }
    const node = CollabAgentNode.load(agentId)
    const msgs = CollabMessage.drain(agentId)

    let gotCancel = false
    const returnParts: PromptPartDraft[] = []
    const progressMsgs: ChildProgressPayload[] = []
    let failFastTrigger: ChildFailedPayload | undefined

    for (const m of msgs) {
      const payload = m.payload_json as unknown
      switch (m.kind) {
        case "cancel":
          gotCancel = true
          break
        case "child_done": {
          const p = payload as ChildDonePayload
          returnParts.push(buildChildDonePart(p))
          break
        }
        case "child_failed": {
          const p = payload as ChildFailedPayload
          const policy = node.spec.policy?.on_fail ?? "fail_fast"
          if (policy === "fail_fast") failFastTrigger = p
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
        case "user_input": {
          returnParts.push({ type: "text", text: (payload as UserInputPayload).text })
          break
        }
        case "system":
          break
      }
    }

    if (gotCancel) {
      await CollabSupervisor.cancelDescendants(agentId, { reason: "root canceled", initiator: "user" })
      const errorInfo: AgentError = { code: "CANCELED", message: "cancel message received" }
      CollabAgentNode.transition(node.id, "canceled", { phase: "main_loop", error: errorInfo, timeEnded: Date.now() })
      CollabMessage.closeInbox(node.id)
      return
    }

    if (failFastTrigger) {
      await CollabSupervisor.cancelDescendants(agentId, {
        reason: "sibling failed (fail_fast)",
        initiator: "sibling",
      })
      const errorInfo: AgentError = {
        code: "CHILD_FAILED_FAIL_FAST",
        message: `Child ${failFastTrigger.childAgentId} failed: ${failFastTrigger.message}`,
        detail: failFastTrigger.detail,
      }
      CollabAgentNode.transition(node.id, "failed", { phase: "main_loop", error: errorInfo, timeEnded: Date.now() })
      CollabMessage.closeInbox(node.id)
      return
    }

    const collapsed = CollabLoop.collapseProgress(progressMsgs, node.spec.policy?.progress_injection ?? "latest")
    for (const p of collapsed) returnParts.push(buildChildProgressPart(p))

    if (returnParts.length === 0) return

    if (node.status === "blocked_on_children") {
      CollabAgentNode.transition(agentId, "running", { phase: "main_loop" })
    }

    try {
      await SessionPrompt.prompt({
        sessionID: node.session_id,
        // Pin the root's own subagent_type so the resumed turn runs as the same
        // primary agent the user started the session with (not the global default).
        // Model is resolved by SessionPrompt via lastModel(sessionID), which reads
        // the previous user message's model — i.e., it stays on the parent's model.
        agent: node.subagent_type,
        model: node.spec.model,
        parts: finalizeParts(returnParts),
      })
    } catch (err) {
      log.error("SessionPrompt.prompt failed in auto-wake", {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

}
