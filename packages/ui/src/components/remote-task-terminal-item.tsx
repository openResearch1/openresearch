import { createMemo, createSignal, For, Show } from "solid-js"

import type { ToolPart } from "@opencode-ai/sdk/v2"

import { useData } from "../context/data"
import { useI18n } from "../context/i18n"
import { Collapsible } from "./collapsible"

type Payload = {
  taskId?: string
  expId?: string
  kind?: string
  status?: string
  logPath?: string | null
  errorMessage?: string | null
}

function metadata(part: ToolPart) {
  if (!("metadata" in part.state)) return {}
  return part.state.metadata ?? {}
}

function humanize(value: string | undefined) {
  if (!value) return "-"
  return value
    .replaceAll("_", " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ")
}

function tone(status: string | undefined) {
  if (status === "finished") return "success"
  if (status === "failed" || status === "crashed") return "error"
  if (status === "canceled") return "muted"
  return "neutral"
}

export function RemoteTaskTerminalItem(props: { headline: string; body: string; payload?: Record<string, unknown> }) {
  const data = useData()
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const payload = () => (props.payload ?? {}) as Payload
  const title = createMemo(() => {
    const taskId = payload().taskId
    const tool = taskId
      ? Object.values(data.store.part)
          .flat()
          .filter((part): part is ToolPart => part.type === "tool")
          .findLast((part) => metadata(part).taskId === taskId)
      : undefined
    const meta = tool ? metadata(tool) : {}
    const value = meta.title ?? tool?.state.input.title
    if (typeof value === "string" && value) return value

    const status = payload().status
    const prefix = "Remote task "
    const suffix = status ? ` reached ${status}` : ""
    if (props.headline.startsWith(prefix) && suffix && props.headline.endsWith(suffix)) {
      return props.headline.slice(prefix.length, -suffix.length)
    }
    return props.headline
  })
  const status = createMemo(() => {
    const value = payload().status
    if (value === "finished") return i18n.t("ui.remoteTask.status.finished")
    if (value === "failed") return i18n.t("ui.remoteTask.status.failed")
    if (value === "crashed") return i18n.t("ui.remoteTask.status.crashed")
    if (value === "canceled") return i18n.t("ui.remoteTask.status.canceled")
    return humanize(value)
  })
  const fields = createMemo(() => [
    { label: i18n.t("ui.remoteTask.taskId"), value: payload().taskId ?? "-", mono: true },
    { label: i18n.t("ui.remoteTask.experiment"), value: payload().expId ?? "-", mono: true },
    { label: i18n.t("ui.remoteTask.kind"), value: humanize(payload().kind), mono: false },
    { label: i18n.t("ui.remoteTask.status"), value: status(), mono: false },
    { label: i18n.t("ui.remoteTask.log"), value: payload().logPath ?? "-", mono: true },
  ])

  return (
    <div data-component="remote-task-terminal-block">
      <Collapsible open={open()} onOpenChange={setOpen} class="remote-task-terminal-item">
        <Collapsible.Trigger>
          <div data-component="remote-task-terminal-trigger">
            <span data-slot="remote-task-terminal-label">{i18n.t("ui.remoteTask.label")}</span>
            <span data-slot="remote-task-terminal-title" title={title()}>
              {title()}
            </span>
            <span data-slot="remote-task-terminal-status" data-tone={tone(payload().status)}>
              {status()}
            </span>
            <Collapsible.Arrow />
          </div>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div data-component="remote-task-terminal-details">
            <div data-slot="remote-task-terminal-fields">
              <For each={fields()}>
                {(field) => (
                  <div data-slot="remote-task-terminal-field">
                    <span data-slot="remote-task-terminal-field-label">{field.label}</span>
                    <span
                      data-slot="remote-task-terminal-field-value"
                      data-mono={field.mono ? "" : undefined}
                      title={field.value}
                    >
                      {field.value}
                    </span>
                  </div>
                )}
              </For>
            </div>
            <Show when={payload().errorMessage}>
              {(error) => (
                <div data-slot="remote-task-terminal-error">
                  <span data-slot="remote-task-terminal-field-label">{i18n.t("ui.remoteTask.error")}</span>
                  <span>{error()}</span>
                </div>
              )}
            </Show>
            <Show when={!props.payload && props.body.trim()}>
              <pre data-slot="remote-task-terminal-fallback">
                <code>{props.body}</code>
              </pre>
            </Show>
          </div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}
