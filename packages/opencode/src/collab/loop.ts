import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { Provider } from "@/provider/provider"
import { Workflow } from "@/workflow"
import { ExperimentRemoteTaskListener } from "@/research/experiment-remote-task-listener"
import { CollabAgentNode } from "./agent-node"
import { CollabMessage } from "./message"
import { CollabRuntime } from "./runtime"
import { CollabEvent } from "./events"
import { CollabSupervisor } from "./supervisor"
import {
  buildChildDonePart,
  buildChildFailedPart,
  buildChildProgressPart,
  buildChildWaitingPart,
  buildRemoteTaskTerminalPart,
  finalizeParts,
  type PromptPartDraft,
} from "./return-parts"
import type {
  AgentError,
  AgentInfo,
  AgentResult,
  ChildDonePayload,
  ChildFailedPayload,
  ChildProgressPayload,
  ChildWaitingPayload,
  ProgressInjection,
  RemoteTaskTerminalPayload,
  UserInputPayload,
} from "./types"

export namespace CollabLoop {
  const log = Log.create({ service: "collab.loop" })
  const waiters = new Map<string, Set<() => void>>()

  GlobalBus.on("event", (e) => {
    if (e.payload.type !== CollabEvent.MessagePosted.type) return
    const props = e.payload.properties as { recipientAgentId?: string; kind?: string }
    if (!props.recipientAgentId || !isWakeKind(props.kind ?? "")) return
    for (const wake of [...(waiters.get(props.recipientAgentId) ?? [])]) wake()
  })

  export async function start(agentId: string): Promise<void> {
    const node = CollabAgentNode.load(agentId)
    const session = await Session.get(node.session_id)
    if (session.directory !== Instance.directory) {
      return Instance.provide({
        directory: session.directory,
        fn: () => start(agentId),
      })
    }
    if (CollabRuntime.has(agentId)) {
      log.warn("loop already running", { agentId })
      return CollabRuntime.get(agentId)!.promise
    }
    const abort = new AbortController()
    const promise = runLoop(agentId, abort.signal).catch(async (err) => {
      log.error("loop crashed", { agentId, error: String(err) })
      if (Provider.ModelNotFoundError.isInstance(err) || err instanceof SessionPrompt.ModelUnavailableError) {
        await waitForModel(agentId, err)
        return
      }
      await markLoopFailed(agentId, err)
    })
    CollabRuntime.register(agentId, abort, promise)
    return promise
  }

  async function markLoopFailed(agentId: string, err: unknown) {
    try {
      const info = CollabAgentNode.tryLoad(agentId)
      if (!info || !CollabAgentNode.isActive(info.status)) return
      const error: AgentError = {
        code: "LOOP_CRASH",
        message: err instanceof Error ? err.message : String(err),
        detail: err instanceof Error ? err.stack : undefined,
      }
      await finalizeFailed(info, error)
    } catch (e) {
      log.error("markLoopFailed failed", { agentId, error: String(e) })
    }
  }

  async function waitForModel(agentId: string, err: unknown) {
    const node = CollabAgentNode.tryLoad(agentId)
    if (!node || !CollabAgentNode.isActive(node.status)) return
    const unavailable = Provider.ModelNotFoundError.isInstance(err)
      ? `${err.data.providerID}/${err.data.modelID}`
      : "the configured models"
    const message = `Model ${unavailable} is unavailable. Resume this same agent after selecting an available model.`
    if (!node.parent_agent_id) {
      CollabAgentNode.transition(node.id, "waiting_interaction", { phase: "main_loop" })
      return
    }
    await CollabMessage.postChildWaiting({
      agentId: node.id,
      rootAgentId: node.root_agent_id,
      recipientAgentId: node.parent_agent_id,
      payload: {
        childAgentId: node.id,
        childName: node.name,
        childSessionId: node.session_id,
        reason: "model_unavailable",
        message,
      },
    })
  }

