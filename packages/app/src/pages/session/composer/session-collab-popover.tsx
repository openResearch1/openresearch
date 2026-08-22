import type { CollabAgent } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { showToast } from "@opencode-ai/ui/toast"
import { For, Show, createEffect, createMemo, on } from "solid-js"
import { createStore } from "solid-js/store"

import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import type { CollabActivity } from "@/pages/session/composer/session-collab-activity"
import { canStopController } from "@/pages/session/composer/session-collab-control"
import { historical, listed } from "@/pages/session/composer/session-collab-visibility"
import { formatServerError } from "@/utils/server-errors"

type Props = {
  activity: CollabActivity
  title: string
  openLabel: string
  runningLabel: string
  blockedLabel: string
  pendingLabel: string
  emptyLabel: string
  emptyActiveLabel: string
  showCompletedLabel: string
  hideCompletedLabel: string
  onOpenAgent?: (agent: CollabAgent) => void
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

export function SessionCollabPopover(props: Props) {
  const dialog = useDialog()
  const language = useLanguage()
  const [store, setStore] = createStore({ open: false, history: false })

  createEffect(
    on(
      () => props.activity.rootAgent()?.id,
      () => setStore({ open: false, history: false }),
    ),
  )

  const past = createMemo(() => props.activity.children().filter(historical))
  const shown = createMemo(() => props.activity.children().filter((agent) => listed(agent, store.history)))
  const sorted = createMemo(() =>
    shown()
      .slice()
      .sort((a, b) => {
        const ao = STATUS_ORDER[a.status] ?? 9
        const bo = STATUS_ORDER[b.status] ?? 9
        if (ao !== bo) return ao - bo
        return a.time_created - b.time_created
      }),
  )
  const stoppable = createMemo(() => canStopController(props.activity.rootAgent(), props.activity.controllerRoot()))
  const available = createMemo(() => {
    if (!props.activity.rootAgent()) return false
    return props.activity.children().length > 0 || stoppable()
  })
  createEffect(() => {
    if (available()) return
    setStore({ open: false, history: false })
  })
  const mainBadge = createMemo<Badge>(() => {
    const root = props.activity.rootAgent()
    if (root?.status === "blocked_on_children" || root?.status === "waiting_interaction") return "blocked"
    if (props.activity.activeChildren().some((agent) => agent.status === "waiting_interaction")) return "blocked"
    if (root?.status === "running") return "running"
    if (props.activity.activeChildren().some((agent) => agent.status === "running" || agent.status === "blocked_on_children")) {
      return "running"
    }
    return "pending"
  })
  const count = createMemo(() => props.activity.activeChildren().length)
  const countText = createMemo(() => `${count()}/${props.activity.children().length}`)
  const openLabel = createMemo(() =>
    count() > 0 ? language.t("session.collab.openActive", { count: count() }) : props.openLabel,
  )
  const tooltip = createMemo(() =>
    count() > 0 ? language.t("session.collab.tooltipActive", { count: count() }) : props.title,
  )

  const open = (value: boolean) => {
    if (value) setStore("history", false)
    setStore("open", value)
  }

  return (
    <Show when={available()}>
      <Tooltip value={tooltip()} placement="top" gutter={8} openDelay={300}>
        <Popover
          open={store.open}
          onOpenChange={open}
          placement="top-end"
          gutter={8}
          title={
            <div class="min-w-0 flex items-center gap-2">
              <span class="text-14-medium text-text-strong">{props.title}</span>
              {badge(mainBadge(), {
                running: props.runningLabel,
                blocked: props.blockedLabel,
                pending: props.pendingLabel,
              })}
              <span class="text-12-regular text-text-weak whitespace-nowrap">{countText()}</span>
            </div>
          }
          class="w-[420px] max-w-[calc(100vw-24px)] max-h-[calc(100dvh-24px)] overflow-hidden [&_[data-slot=popover-body]]:p-0 [&_[data-slot=popover-body]]:min-h-0 [&_[data-slot=popover-body]]:overflow-hidden"
          triggerAs={Button}
          triggerProps={{
            variant: "ghost",
            size: "normal",
            class: "h-7 min-w-7 px-1.5 gap-1 rounded-md data-[expanded]:bg-surface-base-active",
            "aria-label": openLabel(),
            "data-action": "session-collab-trigger",
          }}
          trigger={
            <Icon
              name="branch"
              size="small"
              style={{
                color:
                  mainBadge() === "blocked"
                    ? "var(--warning)"
                    : mainBadge() === "running"
                      ? "var(--text-strong)"
                      : "var(--text-weak)",
              }}
            />
          }
        >
          <div data-component="session-collab-popover" class="min-w-0">
          <Show when={past().length > 0 || stoppable()}>
            <div class="flex items-center justify-end gap-1 px-2 pt-2">
              <Show when={past().length > 0}>
                <Button
                  variant="ghost"
                  size="small"
                  class="px-2 whitespace-nowrap"
                  onClick={() => setStore("history", (value) => !value)}
                >
                  {store.history ? props.hideCompletedLabel : `${props.showCompletedLabel} (${past().length})`}
                </Button>
              </Show>
              <Show when={stoppable()}>
                <IconButton
                  icon="stop"
                  size="normal"
                  variant="ghost"
                  class="[&_[data-slot=icon-svg]]:!text-[var(--danger)]"
                  aria-label={language.t("session.collab.stop.button")}
                  onClick={() => {
                    const root = props.activity.rootAgent()
                    if (!root || !stoppable()) return
                    dialog.show(() => <DialogStopController agentId={root.id} />)
                  }}
                />
              </Show>
            </div>
          </Show>
          <div
            class="px-2 pb-2 overflow-y-auto"
            style={{
              "max-height": `min(${props.maxBodyHeight ?? 320}px, calc(100dvh - 160px))`,
              "overscroll-behavior": "contain",
            }}
          >
            <ul class="flex flex-col gap-1">
              <Show
                when={sorted().length > 0}
                fallback={
                  <li class="px-2 py-1 text-13-regular text-text-weak">
                    {store.history ? props.emptyLabel : props.emptyActiveLabel}
                  </li>
                }
              >
                <For each={sorted()}>
                  {(agent) => (
                    <li>
                      <button
                        type="button"
                        class="w-full flex items-center gap-2 px-2 py-1 rounded-md text-left hover:bg-surface-base-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-focus"
                        style={{
                          background:
                            agent.status === "running" ||
                            agent.status === "blocked_on_children" ||
                            agent.status === "waiting_interaction"
                              ? "color-mix(in srgb, var(--text-strong) 6%, transparent)"
                              : undefined,
                        }}
                        onClick={() => {
                          setStore("open", false)
                          props.onOpenAgent?.(agent)
                        }}
                      >
                        {statusDot(agent.status)}
                        <span class="text-13-regular text-text-strong truncate min-w-0 flex-1">{agent.name}</span>
                        <span class="text-12-regular text-text-weak shrink-0">{agent.subagent_type}</span>
                        <span class="text-11-regular text-text-weak shrink-0">{agent.status}</span>
                        <Show when={agent.active_children > 0}>
                          <span class="text-11-regular text-text-weak shrink-0">+{agent.active_children}</span>
                        </Show>
                      </button>
                    </li>
                  )}
                </For>
              </Show>
            </ul>
          </div>
          </div>
        </Popover>
      </Tooltip>
    </Show>
  )
}
