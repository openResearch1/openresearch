import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { base64Encode } from "@opencode-ai/util/encode"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { Icon } from "@opencode-ai/ui/icon"
import { DataProvider } from "@opencode-ai/ui/context"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useSettings } from "@/context/settings"
import { SessionIDProvider } from "@/context/session-id"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { SessionComposerRegion } from "@/pages/session/composer/session-composer-region"
import { createSessionComposerState } from "@/pages/session/composer/session-composer-state"
import { createSessionHistoryWindow } from "@/pages/session/history-window"
import { createTimelineStaging } from "@/pages/session/timeline-staging"

const CHAT_MIN_WIDTH = 360
const CHAT_MAX_WIDTH = 900
const CHAT_DEFAULT_WIDTH = 520

export function AtomChatPanel(props: { atomSessionId: string; onClose: () => void; title?: string }) {
  const sdk = useSDK()
  const sync = useSync()
  const [panelWidth, setPanelWidth] = createSignal(CHAT_DEFAULT_WIDTH)
  const [dragging, setDragging] = createSignal(false)

  // Sync session data so messages are loaded
  createEffect(
    on(
      () => props.atomSessionId,
      (id) => void sync.session.sync(id),
    ),
  )

  // Session stack for navigating into child agent sessions
  const [sessionStack, setSessionStack] = createSignal<string[]>([])
  const currentSessionID = createMemo(() => {
    const stack = sessionStack()
    return stack.length > 0 ? stack[stack.length - 1] : props.atomSessionId
  })
  const canGoBack = createMemo(() => sessionStack().length > 0)

  const navigateToChildSession = (sessionID: string): true => {
    setSessionStack((prev) => [...prev, sessionID])
    void sync.session.sync(sessionID)
    return true
  }

  const goBack = () => {
    setSessionStack((prev) => prev.slice(0, -1))
  }

  // Reset stack when root atom session changes
  createEffect(() => {
    props.atomSessionId
    setSessionStack([])
  })

  const handleResizeStart = (e: MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = panelWidth()
    setDragging(true)

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX
      const newWidth = Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_WIDTH, startWidth + delta))
      setPanelWidth(newWidth)
    }

    const onMouseUp = () => {
      setDragging(false)
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
    }

    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }

  const sessionHref = (sessionID: string) => `/${base64Encode(sdk.directory)}/session/${sessionID}`

  return (
    <div
      class="bg-background-base border-r border-border-base flex flex-col overflow-hidden relative"
      style={{
        width: `${panelWidth()}px`,
        height: "100%",
        "flex-shrink": "0",
        "user-select": dragging() ? "none" : "auto",
      }}
    >
      {/* Resize handle on right edge */}
      <div
        onMouseDown={handleResizeStart}
        class="absolute right-0 top-0 w-[5px] h-full z-10 cursor-col-resize"
        classList={{
          "bg-accent-base": dragging(),
        }}
        style={{
          background: dragging() ? undefined : "transparent",
          transition: dragging() ? "none" : "background 0.15s",
        }}
        onMouseEnter={(e) => {
          if (!dragging()) e.currentTarget.style.background = "var(--border-base)"
        }}
        onMouseLeave={(e) => {
          if (!dragging()) e.currentTarget.style.background = "transparent"
        }}
      />

      {/* Header */}
      <div class="flex items-center justify-between px-4 py-2.5 border-b border-border-base shrink-0">
        <span class="text-sm font-semibold text-text-base">{props.title ?? "Atom Chat"}</span>
        <button
          onClick={props.onClose}
          class="flex items-center justify-center w-6 h-6 border border-border-base rounded-md bg-transparent text-text-weak cursor-pointer hover:text-text-base hover:bg-background-stronger transition-colors"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Chat content wrapped in providers */}
      <SessionIDProvider sessionID={currentSessionID()} directory={sdk.directory}>
        <DataProvider
          data={sync.data}
          directory={sdk.directory}
          onNavigateToSession={navigateToChildSession}
          onSessionHref={sessionHref}
        >
          <AtomChatInner sessionID={currentSessionID()} canGoBack={canGoBack()} onGoBack={goBack} />
        </DataProvider>
      </SessionIDProvider>
    </div>
  )
}