  async function runLoop(agentId: string, abort: AbortSignal) {
    log.info("loop.start", { agentId })

    // Recovery path: if the agent already left `pending`, its initialPrompt
    // has been injected previously and we must NOT replay it on restart —
    // doing so posts a duplicate (often empty, for root agents) user message
    // that breaks strict providers.
    let hasRunInitialPrompt = false
    {
      const initial = CollabAgentNode.load(agentId)
      if (initial.status === "pending") {
        CollabAgentNode.transition(agentId, "running", { phase: "main_loop", timeStarted: Date.now() })
      } else if (initial.status === "blocked_on_children") {
        CollabAgentNode.transition(agentId, "running", { phase: "main_loop" })
        hasRunInitialPrompt = true
      } else if (initial.status === "running" || initial.status === "waiting_interaction") {
        if (initial.status === "waiting_interaction") {
          CollabAgentNode.transition(agentId, "running", { phase: "main_loop" })
        }
        hasRunInitialPrompt = true
      }
    }

    let firstTick = true

    while (!abort.aborted) {
      const node = CollabAgentNode.load(agentId)
      if (!CollabAgentNode.isActive(node.status)) {
        log.info("loop.exit", { agentId, status: node.status })
        return
      }

      const msgs = CollabMessage.drain(agentId)

      let gotCancel = false
      const injections: PromptPartDraft[] = []
      const progressMsgs: ChildProgressPayload[] = []
      let failFastTrigger: ChildFailedPayload | undefined
      let fallback: UserInputPayload["model"]

      for (const m of msgs) {
        const payload = m.payload_json as unknown
        switch (m.kind) {
          case "cancel":
            gotCancel = true
            break
          case "child_done": {
            injections.push(buildChildDonePart(payload as ChildDonePayload))
            break
          }
          case "child_failed": {
            const p = payload as ChildFailedPayload
            const policy = node.spec.policy?.on_fail ?? "fail_fast"
            if (policy === "fail_fast") {
              failFastTrigger = p
            } else {
              injections.push(buildChildFailedPart(p))
            }
            break
          }
          case "child_waiting": {
            injections.push(buildChildWaitingPart(payload as ChildWaitingPayload))
            break
          }
          case "child_progress": {
            const p = payload as ChildProgressPayload
            progressMsgs.push(p)
            break
          }
          case "remote_task_terminal": {
            injections.push(buildRemoteTaskTerminalPart(payload as RemoteTaskTerminalPayload))
            break
          }
          case "user_input": {
            const p = payload as UserInputPayload
            fallback = p.model ?? fallback
            Workflow.autoResume({
              sessionID: node.session_id,
              userMessageID: p.messageId ?? m.id,
              userMessage: p.text,
            })
            injections.push({ type: "text", text: p.text })
            break
          }
          case "system":
            break
        }
      }

      if (gotCancel) {
        log.info("loop.cancel", { agentId })
        await CollabSupervisor.cancelDescendants(agentId, { reason: "parent canceled", initiator: "parent" })
        await finalizeCanceled(node, "cancel message received")
        return
      }

      if (failFastTrigger) {
        log.info("loop.fail_fast", { agentId, childId: failFastTrigger.childAgentId })
        await CollabSupervisor.cancelDescendants(agentId, {
          reason: "sibling failed (fail_fast)",
          initiator: "sibling",
        })
        const error: AgentError = {
          code: "CHILD_FAILED_FAIL_FAST",
          message: `Child ${failFastTrigger.childAgentId} failed: ${failFastTrigger.message}`,
          detail: failFastTrigger.detail,
        }
        await finalizeFailed(node, error)
        return
      }

      const collapsedProgress = collapseProgress(progressMsgs, node.spec.policy?.progress_injection ?? "latest")
      for (const p of collapsedProgress) injections.push(buildChildProgressPart(p))

      if (injections.length > 0) {
        if (abort.aborted) return
        await runPromptTurn(node, { parts: finalizeParts(injections), fallback }, abort)
        if (await pauseIfWorkflowWaiting(agentId, abort)) return
        firstTick = false
        hasRunInitialPrompt = true
        continue
      }

      if (firstTick && !hasRunInitialPrompt) {
        if (abort.aborted) return
        await runPromptTurn(node, { parts: [{ type: "text", text: node.spec.initialPrompt }] }, abort)
        if (await pauseIfWorkflowWaiting(agentId, abort)) return
        firstTick = false
        hasRunInitialPrompt = true
        continue
      }

      const refreshed = CollabAgentNode.load(agentId)
      if (
        refreshed.active_children === 0 &&
        !ExperimentRemoteTaskListener.has(refreshed.id, "collab") &&
        !CollabMessage.hasPendingWakeMsg(refreshed.id)
      ) {
        const inst = Workflow.latest(refreshed.session_id)
        if (inst?.status === "waiting_interaction") {
          if (await pauseIfWorkflowWaiting(agentId, abort)) return
        }
        if (inst?.status === "running") {
          await runPromptTurn(
            refreshed,
            {
              parts: [
                {
                  type: "text",
                  text: "Continue the active workflow. Call workflow.next, workflow.wait_interaction, or workflow.fail as appropriate.",
                },
              ],
            },
            abort,
          )
          if (await pauseIfWorkflowWaiting(agentId, abort)) return
          firstTick = false
          hasRunInitialPrompt = true
          continue
        }
        if (await finalizeCompleted(refreshed)) return
        continue
      }

      CollabAgentNode.transition(agentId, "blocked_on_children", { phase: "awaiting_children" })
      await waitForInbox(agentId, abort)
      if (abort.aborted) return
      CollabAgentNode.transition(agentId, "running", { phase: "main_loop" })
    }
  }

