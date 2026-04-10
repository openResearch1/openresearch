import { DockTray } from "@opencode-ai/ui/dock-surface"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { TextReveal } from "@opencode-ai/ui/text-reveal"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

type Step = {
  id: string
  title: string
  summary: string
  status: "pending" | "active" | "done" | "waiting_interaction" | "skipped"
}

type Meta = {
  flow_summary?: string
  instance: {
    title: string
    flow_title: string
    status: "running" | "waiting_interaction" | "completed" | "failed" | "cancelled"
    current_index: number
    current_step?: {
      title: string
      summary: string
      result?: Record<string, unknown>
      interaction?: {
        reason?: string
        message?: string
      }
    }
    steps: Step[]
  }
}

function badge(status: Meta["instance"]["status"], text: Record<Meta["instance"]["status"], string>) {
  const tone =
    status === "waiting_interaction"
      ? "var(--warning)"
      : status === "completed"
        ? "var(--success)"
        : status === "failed"
          ? "var(--danger)"
          : status === "cancelled"
            ? "var(--text-weak)"
            : "var(--text-strong)"
  return (
    <span
      class="text-11-medium px-2 py-0.5 rounded-full border shrink-0"
      style={{
        color: tone,
        border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)`,
        background: `color-mix(in srgb, ${tone} 10%, var(--background-base))`,
      }}
    >
      {text[status]}
    </span>
  )
}

function failLabel(workflow: Meta, manual: string, auto: string) {
  return workflow.instance.current_step?.result?.code === "STEP_KIND_LIMIT_EXCEEDED" ? auto : manual
}

function failText(workflow: Meta, fallback: string) {
  return String(
    workflow.instance.current_step?.result?.message ?? workflow.instance.current_step?.result?.code ?? fallback,
  )
}

export function SessionWorkflowDock(props: {
  workflow: Meta
  title: string
  collapseLabel: string
  expandLabel: string
  stepLabel: string
  waitingLabel: string
  runningLabel: string
  completedLabel: string
  failedLabel: string
  failedManualLabel: string
  failedAutoLabel: string
  cancelledLabel: string
}) {
  const [store, setStore] = createStore({
    collapsed: false,
  })

  const toggle = () => setStore("collapsed", (value) => !value)
  const preview = createMemo(() => {
    if (props.workflow.instance.status === "failed") {
      return String(
        props.workflow.instance.current_step?.result?.message ??
          failLabel(props.workflow, props.failedManualLabel, props.failedAutoLabel),
      )
    }
    if (props.workflow.instance.status === "waiting_interaction") {
      return (
        props.workflow.instance.current_step?.interaction?.message ??
        props.workflow.instance.current_step?.summary ??
        ""
      )
    }
    return (
      props.workflow.instance.current_step?.summary ??
      props.workflow.instance.current_step?.title ??
      props.workflow.instance.flow_title
    )
  })
  const collapse = useSpring(
    () => (store.collapsed ? 1 : 0),
    () => ({ visualDuration: 0.3, bounce: 0 }),
  )
  const value = createMemo(() => Math.max(0, Math.min(1, collapse())))
  const hide = createMemo(() => Math.max(0, Math.min(1, value())))
  const off = createMemo(() => hide() > 0.98)
  let bodyRef: HTMLDivElement | undefined
  let stepsRef: HTMLDivElement | undefined
  const stepRefs: Array<HTMLDivElement | undefined> = []
  const [bodyHeight, setBodyHeight] = createSignal(200)

  createEffect(() => {
    const el = bodyRef
    if (!el) return
    const update = () => setBodyHeight(el.scrollHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    const list = stepsRef
    if (!list || store.collapsed) return
    const idx = props.workflow.instance.current_index
    const target = stepRefs[idx]
    if (!target) return
    queueMicrotask(() => {
      const top = target.offsetTop - list.clientHeight / 2 + target.clientHeight / 2
      list.scrollTo({ top: Math.max(0, top), behavior: "smooth" })
    })
  })

  const labels = {
    running: props.runningLabel,
    waiting_interaction: props.waitingLabel,
    completed: props.completedLabel,
    failed: props.failedLabel,
    cancelled: props.cancelledLabel,
  } satisfies Record<Meta["instance"]["status"], string>

  return (
    <DockTray data-component="session-workflow-dock">
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
            {badge(props.workflow.instance.status, labels)}
            <span class="text-13-regular text-text-weak shrink-0 whitespace-nowrap">
              {props.stepLabel}{" "}
              {Math.min(props.workflow.instance.current_index + 1, props.workflow.instance.steps.length)}/
              {props.workflow.instance.steps.length}
            </span>
            <div class="min-w-0 flex-1 overflow-hidden">
              <TextReveal
                class="text-13-regular text-text-base cursor-default"
                text={
                  store.collapsed
                    ? preview()
                    : (props.workflow.instance.current_step?.title ?? props.workflow.instance.flow_title)
                }
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
              style={{ transform: `rotate(${value() * 180}deg)` }}
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              onClick={(event) => {
                event.stopPropagation()
                toggle()
              }}
              aria-label={store.collapsed ? props.expandLabel : props.collapseLabel}
            />
          </div>
        </div>

        <div
          aria-hidden={store.collapsed || off()}
          classList={{
            "pointer-events-none": hide() > 0.1,
          }}
          style={{
            "max-height": `${Math.max(0, bodyHeight() * (1 - hide()))}px`,
            overflow: "hidden",
            opacity: `${Math.max(0, Math.min(1, 1 - hide()))}`,
            filter: `blur(${Math.max(0, Math.min(1, hide())) * 2}px)`,
          }}
        >
          <div ref={bodyRef} class="px-3 pb-3 flex flex-col gap-2">
            <Show when={props.workflow.instance.current_step?.summary}>
              {(summary) => <div class="text-13-regular text-text-base">{summary()}</div>}
            </Show>

            {props.workflow.instance.status === "failed" && props.workflow.instance.current_step?.result ? (
              <div class="rounded-md border border-border-weak bg-background-panel px-3 py-2 flex flex-col gap-1">
                <div class="text-12-medium text-text-weak">
                  {failLabel(props.workflow, props.failedManualLabel, props.failedAutoLabel)}
                </div>
                <div class="text-13-regular text-text-strong">
                  {failText(props.workflow, failLabel(props.workflow, props.failedManualLabel, props.failedAutoLabel))}
                </div>
              </div>
            ) : null}

            <Show
              when={
                props.workflow.instance.status === "waiting_interaction" &&
                props.workflow.instance.current_step?.interaction
              }
            >
              {(interaction) => (
                <div class="rounded-md border border-border-weak bg-background-panel px-3 py-2 flex flex-col gap-1">
                  <Show when={interaction().reason}>
                    {(reason) => <div class="text-12-medium text-text-weak">{reason()}</div>}
                  </Show>
                  <Show when={interaction().message}>
                    {(message) => <div class="text-13-regular text-text-strong">{message()}</div>}
                  </Show>
                </div>
              )}
            </Show>

            <div ref={stepsRef} class="flex flex-col gap-1.5 max-h-48 overflow-y-auto no-scrollbar pr-1 pb-1">
              <For each={props.workflow.instance.steps}>
                {(step, idx) => {
                  const active = () => idx() === props.workflow.instance.current_index
                  const tone =
                    step.status === "done"
                      ? "var(--text-weak)"
                      : step.status === "waiting_interaction"
                        ? "var(--warning)"
                        : active()
                          ? "var(--text-strong)"
                          : "var(--text-base)"
                  return (
                    <div ref={(el) => (stepRefs[idx()] = el)} class="flex items-start gap-2">
                      <div
                        class="mt-1.5 h-2.5 w-2.5 rounded-full shrink-0"
                        style={{
                          background:
                            step.status === "done"
                              ? "var(--text-weak)"
                              : step.status === "waiting_interaction"
                                ? "var(--warning)"
                                : active()
                                  ? "var(--text-strong)"
                                  : "var(--border-strong)",
                          opacity: step.status === "pending" ? 0.55 : 1,
                        }}
                      />
                      <div class="min-w-0 flex-1">
                        <div class="text-13-medium truncate" style={{ color: tone }}>
                          {step.title}
                        </div>
                        <div class="text-12-regular text-text-weak truncate">{step.summary}</div>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </div>
      </div>
    </DockTray>
  )
}