function AtomChatInner(props: { sessionID: string; canGoBack: boolean; onGoBack: () => void }) {
  const settings = useSettings()
  const sync = useSync()
  const composer = createSessionComposerState()
  let scroller: HTMLDivElement | undefined

  const emptyMessages: Message[] = []
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? emptyMessages)
  const userMessages = createMemo(() => messages().filter((m): m is UserMessage => m.role === "user"))
  const sessionStatus = createMemo(() => sync.data.session_status[props.sessionID]?.type ?? "idle")
  const working = createMemo(() => sessionStatus() === "busy")

  // Find the last incomplete assistant message (still streaming/thinking)
  const pending = createMemo(() =>
    messages().findLast(
      (item): item is AssistantMessage => item.role === "assistant" && typeof item.time.completed !== "number",
    ),
  )

  // Determine which user message is "active" (its assistant reply is being generated)
  const activeMessageID = createMemo(() => {
    const allMessages = messages()
    const message = pending()
    if (message?.parentID) {
      const parent = allMessages.find((item) => item.id === message.parentID)
      if (parent?.role === "user") return parent.id
    }
    if (sessionStatus() === "idle") return undefined
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i].role === "user") return allMessages[i].id
    }
    return undefined
  })

  const autoScroll = createAutoScroll({
    working,
    overflowAnchor: "dynamic",
  })

  // History windowing
  const historyMore = createMemo(() => sync.session.history.more(props.sessionID))
  const historyLoading = createMemo(() => sync.session.history.loading(props.sessionID))

  const historyWindow = createSessionHistoryWindow({
    sessionID: () => props.sessionID,
    messagesReady: () => messages().length > 0,
    visibleUserMessages: userMessages,
    historyMore,
    historyLoading,
    loadMore: (id) => sync.session.history.loadMore(id),
    userScrolled: autoScroll.userScrolled,
    scroller: () => scroller,
  })

  // Progressive staging
  const staging = createTimelineStaging({
    sessionKey: () => props.sessionID,
    turnStart: () => historyWindow.turnStart(),
    messages: () => historyWindow.renderedUserMessages(),
    config: { init: 1, batch: 3 },
  })

  const rendered = createMemo(() => staging.messages().map((msg) => msg.id))

  // Scroll state tracking for scroll-to-bottom button
  const [scrollState, setScrollState] = createSignal({ overflow: false, bottom: true })
  let scrollStateRaf: number | undefined

  const scheduleScrollState = (el: HTMLDivElement) => {
    if (scrollStateRaf !== undefined) cancelAnimationFrame(scrollStateRaf)
    scrollStateRaf = requestAnimationFrame(() => {
      scrollStateRaf = undefined
      const max = el.scrollHeight - el.clientHeight
      const overflow = max > 1
      // column-reverse: scrollTop=0 is bottom, negative is scrolled up
      const bottom = !overflow || Math.abs(el.scrollTop) <= 2 || !autoScroll.userScrolled()
      setScrollState({ overflow, bottom })
    })
  }

  // Snap to bottom when switching sessions
  createEffect(
    on(
      () => props.sessionID,
      () => autoScroll.snapToBottom(),
      { defer: true },
    ),
  )

  const handleScroll = () => {
    autoScroll.handleScroll()
    historyWindow.onScrollerScroll()
    if (scroller) scheduleScrollState(scroller)
  }

  return (
    <div class="flex flex-col flex-1 min-h-0 bg-background-stronger">
      {/* Back button for child sessions */}
      <Show when={props.canGoBack}>
        <div class="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border-base">
          <button
            onClick={props.onGoBack}
            class="flex items-center gap-1.5 text-xs text-text-weak hover:text-text-base transition-colors cursor-pointer bg-transparent border-none p-0"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M19 12H5" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            Back to parent session
          </button>
        </div>
      </Show>

      {/* Messages area */}
      <div class="relative flex-1 min-h-0">
        {/* Scroll-to-bottom button */}
        <div
          class="absolute left-1/2 -translate-x-1/2 bottom-4 z-[60] pointer-events-none transition-all duration-200 ease-out"
          classList={{
            "opacity-100 translate-y-0 scale-100":
              scrollState().overflow && !scrollState().bottom && !staging.isStaging(),
            "opacity-0 translate-y-2 scale-95 pointer-events-none":
              !scrollState().overflow || scrollState().bottom || staging.isStaging(),
          }}
        >
          <button
            class="pointer-events-auto size-8 flex items-center justify-center rounded-full bg-background-base border border-border-base shadow-sm text-text-base hover:bg-background-stronger transition-colors"
            onClick={() => autoScroll.smoothScrollToBottom()}
          >
            <Icon name="arrow-down-to-line" />
          </button>
        </div>

        <div
          ref={(el) => {
            scroller = el
            autoScroll.scrollRef(el)
          }}
          onScroll={handleScroll}
          onMouseDown={autoScroll.handleInteraction}
          class="h-full overflow-y-auto"
          style={{ display: "flex", "flex-direction": "column-reverse" }}
        >
          <div
            ref={(el) => autoScroll.contentRef(el)}
            class="flex flex-col gap-0 items-start justify-start pb-16 pt-4 w-full"
          >
            {/* Load earlier button */}
            <Show when={historyWindow.turnStart() > 0 || historyMore()}>
              <div class="w-full flex justify-center py-2">
                <button
                  onClick={() => void historyWindow.loadAndReveal()}
                  disabled={historyLoading()}
                  class="text-xs text-text-weak hover:text-text-base transition-colors cursor-pointer bg-transparent border-none p-0 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {historyLoading() ? "Loading earlier messages..." : "Load earlier messages"}
                </button>
              </div>
            </Show>

            <Show
              when={userMessages().length > 0}
              fallback={
                <div class="px-5 py-4 text-text-weak text-xs text-center w-full">
                  No messages yet. Start a conversation below.
                </div>
              }
            >
              <For each={rendered()}>
                {(messageID) => {
                  const isNew = staging.ready()
                  const active = createMemo(() => activeMessageID() === messageID)
                  const queued = createMemo(() => {
                    if (active()) return false
                    const activeID = activeMessageID()
                    if (activeID) return messageID > activeID
                    return false
                  })
                  return (
                    <div class="min-w-0 w-full max-w-full">
                      <SessionTurn
                        sessionID={props.sessionID}
                        messageID={messageID}
                        active={active()}
                        queued={queued()}
                        animate={isNew || active()}
                        showReasoningSummaries={settings.general.showReasoningSummaries()}
                        shellToolDefaultOpen={settings.general.shellToolPartsExpanded()}
                        editToolDefaultOpen={settings.general.editToolPartsExpanded()}
                        classes={{
                          root: "min-w-0 w-full relative",
                          content: "flex flex-col justify-between !overflow-visible",
                          container: "w-full px-4 md:px-5",
                        }}
                      />
                    </div>
                  )
                }}
              </For>
            </Show>
          </div>
        </div>
      </div>

      {/* Composer with permission/question docks */}
      <div class="shrink-0">
        <SessionComposerRegion
          state={composer}
          ready={true}
          centered={false}
          inputRef={() => {}}
          newSessionWorktree="main"
          onNewSessionWorktreeReset={() => {}}
          onSubmit={() => autoScroll.smoothScrollToBottom()}
          onResponseSubmit={() => autoScroll.smoothScrollToBottom()}
          setPromptDockRef={() => {}}
        />
      </div>
    </div>
  )
}