  async function runPromptTurn(
    node: AgentInfo,
    input: { parts: PromptPartDraft[]; fallback?: { providerID: string; modelID: string } },
    abort: AbortSignal,
  ) {
    const model = input.fallback
      ? await SessionPrompt.resolveModel({
          sessionID: node.session_id,
          agent: node.subagent_type,
          preferred: node.spec.model,
          fallback: input.fallback,
        })
      : node.spec.model
    if (input.fallback && model) {
      CollabAgentNode.spec(node.id, { ...node.spec, model })
    }
    const onAbort = () => SessionPrompt.cancel(node.session_id)
    abort.addEventListener("abort", onAbort, { once: true })
    try {
      await SessionPrompt.prompt({
        sessionID: node.session_id,
        agent: node.subagent_type,
        model,
        parts: input.parts,
      })
    } catch (err) {
      if (abort.aborted) return
      throw err
    } finally {
      abort.removeEventListener("abort", onAbort)
    }
  }

  async function pauseIfWorkflowWaiting(agentId: string, abort: AbortSignal): Promise<boolean> {
    const node = CollabAgentNode.load(agentId)
    if (!node.parent_agent_id) return false
    const inst = Workflow.latest(node.session_id)
    if (inst?.status !== "waiting_interaction") return false

    const step = inst.current_index >= 0 ? inst.steps[inst.current_index] : undefined
    const payload: ChildWaitingPayload = {
      childAgentId: node.id,
      childName: node.name,
      childSessionId: node.session_id,
      workflowInstanceId: inst.id,
      waitMessageId: step?.interaction?.wait_after_user_message_id,
      reason: step?.interaction?.reason,
      message: step?.interaction?.message,
    }

    const duplicate = CollabMessage.list(node.parent_agent_id, { kind: "child_waiting", limit: 500 }).some((m) => {
      const p = m.payload_json as Partial<ChildWaitingPayload>
      if (p.childAgentId !== node.id) return false
      if (p.workflowInstanceId !== inst.id) return false
      if (payload.waitMessageId && p.waitMessageId !== payload.waitMessageId) return false
      return true
    })
    if (duplicate) return true

    await CollabMessage.postChildWaiting({
      agentId: node.id,
      rootAgentId: node.root_agent_id,
      recipientAgentId: node.parent_agent_id,
      payload,
    })
    log.info("waiting_interaction", { agentId, parentAgentId: node.parent_agent_id })
    return true
  }

