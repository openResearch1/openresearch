import type { UserMessage } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, on, onCleanup, startTransition } from "solid-js"
import { createStore } from "solid-js/store"

export type StageConfig = {
  init: number
  batch: number
}

export type TimelineStageInput = {
  sessionKey: () => string
  turnStart: () => number
  messages: () => UserMessage[]
  config: StageConfig
}

/**
 * Defer-mounts small timeline windows so revealing older turns does not
 * block first paint with a large DOM mount.
 *
 * Once staging completes for a session it never re-stages — backfill and
 * new messages render immediately.
 */
export function createTimelineStaging(input: TimelineStageInput) {
  const [state, setState] = createStore({
    activeSession: "",
    completedSession: "",
    count: 0,
  })
  const [readySession, setReadySession] = createSignal("")
  let active = ""

  const stagedCount = createMemo(() => {
    const total = input.messages().length
    if (input.turnStart() <= 0) return total
    if (state.completedSession === input.sessionKey()) return total
    const init = Math.min(total, input.config.init)
    if (state.count <= init) return init
    if (state.count >= total) return total
    return state.count
  })

  const stagedUserMessages = createMemo(() => {
    const list = input.messages()
    const count = stagedCount()
    if (count >= list.length) return list
    return list.slice(Math.max(0, list.length - count))
  })

  let frame: number | undefined
  const cancel = () => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
    frame = undefined
  }
  const scheduleReady = (sessionKey: string) => {
    if (input.sessionKey() !== sessionKey) return
    if (readySession() === sessionKey) return
    setReadySession(sessionKey)
  }

  createEffect(
    on(
      () => [input.sessionKey(), input.turnStart() > 0, input.messages().length] as const,
      ([sessionKey, isWindowed, total]) => {
        const switched = active !== sessionKey
        if (switched) {
          active = sessionKey
          setReadySession("")
        }

        const staging = state.activeSession === sessionKey && state.completedSession !== sessionKey
        const shouldStage = isWindowed && total > input.config.init && state.completedSession !== sessionKey

        if (staging && !switched && shouldStage && frame !== undefined) return

        cancel()

        if (shouldStage) setReadySession("")
        if (!shouldStage) {
          setState({
            activeSession: "",
            completedSession: isWindowed ? sessionKey : state.completedSession,
            count: total,
          })
          if (total <= 0) {
            setReadySession("")
            return
          }
          if (readySession() !== sessionKey) scheduleReady(sessionKey)
          return
        }

        let count = Math.min(total, input.config.init)
        if (staging) count = Math.min(total, Math.max(count, state.count))
        setState({ activeSession: sessionKey, count })

        const step = () => {
          if (input.sessionKey() !== sessionKey) {
            frame = undefined
            return
          }
          const currentTotal = input.messages().length
          count = Math.min(currentTotal, count + input.config.batch)
          startTransition(() => setState("count", count))
          if (count >= currentTotal) {
            setState({ completedSession: sessionKey, activeSession: "" })
            frame = undefined
            scheduleReady(sessionKey)
            return
          }
          frame = requestAnimationFrame(step)
        }
        frame = requestAnimationFrame(step)
      },
    ),
  )

  const isStaging = createMemo(() => {
    const key = input.sessionKey()
    return state.activeSession === key && state.completedSession !== key
  })
  const ready = createMemo(() => readySession() === input.sessionKey())

  onCleanup(() => {
    cancel()
  })
  return { messages: stagedUserMessages, isStaging, ready }
}
