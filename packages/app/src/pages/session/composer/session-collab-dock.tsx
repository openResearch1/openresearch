import { DockTray } from "@opencode-ai/ui/dock-surface"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { TextReveal } from "@opencode-ai/ui/text-reveal"
import { showToast } from "@opencode-ai/ui/toast"
import { For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import type { CollabAgent } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import type { CollabActivity } from "@/pages/session/composer/session-collab-activity"
import { canStopController } from "@/pages/session/composer/session-collab-control"
import { formatServerError } from "@/utils/server-errors"

type Props = {
  activity: CollabActivity
  title: string
  collapseLabel: string
  expandLabel: string
  runningLabel: string
  blockedLabel: string
  pendingLabel: string
  emptyLabel: string
  onOpenAgent?: (agent: CollabAgent) => void
  /**
   * Max height for the scrollable body (px). The rest of the dock (header)
   * is always visible; the list scrolls internally.
   */
  maxBodyHeight?: number
}

type Badge = "running" | "blocked" | "pending"

const STATUS_ORDER: Record<string, number> = {
  running: 0,
  pending: 1,
  waiting_interaction: 2,
  blocked_on_children: 3,
  idle: 4,
  completed: 5,
  canceled: 6,
  failed: 7,
}

const stops = new Map<string, Promise<unknown>>()

function badge(kind: Badge, labels: { running: string; blocked: string; pending: string }) {
  const tone = kind === "running" ? "var(--text-strong)" : kind === "blocked" ? "var(--warning)" : "var(--text-weak)"
  return (
    <span
      class="text-11-medium px-2 py-0.5 rounded-full border shrink-0"
      style={{
        color: tone,
        border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)`,
        background: `color-mix(in srgb, ${tone} 10%, var(--background-base))`,
      }}
    >
      {labels[kind]}
    </span>
  )
}

function statusDot(status: string) {
  const color =
    status === "running"
      ? "var(--text-strong)"
      : status === "pending"
        ? "var(--text-weak)"
        : status === "blocked_on_children" || status === "waiting_interaction"
          ? "var(--warning)"
          : status === "completed"
            ? "var(--success)"
            : status === "failed"
              ? "var(--danger)"
              : "var(--text-weak)"
  return (
    <span
      class="inline-block shrink-0"
      style={{ width: "8px", height: "8px", "border-radius": "50%", background: color }}
    />
  )
}

function DialogStopController(props: { agentId: string }) {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const [store, setStore] = createStore({ stopping: false })

  const stop = async () => {
    if (store.stopping) return
    setStore("stopping", true)
    const current = stops.get(props.agentId)
    const request = current ?? sdk.client.collab.agent.stop({ agentId: props.agentId, directory: sdk.directory })
    if (!current) stops.set(props.agentId, request)
    await request
      .then(() => dialog.close())
      .catch((err) => {
        showToast({
          variant: "error",
          title: language.t("session.collab.stop.failed"),
          description: formatServerError(err, language.t, language.t("common.requestFailed")),
        })
      })
      .finally(() => {
        if (stops.get(props.agentId) === request) stops.delete(props.agentId)
        setStore("stopping", false)
      })
  }

  return (
    <Dialog title={language.t("session.collab.stop.title")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex flex-col gap-1">
          <span class="text-14-regular text-text-strong">{language.t("session.collab.stop.confirm")}</span>
          <span class="text-12-regular text-text-weak">{language.t("session.collab.stop.description")}</span>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" disabled={store.stopping} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            icon="stop"
            variant="primary"
            size="large"
            class="[&_[data-slot=icon-svg]]:!text-text-on-critical-strong disabled:opacity-50"
            style={{
              background: "var(--surface-critical-strong)",
              "border-color": "var(--border-critical-selected)",
              color: "var(--text-on-critical-strong)",
            }}
            disabled={store.stopping}
            aria-busy={store.stopping}
            onClick={stop}
          >
            {language.t(store.stopping ? "session.collab.stop.stopping" : "session.collab.stop.button")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function SessionCollabDock(props: Props) {
  const dialog = useDialog()
  const language = useLanguage()
  const [store, setStore] = createStore({ collapsed: true })
  const toggle = () => setStore("collapsed", (value) => !value)

  const sortedChildren = createMemo(() => {
    return props.activity
      .children()
      .slice()
      .sort((a, b) => {
        const ao = STATUS_ORDER[a.status] ?? 9
        const bo = STATUS_ORDER[b.status] ?? 9
        if (ao !== bo) return ao - bo
        return a.time_created - b.time_created
      })
  })

  const stoppable = createMemo(() =>
    canStopController(props.activity.rootAgent(), props.activity.controllerRoot()),
  )

  const show = createMemo(() => {
    const root = props.activity.rootAgent()
    if (!root) return false
    return props.activity.activeChildren().length > 0 || stoppable()
  })

  const mainBadge = createMemo<Badge>(() => {
    const root = props.activity.rootAgent()
    if (root?.status === "blocked_on_children" || root?.status === "waiting_interaction") return "blocked"
    if (props.activity.activeChildren().some((c) => c.status === "waiting_interaction")) return "blocked"
    if (root?.status === "running") return "running"
    if (props.activity.activeChildren().some((c) => c.status === "running" || c.status === "blocked_on_children"))
      return "running"
    return "pending"
  })

  const preview = createMemo(() => {
    const ac = props.activity.activeChildren()
    if (ac.length === 0) return ""
    const first = ac[0]
    return `${first.name} · ${first.subagent_type}`
  })

  const countText = createMemo(() => `${props.activity.activeChildren().length}/${props.activity.children().length}`)

  const collapse = useSpring(
    () => (store.collapsed ? 1 : 0),
    () => ({ visualDuration: 0.3, bounce: 0 }),
  )
  const value = createMemo(() => Math.max(0, Math.min(1, collapse())))
  const maxBodyHeight = createMemo(() => props.maxBodyHeight ?? 220)

  return (
    <Show when={show()}>
      <DockTray data-component="session-collab-dock">
        <div>
          <div
            class="pl-3 pr-2 py-2 flex items-center gap-2 overflow-visible"
          >
            <div
              class="min-w-0 flex-1 flex items-center gap-2 overflow-hidden"
              role="button"
              tabIndex={0}
              onClick={toggle}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                toggle()
              }}
            >
              <span class="text-14-regular text-text-strong shrink-0">{props.title}</span>
              {badge(mainBadge(), {
                running: props.runningLabel,
                blocked: props.blockedLabel,
                pending: props.pendingLabel,
              })}
              <span class="text-13-regular text-text-weak shrink-0 whitespace-nowrap">{countText()}</span>
              <div class="min-w-0 flex-1 overflow-hidden">
                <TextReveal
                  class="text-13-regular text-text-base cursor-default"
                  text={preview()}
                  duration={600}
                  travel={20}
                  edge={16}
                  spring="cubic-bezier(0.34, 1, 0.64, 1)"
                  springSoft="cubic-bezier(0.34, 1, 0.64, 1)"
                  growOnly
                  truncate
                />
              </div>
            </div>
            <div class="ml-auto shrink-0 flex items-center gap-1">
              <Show when={stoppable()}>
                <IconButton
                  icon="stop"
                  size="normal"
                  variant="ghost"
                  class="[&_[data-slot=icon-svg]]:!text-[var(--danger)]"
                  aria-label={language.t("session.collab.stop.button")}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    const root = props.activity.rootAgent()
                    if (!root || !stoppable()) return
                    dialog.show(() => <DialogStopController agentId={root.id} />)
                  }}
                />
              </Show>
              <IconButton
                icon="chevron-down"
                size="normal"
                variant="ghost"
                style={{ transform: `rotate(${(1 - value()) * 180}deg)` }}
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  toggle()
                }}
                aria-label={store.collapsed ? props.expandLabel : props.collapseLabel}
              />
            </div>
          </div>
          <div
            class="overflow-hidden"
            style={{
              "max-height": `${maxBodyHeight() * (1 - value())}px`,
              transition: "max-height 300ms cubic-bezier(0.34, 1, 0.64, 1)",
            }}
          >
            <div
              class="px-2 pb-2 overflow-y-auto"
              style={{
                "max-height": `${maxBodyHeight()}px`,
                "overscroll-behavior": "contain",
              }}
            >
              <ul class="flex flex-col gap-1">
                <Show
                  when={sortedChildren().length > 0}
                  fallback={<li class="px-2 py-1 text-13-regular text-text-weak">{props.emptyLabel}</li>}
                >
                  <For each={sortedChildren()}>
                    {(c) => (
                      <li
                        class="flex items-center gap-2 px-2 py-1 rounded-md"
                        style={{
                          cursor: props.onOpenAgent ? "pointer" : "default",
                          background:
                            c.status === "running" ||
                            c.status === "blocked_on_children" ||
                            c.status === "waiting_interaction"
                              ? "color-mix(in srgb, var(--text-strong) 6%, transparent)"
                              : "transparent",
                        }}
                        onClick={() => props.onOpenAgent?.(c)}
                      >
                        {statusDot(c.status)}
                        <span class="text-13-regular text-text-strong truncate min-w-0 flex-1">{c.name}</span>
                        <span class="text-12-regular text-text-weak shrink-0">{c.subagent_type}</span>
                        <span class="text-11-regular text-text-weak shrink-0">{c.status}</span>
                        <Show when={c.active_children > 0}>
                          <span class="text-11-regular text-text-weak shrink-0">+{c.active_children}</span>
                        </Show>
                      </li>
                    )}
                  </For>
                </Show>
              </ul>
            </div>
          </div>
        </div>
      </DockTray>
    </Show>
  )
}
