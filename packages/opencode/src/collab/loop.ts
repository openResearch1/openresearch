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
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
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
  CancelPayload,
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
  export const DEFAULT_TIMEOUT = 5 * 60 * 1000
  type Identity = { runId: string | null; parentId: string | null }
  type Guard = Identity & { status?: AgentInfo["status"]; timeUpdated?: number; error?: null }

  class PromptRetry extends Error {
    constructor(readonly error: unknown) {
      super(error instanceof Error ? error.message : String(error))
    }
  }

  class PromptAbort extends Error {
    constructor(
      message: string,
      readonly delivered = false,
    ) {
      super(message)
    }
  }

  class TurnError extends Error {
    constructor(readonly info: AgentError) {
      super(info.message)
    }
  }

  function failure(err: unknown): AgentError {
    if (err instanceof TurnError) return err.info
    if (Provider.ModelNotFoundError.isInstance(err)) {
      return {
        code: "MODEL_UNAVAILABLE",
        message: `Model ${err.data.providerID}/${err.data.modelID} is unavailable.`,
      }
    }
    if (err instanceof SessionPrompt.ModelUnavailableError) {
      return { code: "MODEL_UNAVAILABLE", message: err.message }
    }
    if (MessageV2.AuthError.isInstance(err)) {
      return { code: "PROVIDER_AUTH", message: err.data.message }
    }
    if (MessageV2.APIError.isInstance(err)) {
      return {
        code: err.data.isRetryable ? "PROVIDER_API_RETRY_EXHAUSTED" : "PROVIDER_API",
        message: err.data.message,
      }
    }
    if (MessageV2.ContextOverflowError.isInstance(err)) {
      return { code: "CONTEXT_OVERFLOW", message: err.data.message }
    }
    const value = err as { message?: unknown; stack?: unknown; data?: { message?: unknown } }
    return {
      code: "LOOP_CRASH",
      message:
        typeof value?.message === "string"
          ? value.message
          : typeof value?.data?.message === "string"
            ? value.data.message
            : String(err),
      detail: typeof value?.stack === "string" ? value.stack : undefined,
    }
  }

  GlobalBus.on("event", (e) => {
    if (e.payload.type !== CollabEvent.MessagePosted.type) return
    const props = e.payload.properties as { recipientAgentId?: string; kind?: string }
    if (!props.recipientAgentId || !isWakeKind(props.kind ?? "")) return
    for (const wake of [...(waiters.get(props.recipientAgentId) ?? [])]) wake()
  })

  export function timeout(node: AgentInfo) {
    if (CollabAgentNode.role(node.id)) return
    return node.spec.policy?.timeout_ms ?? DEFAULT_TIMEOUT
  }

  function schedule(node: AgentInfo, identity: Identity) {
    const duration = timeout(node)
    if (duration === undefined) return
    const deadline = (node.time_started ?? node.time_created) + duration
    CollabRuntime.schedule(node.id, Math.max(deadline - Date.now(), 0), () => {
      void fail(
        node.id,
        {
          code: "TIMEOUT",
          message: `Agent exceeded its ${duration}ms timeout.`,
        },
        identity,
      )
    })
  }

  export function watch(agentId: string) {
    const node = CollabAgentNode.tryLoad(agentId)
    if (!node || !CollabAgentNode.isActive(node.status)) return
    schedule(node, { runId: node.run_id, parentId: node.parent_agent_id })
  }

  export async function fail(agentId: string, error: AgentError, expected?: Guard) {
    let node = CollabAgentNode.tryLoad(agentId)
    if (!node || !CollabAgentNode.isActive(node.status)) return
    const guard: Guard = {
      runId: node.run_id,
      parentId: node.parent_agent_id,
      status: node.status,
      timeUpdated: node.time_updated,
      error: node.error ? undefined : null,
      ...expected,
    }
    const identity = { runId: guard.runId, parentId: guard.parentId }
    if (!matches(node, identity)) return
    try {
      node = CollabAgentNode.transition(node.id, node.status, { error: node.error ?? error }, guard)
    } catch {
      return
    }

    const runtime = CollabRuntime.get(agentId)
    if (runtime) {
      CollabRuntime.abortAndUnregister(agentId)
      await Promise.race([runtime.promise.catch(() => {}), Bun.sleep(1000)])
      node = CollabAgentNode.tryLoad(agentId)
      if (!node || !matches(node, identity) || !CollabAgentNode.isActive(node.status)) return
    }

    SessionPrompt.cancel(node.session_id)
    await Promise.all([Question.rejectSession(node.session_id), PermissionNext.rejectSession(node.session_id)])
    let release = SessionOwnership.claim(node.session_id, "collab")
    if (!release) {
      SessionOwnership.revoke(node.session_id)
      await SessionOwnership.wait(node.session_id)
      release = SessionOwnership.claim(node.session_id, "collab")
    }
    if (!release) {
      CollabRuntime.schedule(agentId, SessionOwnership.retryAfter(node.session_id), () => {
        void fail(agentId, node.error ?? error, identity)
      })
      return
    }

    try {
      const msgs = CollabMessage.drain(agentId)
      if (msgs.length) CollabMessage.drop(msgs)
      await finalizeFailed(node, identity, node.error ?? error, undefined, release.token)
    } finally {
      release()
    }
  }

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
    const duration = timeout(current)
    const deadline = duration === undefined ? undefined : (current.time_started ?? current.time_created) + duration
    if (session.collabPeer && deadline !== undefined && Date.now() >= deadline) {
      await fail(
        agentId,
        {
          code: "TIMEOUT",
          message: `Agent exceeded its ${duration}ms timeout.`,
        },
        identity,
      )
      return
    }
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
    const peer = session.collabPeer === true
    let expired = false
    const deadlineTimer = peer && deadline !== undefined
      ? setTimeout(() => {
          expired = true
          abort.abort()
          void fail(
            agentId,
            {
              code: "TIMEOUT",
              message: `Agent exceeded its ${duration}ms timeout.`,
            },
            identity,
          )
        }, Math.max(deadline - Date.now(), 0))
      : undefined
    deadlineTimer?.unref?.()
    const lost = () => abort.abort()
    release.signal.addEventListener("abort", lost, { once: true })
    const promise = (expired
      ? Promise.reject(new TurnError({ code: "TIMEOUT", message: "Agent timed out before it could start." }))
      : runLoop(agentId, identity, abort.signal, release.token, peer)
    )
      .catch(async (err) => {
        const cause = err instanceof PromptRetry ? err.error : err
        if (!expired && cause instanceof PromptAbort) {
          if (release.valid()) interrupt(agentId, identity)
          return
        }
        log.error("loop crashed", { agentId, error: String(cause) })
        if (!release.valid()) return
        if (expired) {
          await markLoopFailed(
            agentId,
            identity,
            new TurnError({
              code: "TIMEOUT",
              message: `Agent exceeded its ${duration}ms timeout.`,
            }),
            release.token,
          )
          return
        }
        if (
          !peer &&
          (Provider.ModelNotFoundError.isInstance(cause) || cause instanceof SessionPrompt.ModelUnavailableError)
        ) {
          await waitForModel(agentId, identity, cause)
          return
        }
        if (cause instanceof PromptAbort) return
        if (err instanceof PromptRetry && !peer) return
        await markLoopFailed(agentId, identity, cause, release.token)
      })
      .finally(() => {
        if (deadlineTimer) clearTimeout(deadlineTimer)
        release.signal.removeEventListener("abort", lost)
        release()
        const timer = setTimeout(() => {
          const fresh = CollabAgentNode.tryLoad(agentId)
          if (!fresh || !matches(fresh, identity) || !CollabAgentNode.isActive(fresh.status)) return
          if (peer) schedule(fresh, identity)
          if (
            fresh.status === "waiting_interaction" &&
            fresh.error?.code === "MODEL_UNAVAILABLE" &&
            !CollabMessage.hasPendingKind(agentId, "user_input")
          )
            return
          if (!CollabMessage.hasPendingWakeMsg(agentId)) return
          void start(agentId, identity)
        }, 0)
        timer.unref?.()
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

  function interrupt(agentId: string, identity: Identity) {
    const node = current(agentId, identity)
    if (!node || !CollabAgentNode.isActive(node.status) || node.error || node.active_children === 0) return
    try {
      CollabAgentNode.transition(
        node.id,
        "blocked_on_children",
        { phase: "awaiting_children" },
        {
          runId: node.run_id,
          parentId: node.parent_agent_id,
          status: node.status,
          timeUpdated: node.time_updated,
        },
      )
    } catch {}
  }

  async function markLoopFailed(agentId: string, identity: Identity, err: unknown, lease: string) {
    try {
      const info = current(agentId, identity)
      if (!info || !CollabAgentNode.isActive(info.status)) return
      await finalizeFailed(info, identity, failure(err), undefined, lease)
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
    if (node.initiator === "human") {
      CollabAgentNode.transition(node.id, "waiting_interaction", {
        phase: "main_loop",
        error: { code: "MODEL_UNAVAILABLE", message },
      })
      return
    }
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

  async function runLoop(agentId: string, identity: Identity, abort: AbortSignal, lease: string, peer: boolean) {
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
          CollabAgentNode.transition(agentId, "running", {
            phase: "main_loop",
            error: initial.error?.code === "MODEL_UNAVAILABLE" ? null : undefined,
          })
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
      const filtered = claimed.filter((msg) => !stale.includes(msg))
      const msgs = filtered.some((msg) => isWakeKind(msg.kind)) ? filtered : []
      if (filtered.length && !msgs.length) CollabMessage.retry(filtered, false)

      let gotCancel = false
      const injections: PromptPartDraft[] = []
      const progressMsgs: ChildProgressPayload[] = []
      let failFastTrigger: ChildFailedPayload | undefined
      let sender: UserInputPayload["model"]
      let messageID: string | undefined
      let prompt: UserInputPayload["prompt"]

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
            sender = p.model ?? sender
            messageID = p.messageId ?? messageID
            prompt = p.prompt ?? prompt
            if (p.prompt) break
            Workflow.autoResume({ sessionID: node.session_id, userMessageID: p.messageId ?? m.id, userMessage: p.text })
            injections.push({ type: "text", text: p.text })
            break
          }
          case "system":
            break
        }
      }

      if (gotCancel) {
        log.info("loop.cancel", { agentId })
        const error: AgentError = { code: "CANCELED", message: "cancel message received" }
        try {
          CollabAgentNode.transition(node.id, node.status, { error }, {
            runId: node.run_id,
            parentId: node.parent_agent_id,
            status: node.status,
            timeUpdated: node.time_updated,
          })
        } catch {
          return
        }
        await CollabSupervisor.cancelChildren(agentId, { reason: "parent canceled", initiator: "parent" })
        if (abort.aborted) {
          CollabMessage.retry(msgs, false)
          return
        }
        CollabMessage.dropPending(agentId)
        const finalized = await finalizeCanceled(node, identity, error.message, abort, lease)
        if (!finalized) {
          CollabMessage.retry(msgs, false)
          return
        }
        CollabMessage.drop(msgs)
        return
      }

      if (node.error && node.error.code !== "MODEL_UNAVAILABLE") {
        CollabMessage.ack(msgs)
        const fresh = current(agentId, identity)
        if (!fresh) return
        if (fresh.active_children > 0) {
          try {
            CollabAgentNode.transition(
              fresh.id,
              "blocked_on_children",
              { phase: "awaiting_children", error: node.error },
              {
                runId: fresh.run_id,
                parentId: fresh.parent_agent_id,
                status: fresh.status,
                timeUpdated: fresh.time_updated,
              },
            )
          } catch {}
          return
        }
        if (node.error.code === "CANCELED") {
          await finalizeCanceled(fresh, identity, node.error.message, abort, lease)
        } else {
          await finalizeFailed(fresh, identity, node.error, abort, lease)
        }
        return
      }

      if (failFastTrigger) {
        log.info("loop.fail_fast", { agentId, childId: failFastTrigger.childAgentId })
        const error: AgentError = {
          code: "CHILD_FAILED_FAIL_FAST",
          message: `Child ${failFastTrigger.childAgentId} failed: ${failFastTrigger.message}`,
          detail: failFastTrigger.detail,
        }
        await finalizeFailed(node, identity, error, abort, lease, {
          reason: "sibling failed (fail_fast)",
          initiator: "sibling",
        })
        return
      }

      const collapsedProgress = collapseProgress(progressMsgs, node.spec.policy?.progress_injection ?? "latest")
      for (const p of collapsedProgress) injections.push(buildChildProgressPart(p))

      if (injections.length > 0 || prompt) {
        if (abort.aborted || !current(agentId, identity)) {
          CollabMessage.retry(msgs, false)
          return
        }
        try {
          await runPromptTurn(
            node,
            {
              parts: [...(prompt?.parts ?? []), ...finalizeParts(injections)],
              sender,
              messageID,
              prompt,
            },
            abort,
          )
        } catch (err) {
          if (err instanceof PromptAbort) {
            if (err.delivered) CollabMessage.ack(msgs)
            throw err
          }
          const fresh = CollabAgentNode.tryLoad(agentId)
          if (peer) {
            if (fresh && CollabAgentNode.isActive(fresh.status)) CollabMessage.drop(msgs)
            throw err
          }
          const unavailable =
            Provider.ModelNotFoundError.isInstance(err) || err instanceof SessionPrompt.ModelUnavailableError
          if (fresh && CollabAgentNode.isActive(fresh.status)) {
            const queued = prompt
              ? msgs.filter((msg) => msg.kind === "user_input" && (msg.payload_json as UserInputPayload).prompt)
              : []
            if (unavailable && queued.length) {
              CollabMessage.drop(queued)
              CollabMessage.retry(
                msgs.filter((msg) => !queued.includes(msg)),
                false,
              )
            } else {
              CollabMessage.retry(msgs, false)
            }
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
        if (refreshed.error) {
          if (refreshed.error.code === "CANCELED") {
            await finalizeCanceled(refreshed, identity, refreshed.error.message, abort, lease)
          } else {
            await finalizeFailed(refreshed, identity, refreshed.error, abort, lease)
          }
          return
        }
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
      parts: SessionPrompt.PromptInput["parts"]
      sender?: { providerID: string; modelID: string }
      messageID?: string
      prompt?: Omit<SessionPrompt.PromptInput, "sessionID">
    },
    abort: AbortSignal,
  ) {
    const model =
      input.prompt?.model ??
      (input.sender
        ? await SessionPrompt.resolveModel({
            sessionID: node.session_id,
            agent: node.subagent_type,
            sender: input.sender,
            current: node.spec.model,
          })
        : node.spec.model)
    if (abort.aborted) throw new PromptAbort("Prompt aborted before model resolution")
    if ((input.sender || input.prompt?.model) && model) {
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
      if (
        durable?.info.role === "user" &&
        (input.prompt
          ? containsPromptParts(durable.parts, input.parts)
          : matchParts(durable.parts, input.parts as PromptPartDraft[]))
      ) {
        if (abort.aborted) throw new PromptAbort("Prompt aborted before durable resume")
        const result = await SessionPrompt.loop({ sessionID: node.session_id })
        if (result?.info.role === "assistant" && MessageV2.AbortedError.isInstance(result.info.error)) {
          throw new PromptAbort(result.info.error.data.message, true)
        }
        if (abort.aborted) throw new PromptAbort("Prompt aborted during durable resume", !!result)
        if (result?.info.role === "assistant" && result.info.error) throw new TurnError(failure(result.info.error))
        return
      }
      if (durable) {
        await Session.removeMessage({ sessionID: node.session_id, messageID: durable.info.id })
        if (abort.aborted) throw new PromptAbort("Prompt aborted during durable replacement")
      }
      if (abort.aborted) throw new PromptAbort("Prompt aborted before delivery")
      const result = await SessionPrompt.prompt({
        ...input.prompt,
        sessionID: node.session_id,
        messageID: input.messageID,
        agent: input.prompt?.agent ?? node.subagent_type,
        model,
        parts: input.parts,
      })
      if (result?.info.role === "assistant" && MessageV2.AbortedError.isInstance(result.info.error)) {
        throw new PromptAbort(result.info.error.data.message, true)
      }
      if (abort.aborted) throw new PromptAbort("Prompt aborted during delivery", !!result)
      if (result?.info.role === "assistant" && result.info.error) throw new TurnError(failure(result.info.error))
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw new PromptAbort(err.message)
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

    if (node.initiator === "human") {
      CollabAgentNode.transition(node.id, "waiting_interaction", { phase: "main_loop" })
      return true
    }

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
    if (fresh.error) return false
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

    if (fresh.initiator !== "human") {
      Bus.publish(CollabEvent.AgentCompleted, {
        agentId: done.id,
        rootAgentId: done.root_agent_id,
        summary: summary ?? undefined,
      })
    }
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
    cancel?: { reason: string; initiator: CancelPayload["initiator"] },
  ) {
    if (abort?.aborted) return
    const currentNode = current(node.id, identity)
    if (!currentNode || !CollabAgentNode.isActive(currentNode.status)) return
    const fresh = (() => {
      try {
        return CollabAgentNode.transition(currentNode.id, currentNode.status, { error }, {
          runId: currentNode.run_id,
          parentId: currentNode.parent_agent_id,
          status: currentNode.status,
          timeUpdated: currentNode.time_updated,
        })
      } catch {
        return
      }
    })()
    if (!fresh) return
    if (fresh.active_children > 0) {
      await CollabSupervisor.cancelChildren(
        fresh.id,
        cancel ?? { reason: error.message, initiator: "parent" },
      )
      try {
        CollabAgentNode.transition(
          fresh.id,
          "blocked_on_children",
          { phase: "awaiting_children", error },
          {
            runId: fresh.run_id,
            parentId: fresh.parent_agent_id,
            status: fresh.status,
            timeUpdated: fresh.time_updated,
          },
        )
      } catch {}
      return
    }
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

    if (fresh.initiator !== "human") {
      Bus.publish(CollabEvent.AgentFailed, {
        agentId: done.id,
        rootAgentId: done.root_agent_id,
        code: error.code,
        message: error.message,
      })
    }
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
    if (abort.aborted) return false
    const error: AgentError = { code: "CANCELED", message: reason }
    const currentNode = current(node.id, identity)
    if (!currentNode || !CollabAgentNode.isActive(currentNode.status)) return false
    const fresh = (() => {
      try {
        return CollabAgentNode.transition(currentNode.id, currentNode.status, { error }, {
          runId: currentNode.run_id,
          parentId: currentNode.parent_agent_id,
          status: currentNode.status,
          timeUpdated: currentNode.time_updated,
        })
      } catch {
        return false
      }
    })()
    if (!fresh) return false
    if (fresh.active_children > 0) {
      try {
        CollabAgentNode.transition(
          fresh.id,
          "blocked_on_children",
          { phase: "awaiting_children", error },
          {
            runId: fresh.run_id,
            parentId: fresh.parent_agent_id,
            status: fresh.status,
            timeUpdated: fresh.time_updated,
          },
        )
      } catch {
        return false
      }
      return true
    }
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
    if (!done) return false
    ExperimentRemoteTaskListener.clear(CollabAgentNode.loadBranch(done.id).map((item) => item.id))

    if (fresh.initiator !== "human") {
      Bus.publish(CollabEvent.AgentFailed, {
        agentId: done.id,
        rootAgentId: done.root_agent_id,
        code: "CANCELED",
        message: reason,
      })
    }
    const release = current(done.id, identity)
    if (release?.parent_agent_id && release.spec.policy?.detach_on_terminal) CollabAgentNode.release(done.id)
    log.info("canceled", { agentId: done.id })
    return true
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

  function containsPromptParts(stored: MessageV2.Part[], drafts: SessionPrompt.PromptInput["parts"]) {
    const used = new Set<number>()
    return drafts.every((draft) => {
      const index = stored.findIndex((part, index) => {
        if (used.has(index)) return false
        if (part.type !== draft.type) return false
        if (draft.type === "file" && part.type === "file") {
          return part.mime === draft.mime && part.filename === draft.filename
        }
        return Object.entries(draft).every(([key, value]) => {
          if (key === "id") return true
          return JSON.stringify((part as unknown as Record<string, unknown>)[key]) === JSON.stringify(value)
        })
      })
      if (index < 0) return false
      used.add(index)
      return true
    })
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