  function waitForInbox(agentId: string, abort: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        const waits = waiters.get(agentId)
        waits?.delete(finish)
        if (waits?.size === 0) waiters.delete(agentId)
        abort.removeEventListener("abort", onAbort)
        resolve()
      }
      const onAbort = () => finish()
      const waits = waiters.get(agentId) ?? new Set()
      waits.add(finish)
      waiters.set(agentId, waits)
      abort.addEventListener("abort", onAbort)
      if (CollabMessage.hasPendingWakeMsg(agentId)) finish()
    })
  }

  function isWakeKind(kind: string) {
    return (
      kind === "child_done" ||
      kind === "child_failed" ||
      kind === "child_waiting" ||
      kind === "remote_task_terminal" ||
      kind === "cancel" ||
      kind === "user_input"
    )
  }

  async function finalizeCompleted(node: AgentInfo) {
    const summary = await extractSessionSummary(node.session_id)
    const fresh = CollabAgentNode.load(node.id)
    if (!CollabAgentNode.isActive(fresh.status)) return false
    if (fresh.active_children > 0) return false
    if (ExperimentRemoteTaskListener.has(fresh.id, "collab")) return false
    if (CollabMessage.hasPendingWakeMsg(fresh.id)) return false
    const result: AgentResult = { summary: summary ?? undefined }

    CollabAgentNode.transition(fresh.id, "completed", {
      phase: "main_loop",
      result,
      timeEnded: Date.now(),
    })
    CollabMessage.closeInbox(fresh.id)

    if (fresh.parent_agent_id) {
      const payload: ChildDonePayload = {
        childAgentId: fresh.id,
        childName: fresh.name,
        summary: summary ?? "",
      }
      await CollabMessage.post({
        recipientAgentId: fresh.parent_agent_id,
        senderAgentId: fresh.id,
        kind: "child_done",
        payload,
      })
    }

    Bus.publish(CollabEvent.AgentCompleted, {
      agentId: fresh.id,
      rootAgentId: fresh.root_agent_id,
      summary: summary ?? undefined,
    })
    log.info("completed", { agentId: fresh.id })
    return true
  }

  async function finalizeFailed(node: AgentInfo, error: AgentError) {
    CollabAgentNode.transition(node.id, "failed", {
      phase: "main_loop",
      error,
      timeEnded: Date.now(),
    })
    CollabMessage.closeInbox(node.id)

    if (node.parent_agent_id) {
      const payload: ChildFailedPayload = {
        childAgentId: node.id,
        childName: node.name,
        reason: "error",
        message: error.message,
        detail: error.detail,
      }
      await CollabMessage.post({
        recipientAgentId: node.parent_agent_id,
        senderAgentId: node.id,
        kind: "child_failed",
        payload,
      })
    }

    Bus.publish(CollabEvent.AgentFailed, {
      agentId: node.id,
      rootAgentId: node.root_agent_id,
      code: error.code,
      message: error.message,
    })
    log.warn("failed", { agentId: node.id, error: error.message })
  }

  async function finalizeCanceled(node: AgentInfo, reason: string) {
    const error: AgentError = { code: "CANCELED", message: reason }
    CollabAgentNode.transition(node.id, "canceled", {
      phase: "main_loop",
      error,
      timeEnded: Date.now(),
    })
    CollabMessage.closeInbox(node.id)

    if (node.parent_agent_id) {
      const payload: ChildFailedPayload = {
        childAgentId: node.id,
        childName: node.name,
        reason: "canceled",
        message: reason,
      }
      await CollabMessage.post({
        recipientAgentId: node.parent_agent_id,
        senderAgentId: node.id,
        kind: "child_failed",
        payload,
      })
    }

    Bus.publish(CollabEvent.AgentFailed, {
      agentId: node.id,
      rootAgentId: node.root_agent_id,
      code: "CANCELED",
      message: reason,
    })
    log.info("canceled", { agentId: node.id })
  }

  async function extractSessionSummary(sessionID: string): Promise<string | null> {
    try {
      const msgs = await Session.messages({ sessionID })
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (msg.info.role !== "assistant") continue
        for (const part of msg.parts) {
          if (part.type === "text" && typeof (part as MessageV2.TextPart).text === "string") {
            const txt = (part as MessageV2.TextPart).text
            if (txt && txt.trim().length > 0) return truncate(txt, 8 * 1024)
          }
        }
      }
    } catch (e) {
      log.warn("extractSessionSummary failed", { sessionID, error: String(e) })
    }
    return null
  }

  function truncate(text: string, max: number) {
    if (text.length <= max) return text
    return text.slice(0, max) + "\n...[truncated]"
  }

  export function collapseProgress(msgs: ChildProgressPayload[], strategy: ProgressInjection): ChildProgressPayload[] {
    if (strategy === "none" || msgs.length === 0) return []
    if (strategy === "all") return msgs
    // "latest": keep only the latest per child (by turn, fall back to insertion order)
    const latestByChild = new Map<string, ChildProgressPayload>()
    for (const m of msgs) {
      const prev = latestByChild.get(m.childAgentId)
      if (!prev || m.turn >= prev.turn) latestByChild.set(m.childAgentId, m)
    }
    return [...latestByChild.values()]
  }
}
