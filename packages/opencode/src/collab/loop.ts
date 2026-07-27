import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionOwnership } from "@/session/ownership"
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
  matchParts,
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
  type Identity = { runId: string | null; parentId: string | null }

  class PromptRetry extends Error {
    constructor(readonly error: unknown) {
      super(error instanceof Error ? error.message : String(error))
    }
  }

  class PromptAbort extends Error {}

  GlobalBus.on("event", (e) => {
    if (e.payload.type !== CollabEvent.MessagePosted.type) return
    const props = e.payload.properties as { recipientAgentId?: string; kind?: string }
    if (!props.recipientAgentId || !isWakeKind(props.kind ?? "")) return
    for (const wake of [...(waiters.get(props.recipientAgentId) ?? [])]) wake()
  })

  export async function start(agentId: string, expected?: Identity): Promise<void> {
    const node = CollabAgentNode.load(agentId)
    const identity = expected ?? { runId: node.run_id, parentId: node.parent_agent_id }
    if (!matches(node, identity)) return
    const session = await Session.get(node.session_id)
    if (session.directory !== Instance.directory) {
      return Instance.provide({
        directory: session.directory,
        fn: () => start(agentId, identity),
      })
    }
    const current = CollabAgentNode.tryLoad(agentId)
    if (!current || !matches(current, identity)) return
    if (CollabRuntime.has(agentId)) {
      if (CollabRuntime.matches(agentId, identity)) {
        log.warn("loop already running", { agentId })
        return CollabRuntime.get(agentId)!.promise
      }
      const prior = CollabRuntime.get(agentId)!
      CollabRuntime.abortAndUnregister(agentId)
      await prior.promise.catch(() => {})
      const fresh = CollabAgentNode.tryLoad(agentId)
      if (!fresh || !matches(fresh, identity)) return
    }
    const release = SessionOwnership.claim(node.session_id, "collab")
    if (!release) {
      CollabRuntime.schedule(agentId, SessionOwnership.retryAfter(node.session_id), () => void start(agentId, identity))
      return
    }
    CollabMessage.retryProcessing(agentId)
    const abort = new AbortController()
    const lost = () => abort.abort()
    release.signal.addEventListener("abort", lost, { once: true })
    const promise = runLoop(agentId, identity, abort.signal, release.token)
      .catch(async (err) => {
        const cause = err instanceof PromptRetry ? err.error : err
        log.error("loop crashed", { agentId, error: String(cause) })
        if (!release.valid()) return
        if (Provider.ModelNotFoundError.isInstance(cause) || cause instanceof SessionPrompt.ModelUnavailableError) {
          await waitForModel(agentId, identity, cause)
          return
        }
        if (err instanceof PromptRetry || cause instanceof PromptAbort) return
        await markLoopFailed(agentId, identity, cause, release.token)
      })
      .finally(() => {
        release.signal.removeEventListener("abort", lost)
        release()
      })
    CollabRuntime.register(agentId, abort, promise, identity)
    return promise
  }

  function matches(node: AgentInfo, identity: Identity) {
    return node.run_id === identity.runId && node.parent_agent_id === identity.parentId
  }

  function current(agentId: string, identity: Identity) {
    const node = CollabAgentNode.tryLoad(agentId)
    if (!node || !matches(node, identity)) return
    return node
  }

  async function markLoopFailed(agentId: string, identity: Identity, err: unknown, lease: string) {
    try {
      const info = current(agentId, identity)
      if (!info || !CollabAgentNode.isActive(info.status)) return
      const error: AgentError = {
        code: "LOOP_CRASH",
        message: err instanceof Error ? err.message : String(err),
        detail: err instanceof Error ? err.stack : undefined,
      }
      await finalizeFailed(info, identity, error, undefined, lease)
    } catch (e) {
      log.error("markLoopFailed failed", { agentId, error: String(e) })
    }
  }

  async function waitForModel(agentId: string, identity: Identity, err: unknown) {
    const node = current(agentId, identity)
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
        runId: node.run_id ?? undefined,
        childAgentId: node.id,
        childName: node.name,
        childSessionId: node.session_id,
        reason: "model_unavailable",
        message,
      },
    })
  }

  async function runLoop(agentId: string, identity: Identity, abort: AbortSignal, lease: string) {
    log.info("loop.start", { agentId })

    // Recovery path: if the agent already left `pending`, its initialPrompt
    // has been injected previously and we must NOT replay it on restart —
    // doing so posts a duplicate (often empty, for root agents) user message
    // that breaks strict providers.
    let hasRunInitialPrompt = false
    {
      const initial = current(agentId, identity)
      if (!initial) return
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
      const node = current(agentId, identity)
      if (!node) return
      if (!CollabAgentNode.isActive(node.status)) {
        log.info("loop.exit", { agentId, status: node.status })
        return
      }

      const claimed = CollabMessage.drain(agentId)
      const stale = claimed.filter(
        (msg) => (msg.kind === "user_input" || msg.kind === "cancel") && msg.run_id && msg.run_id !== identity.runId,
      )
      if (stale.length) CollabMessage.drop(stale)
      const msgs = claimed.filter((msg) => !stale.includes(msg))

      let gotCancel = false
      const injections: PromptPartDraft[] = []
      const progressMsgs: ChildProgressPayload[] = []
      let failFastTrigger: ChildFailedPayload | undefined
      let fallback: UserInputPayload["model"]
      let messageID: string | undefined

      for (const m of msgs) {
        const payload = m.payload_json as unknown
        const delivery = (payload as { deliveryMessageId?: unknown })?.deliveryMessageId
        if (!messageID && typeof delivery === "string") messageID = delivery
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
            messageID = p.messageId ?? messageID
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
        await finalizeCanceled(node, identity, "cancel message received", abort, lease)
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
        await finalizeFailed(node, identity, error, abort, lease)
        return
      }

      const collapsedProgress = collapseProgress(progressMsgs, node.spec.policy?.progress_injection ?? "latest")
      for (const p of collapsedProgress) injections.push(buildChildProgressPart(p))

      if (injections.length > 0) {
        if (abort.aborted || !current(agentId, identity)) {
          CollabMessage.retry(msgs, false)
          return
        }
        try {
          await runPromptTurn(node, { parts: finalizeParts(injections), fallback, messageID }, abort)
        } catch (err) {
          const fresh = CollabAgentNode.tryLoad(agentId)
          const unavailable =
            Provider.ModelNotFoundError.isInstance(err) || err instanceof SessionPrompt.ModelUnavailableError
          if (fresh && CollabAgentNode.isActive(fresh.status)) {
            CollabMessage.retry(msgs, false)
            if (!unavailable) CollabRuntime.schedule(agentId, 1000, () => void start(agentId, identity))
          }
          throw new PromptRetry(err)
        }
        CollabMessage.ack(msgs)
        if (!current(agentId, identity)) return
        if (await pauseIfWorkflowWaiting(agentId, identity, abort)) return
        firstTick = false
        hasRunInitialPrompt = true
        continue
      }

      if (msgs.length) CollabMessage.ack(msgs)

      if (firstTick && !hasRunInitialPrompt) {
        if (abort.aborted) return
        await runPromptTurn(node, { parts: [{ type: "text", text: node.spec.initialPrompt }] }, abort)
        if (await pauseIfWorkflowWaiting(agentId, identity, abort)) return
        firstTick = false
        hasRunInitialPrompt = true
        continue
      }

      const refreshed = current(agentId, identity)
      if (!refreshed) return
      if (
        refreshed.active_children === 0 &&
        !ExperimentRemoteTaskListener.has(refreshed.id, "collab") &&
        !CollabMessage.hasPendingWakeMsg(refreshed.id)
      ) {
        const inst = Workflow.latest(refreshed.session_id)
        if (inst?.status === "waiting_interaction") {
          if (await pauseIfWorkflowWaiting(agentId, identity, abort)) return
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
          if (await pauseIfWorkflowWaiting(agentId, identity, abort)) return
          firstTick = false
          hasRunInitialPrompt = true
          continue
        }
        if (await finalizeCompleted(refreshed, identity, abort, lease)) return
        continue
      }

      CollabAgentNode.transition(agentId, "blocked_on_children", { phase: "awaiting_children" })
      await waitForInbox(agentId, abort)
      if (abort.aborted) return
      if (!current(agentId, identity)) return
      CollabAgentNode.transition(agentId, "running", { phase: "main_loop" })
    }
  }

  async function runPromptTurn(
    node: AgentInfo,
    input: {
      parts: PromptPartDraft[]
      fallback?: { providerID: string; modelID: string }
      messageID?: string
    },
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
    if (abort.aborted) throw new PromptAbort("Prompt aborted before model resolution")
    if (input.fallback && model) {
      CollabAgentNode.spec(node.id, { ...node.spec, model })
    }
    if (abort.aborted) throw new PromptAbort("Prompt aborted before delivery")
    const onAbort = () => SessionPrompt.cancel(node.session_id)
    abort.addEventListener("abort", onAbort, { once: true })
    try {
      const durable = input.messageID
        ? await MessageV2.get({ sessionID: node.session_id, messageID: input.messageID }).catch(() => undefined)
        : undefined
      if (abort.aborted) throw new PromptAbort("Prompt aborted during durable lookup")
      if (durable?.info.role === "user" && matchParts(durable.parts, input.parts)) {
        if (abort.aborted) throw new PromptAbort("Prompt aborted before durable resume")
        await SessionPrompt.loop({ sessionID: node.session_id })
        if (abort.aborted) throw new PromptAbort("Prompt aborted during durable resume")
        return
      }
      if (durable) {
        await Session.removeMessage({ sessionID: node.session_id, messageID: durable.info.id })
        if (abort.aborted) throw new PromptAbort("Prompt aborted during durable replacement")
      }
      if (abort.aborted) throw new PromptAbort("Prompt aborted before delivery")
      await SessionPrompt.prompt({
        sessionID: node.session_id,
        messageID: input.messageID,
        agent: node.subagent_type,
        model,
        parts: input.parts,
      })
      if (abort.aborted) throw new PromptAbort("Prompt aborted during delivery")
    } catch (err) {
      throw err
    } finally {
      abort.removeEventListener("abort", onAbort)
    }
  }

  async function pauseIfWorkflowWaiting(agentId: string, identity: Identity, abort: AbortSignal): Promise<boolean> {
    const node = current(agentId, identity)
    if (!node) return true
    if (!node.parent_agent_id) return false
    const inst = Workflow.latest(node.session_id)
    if (inst?.status !== "waiting_interaction") return false

    const step = inst.current_index >= 0 ? inst.steps[inst.current_index] : undefined
    const payload: ChildWaitingPayload = {
      runId: node.run_id ?? undefined,
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
      if (p.runId !== (node.run_id ?? undefined)) return false
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

  async function finalizeCompleted(node: AgentInfo, identity: Identity, abort: AbortSignal, lease: string) {
    const summary = await extractSessionSummary(node.session_id)
    if (abort.aborted) return false
    const fresh = current(node.id, identity)
    if (!fresh) return false
    if (!CollabAgentNode.isActive(fresh.status)) return false
    if (fresh.active_children > 0) return false
    if (ExperimentRemoteTaskListener.has(fresh.id, "collab")) return false
    if (CollabMessage.hasPendingWakeMsg(fresh.id)) return false
    const result: AgentResult = { summary: summary ?? undefined }
    const payload: ChildDonePayload = {
      runId: fresh.run_id ?? undefined,
      childAgentId: fresh.id,
      childName: fresh.name,
      summary: summary ?? "",
    }
    const done = CollabAgentNode.finish({
      id: fresh.id,
      runId: identity.runId,
      parentId: identity.parentId,
      status: "completed",
      phase: "main_loop",
      result,
      timeEnded: Date.now(),
      leaseToken: lease,
      report: fresh.parent_agent_id ? { kind: "child_done", payload } : undefined,
    })
    if (!done) return false

    Bus.publish(CollabEvent.AgentCompleted, {
      agentId: done.id,
      rootAgentId: done.root_agent_id,
      summary: summary ?? undefined,
    })
    const release = current(done.id, identity)
    if (release?.parent_agent_id && release.spec.policy?.detach_on_terminal) CollabAgentNode.release(done.id)
    log.info("completed", { agentId: done.id })
    return true
  }

  async function finalizeFailed(
    node: AgentInfo,
    identity: Identity,
    error: AgentError,
    abort?: AbortSignal,
    lease?: string,
  ) {
    if (abort?.aborted) return
    const fresh = current(node.id, identity)
    if (!fresh || !CollabAgentNode.isActive(fresh.status)) return
    const payload: ChildFailedPayload = {
      runId: fresh.run_id ?? undefined,
      childAgentId: fresh.id,
      childName: fresh.name,
      reason: "error",
      message: error.message,
      detail: error.detail,
    }
    const done = CollabAgentNode.finish({
      id: fresh.id,
      runId: identity.runId,
      parentId: identity.parentId,
      status: "failed",
      phase: "main_loop",
      error,
      timeEnded: Date.now(),
      leaseToken: lease,
      report: fresh.parent_agent_id ? { kind: "child_failed", payload } : undefined,
    })
    if (!done) return
    ExperimentRemoteTaskListener.clear(CollabAgentNode.loadBranch(done.id).map((item) => item.id))

    Bus.publish(CollabEvent.AgentFailed, {
      agentId: done.id,
      rootAgentId: done.root_agent_id,
      code: error.code,
      message: error.message,
    })
    const release = current(done.id, identity)
    if (release?.parent_agent_id && release.spec.policy?.detach_on_terminal) CollabAgentNode.release(done.id)
    log.warn("failed", { agentId: done.id, error: error.message })
  }

  async function finalizeCanceled(
    node: AgentInfo,
    identity: Identity,
    reason: string,
    abort: AbortSignal,
    lease: string,
  ) {
    if (abort.aborted) return
    const error: AgentError = { code: "CANCELED", message: reason }
    const fresh = current(node.id, identity)
    if (!fresh || !CollabAgentNode.isActive(fresh.status)) return
    const payload: ChildFailedPayload = {
      runId: fresh.run_id ?? undefined,
      childAgentId: fresh.id,
      childName: fresh.name,
      reason: "canceled",
      message: reason,
    }
    const done = CollabAgentNode.finish({
      id: fresh.id,
      runId: identity.runId,
      parentId: identity.parentId,
      status: "canceled",
      phase: "main_loop",
      error,
      timeEnded: Date.now(),
      leaseToken: lease,
      report: fresh.parent_agent_id ? { kind: "child_failed", payload } : undefined,
    })
    if (!done) return
    ExperimentRemoteTaskListener.clear(CollabAgentNode.loadBranch(done.id).map((item) => item.id))

    Bus.publish(CollabEvent.AgentFailed, {
      agentId: done.id,
      rootAgentId: done.root_agent_id,
      code: "CANCELED",
      message: reason,
    })
    const release = current(done.id, identity)
    if (release?.parent_agent_id && release.spec.policy?.detach_on_terminal) CollabAgentNode.release(done.id)
    log.info("canceled", { agentId: done.id })
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
