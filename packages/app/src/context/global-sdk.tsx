import type { Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter, type GlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup } from "solid-js"
import z from "zod"
import { createSdkForServer } from "@/utils/server"
import { usePlatform } from "./platform"
import { useServer } from "./server"

const abortError = z.object({
  name: z.literal("AbortError"),
})

export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const server = useServer()
    const platform = usePlatform()
    const abort = new AbortController()

    const eventFetch = (() => {
      if (!platform.fetch || !server.current) return
      try {
        const url = new URL(server.current.http.url)
        const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
        if (url.protocol === "http:" && !loopback) return platform.fetch
      } catch {
        return
      }
    })()

    const currentServer = server.current
    if (!currentServer) throw new Error("No server available")

    const eventSdk = createSdkForServer({
      signal: abort.signal,
      fetch: eventFetch,
      server: currentServer.http,
    })
    type Events = {
      [key: string]: Event
    }
    const raw = createGlobalEmitter<Events>()
    const safe = <T,>(listener: (event: T) => void) => (event: T) => {
      try {
        listener(event)
      } catch (error) {
        console.error("[global-sdk] event listener failed", { error })
      }
    }
    const emitter: GlobalEmitter<Events> = {
      on: (event, listener) => raw.on(event, safe(listener)),
      listen: (listener) => raw.listen(safe(listener)),
      emit: raw.emit,
      clear: raw.clear,
    }

    type Queued = { directory: string; payload: Event; key?: string }
    const FLUSH_FRAME_MS = 16
    const MAX_FLUSH_EVENTS = 500
    const MAX_QUEUE_EVENTS = 10_000
    const STREAM_YIELD_MS = 8
    const RECONNECT_DELAY_MS = 250

    const queue: Queued[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0

    const deltaKey = (directory: string, messageID: string, partID: string) => `${directory}:${messageID}:${partID}`

    const key = (directory: string, payload: Event) => {
      if (payload.type === "session.status") return `session.status:${directory}:${payload.properties.sessionID}`
      if (payload.type === "session.updated") return `session.updated:${directory}:${payload.properties.info.id}`
      if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
      if (payload.type === "message.updated") {
        const info = payload.properties.info
        return `message.updated:${directory}:${info.sessionID}:${info.id}`
      }
      if (payload.type === "message.part.updated") {
        const part = payload.properties.part
        return `message.part.updated:${directory}:${part.messageID}:${part.id}`
      }
      if (payload.type === "message.part.delta") {
        const props = payload.properties
        return `message.part.delta:${deltaKey(directory, props.messageID, props.partID)}:${props.field}`
      }
    }

    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined

      if (queue.length === 0) return

      const events = queue.splice(0, MAX_FLUSH_EVENTS)

      last = Date.now()
      batch(() => {
        for (const event of events) {
          emitter.emit(event.directory, event.payload)
        }
      })

      if (abort.signal.aborted) queue.length = 0
      if (queue.length > 0 && !abort.signal.aborted) schedule()
    }

    const schedule = () => {
      if (timer) return
      const elapsed = Date.now() - last
      timer = setTimeout(flush, Math.max(0, FLUSH_FRAME_MS - elapsed))
    }

    let streamErrorLogged = false
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const aborted = (error: unknown) => abortError.safeParse(error).success

    let attempt: AbortController | undefined
    const HEARTBEAT_TIMEOUT_MS = 15_000
    let lastEventAt = Date.now()
    let heartbeat: ReturnType<typeof setTimeout> | undefined
    const resetHeartbeat = () => {
      lastEventAt = Date.now()
      if (heartbeat) clearTimeout(heartbeat)
      heartbeat = setTimeout(() => {
        attempt?.abort()
      }, HEARTBEAT_TIMEOUT_MS)
    }
    const clearHeartbeat = () => {
      if (!heartbeat) return
      clearTimeout(heartbeat)
      heartbeat = undefined
    }

    void (async () => {
      while (!abort.signal.aborted) {
        attempt = new AbortController()
        lastEventAt = Date.now()
        const onAbort = () => {
          attempt?.abort()
        }
        abort.signal.addEventListener("abort", onAbort)
        try {
          const events = await eventSdk.global.event({
            signal: attempt.signal,
            onSseError: (error) => {
              if (aborted(error)) return
              if (streamErrorLogged) return
              streamErrorLogged = true
              console.error("[global-sdk] event stream error", {
                url: currentServer.http.url,
                fetch: eventFetch ? "platform" : "webview",
                error,
              })
            },
          })
          let yielded = Date.now()
          resetHeartbeat()
          for await (const event of events.stream) {
            resetHeartbeat()
            streamErrorLogged = false
            const directory = event.directory ?? "global"
            const payload = event.payload
            const k = key(directory, payload)
            const current = queue.at(-1)
            if (k && current?.key === k) {
              queue[queue.length - 1] =
                payload.type === "message.part.delta" && current.payload.type === "message.part.delta"
                  ? {
                      directory,
                      key: k,
                      payload: {
                        ...payload,
                        properties: {
                          ...payload.properties,
                          delta: current.payload.properties.delta + payload.properties.delta,
                        },
                      },
                    }
                  : { directory, payload, key: k }
            } else {
              queue.push({ directory, payload, key: k })
            }
            schedule()

            while (queue.length >= MAX_QUEUE_EVENTS && !abort.signal.aborted && !attempt.signal.aborted) {
              resetHeartbeat()
              await wait(FLUSH_FRAME_MS)
            }
            if (attempt.signal.aborted) break
            if (Date.now() - yielded < STREAM_YIELD_MS) continue
            yielded = Date.now()
            await wait(0)
          }
        } catch (error) {
          if (!aborted(error) && !streamErrorLogged) {
            streamErrorLogged = true
            console.error("[global-sdk] event stream failed", {
              url: currentServer.http.url,
              fetch: eventFetch ? "platform" : "webview",
              error,
            })
          }
        } finally {
          abort.signal.removeEventListener("abort", onAbort)
          attempt = undefined
          clearHeartbeat()
        }

        if (abort.signal.aborted) return
        await wait(RECONNECT_DELAY_MS)
      }
    })().finally(flush)

    const onVisibility = () => {
      if (typeof document === "undefined") return
      if (document.visibilityState !== "visible") return
      if (Date.now() - lastEventAt < HEARTBEAT_TIMEOUT_MS) return
      attempt?.abort()
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility)
    }

    onCleanup(() => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility)
      }
      abort.abort()
      flush()
    })

    const sdk = createSdkForServer({
      server: server.current.http,
      fetch: platform.fetch,
      throwOnError: true,
    })

    return {
      url: currentServer.http.url,
      client: sdk,
      event: emitter,
      createClient(opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">) {
        const s = server.current
        if (!s) throw new Error("Server not available")
        return createSdkForServer({
          server: s.http,
          fetch: platform.fetch,
          ...opts,
        })
      },
    }
  },
})
