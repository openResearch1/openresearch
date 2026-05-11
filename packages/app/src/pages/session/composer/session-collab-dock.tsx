import { DockTray } from "@opencode-ai/ui/dock-surface"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { TextReveal } from "@opencode-ai/ui/text-reveal"
import { For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import type { CollabAgent } from "@opencode-ai/sdk/v2/client"
import type { CollabActivity } from "@/pages/session/composer/session-collab-activity"

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
  completed: 4,
  canceled: 5,
  failed: 6,
}

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

export function SessionCollabDock(props: Props) {
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

  const show = createMemo(() => {
    const root = props.activity.rootAgent()
    if (!root) return false
    return props.activity.activeChildren().length > 0
  })

  const mainBadge = createMemo<Badge>(() => {
    const root = props.activity.rootAgent()
    if (root?.status === "blocked_on_children") return "blocked"
    if (props.activity.activeChildren().some((c) => c.status === "waiting_interaction")) return "blocked"
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
            role="button"
            tabIndex={0}
            onClick={toggle}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              toggle()
            }}
          >
            <div class="min-w-0 flex-1 flex items-center gap-2 overflow-hidden">
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
            <div class="ml-auto shrink-0">
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
                <For each={sortedChildren()}>
                  {(c) => (
                    <li
                      class="flex items-center gap-2 px-2 py-1 rounded-md"
                      style={{
                        cursor: props.onOpenAgent ? "pointer" : "default",
                        background:
                          c.status === "running" || c.status === "blocked_on_children" || c.status === "waiting_interaction"
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
              </ul>
            </div>
          </div>
        </div>
      </DockTray>
    </Show>
  )
}
