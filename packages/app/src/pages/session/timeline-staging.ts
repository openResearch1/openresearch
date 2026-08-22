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

export const hasStaged = (sessions: string[], session: string) => sessions.includes(session)

export const rememberStaged = (sessions: string[], session: string) => {
  if (hasStaged(sessions, session)) return sessions
  return [...sessions.slice(-15), session]
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
    completed: [] as string[],
    count: 0,
  })
  const [readySession, setReadySession] = createSignal("")
  let active = ""
  const done = (session: string) => hasStaged(state.completed, session)
  const complete = (session: string) => {
    if (done(session)) return
    setState("completed", (items) => rememberStaged(items, session))
  }

  const stagedCount = createMemo(() => {
    const total = input.messages().length
    if (input.turnStart() <= 0) return total
    if (done(input.sessionKey())) return total
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

        const staging = state.activeSession === sessionKey && !done(sessionKey)
        const shouldStage = isWindowed && total > input.config.init && !done(sessionKey)

        if (staging && !switched && shouldStage && frame !== undefined) return

        cancel()

        if (shouldStage) setReadySession("")
        if (!shouldStage) {
          if (isWindowed) complete(sessionKey)
          setState({ activeSession: "", count: total })
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
            complete(sessionKey)
            setState("activeSession", "")
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
    return state.activeSession === key && !done(key)
  })
  const ready = createMemo(() => readySession() === input.sessionKey())

  onCleanup(() => {
    cancel()
  })
  return { messages: stagedUserMessages, isStaging, ready }
}
