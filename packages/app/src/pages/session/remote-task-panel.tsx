import { Show } from "solid-js"
import { Collapsible } from "@opencode-ai/ui/collapsible"

import type { RemoteTaskRow, WatchRow } from "@/pages/session/watches-tab"

function statusColor(status: RemoteTaskRow["status"] | WatchRow["remote_task_status"]) {
  if (status === "failed" || status === "crashed") return "text-icon-critical-base"
  if (status === "finished") return "text-icon-success-base"
  if (status === "pending" || status === "running") return "text-icon-warning-base"
  return "text-text-weak"
}

function notice(task: RemoteTaskRow) {
  const name =
    task.kind === "experiment_run" ? "Experiment task" : task.kind === "env_setup" ? "Environment setup" : "Remote task"
  if (task.status === "failed" || task.status === "crashed") return `${name} failed`
  if (task.status === "finished") {
    if (task.kind === "resource_download") return "Remote task finished"
    if (task.kind === "env_setup") return "Environment setup finished"
    return "Experiment task finished"
  }
  if (task.status === "pending") return `${name} pending`
  if (task.status === "running") return `${name} running`
}

function showTarget(task: RemoteTaskRow) {
  return task.kind !== "experiment_run"
}

export function legacyTask(watch: WatchRow): RemoteTaskRow | undefined {
  if (!watch.remote_task_kind || !watch.remote_task_status) return
  return {
    task_id: "",
    title: watch.remote_task_title ?? "Remote task",
    kind: watch.remote_task_kind,
    status: watch.remote_task_status,
    resource_key: null,
    target_path: watch.remote_task_target_path,
    screen_name: watch.remote_task_screen_name ?? "",
    log_path: watch.remote_task_log_path,
    error_message: watch.remote_task_error_message,
    source_selection: null,
    method: null,
    time_created: watch.time_created,
    time_updated: watch.time_updated,
  }
}

export function RemoteTaskPanel(props: {
  watch: WatchRow
  task: RemoteTaskRow
  open: boolean
  onOpenChange: (open: boolean) => void
  syncing: boolean
  onRefresh: () => void
  onOpenLog: (task: RemoteTaskRow) => void
}) {
  return (
    <div
      class="rounded-md border border-border-weak-base bg-background-stronger px-2.5 py-2 text-11-regular text-text-weak"
      onClick={(e) => e.stopPropagation()}
    >
      <Collapsible open={props.open} onOpenChange={props.onOpenChange}>
        <div class="flex items-center justify-between gap-2">
          <span class="min-w-0 truncate text-text-base" title={props.task.title}>
            {props.task.title}
          </span>
          <span class={statusColor(props.task.status)}>{props.task.status}</span>
        </div>
        <Show when={notice(props.task)}>{(text) => <div class={statusColor(props.task.status)}>{text()}</div>}</Show>
        <Collapsible.Content>
          <div class="mt-1 flex flex-col gap-1">
            <div class="flex flex-wrap gap-x-3 gap-y-1">
              <span>Kind: {props.task.kind}</span>
              <Show when={props.task.resource_key}>{(key) => <span class="font-mono">Resource: {key()}</span>}</Show>
              <Show when={props.task.method}>{(method) => <span>Method: {method()}</span>}</Show>
            </div>
            <Show when={showTarget(props.task) && props.task.target_path}>
              <span class="font-mono break-all">Target: {props.task.target_path}</span>
            </Show>
            <Show when={props.task.screen_name}>
              <span class="font-mono break-all">Screen: {props.task.screen_name}</span>
            </Show>
            <Show when={props.task.log_path}>
              <span class="font-mono break-all">Log: {props.task.log_path}</span>
            </Show>
            <Show when={props.task.error_message && props.task.error_message !== props.watch.error_message}>
              <div class="text-icon-critical-base">{props.task.error_message}</div>
            </Show>
          </div>
        </Collapsible.Content>
        <div class="mt-2 flex gap-2">
          <button
            class="px-2 py-0.5 rounded text-11-regular bg-background-base text-text-base hover:text-text-strong transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              props.onOpenChange(!props.open)
            }}
          >
            {props.open ? "Hide details" : "Details"}
          </button>
          <button
            class="px-2 py-0.5 rounded text-11-regular bg-background-base text-text-base hover:text-text-strong transition-colors disabled:opacity-50"
            disabled={props.syncing}
            onClick={(e) => {
              e.stopPropagation()
              props.onRefresh()
            }}
          >
            {props.syncing ? "Refreshing..." : "Refresh"}
          </button>
          <Show when={props.task.log_path}>
            <button
              class="px-2 py-0.5 rounded text-11-regular bg-background-base text-text-base hover:text-text-strong transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                props.onOpenLog(props.task)
              }}
            >
              Log
            </button>
          </Show>
        </div>
      </Collapsible>
    </div>
  )
}
