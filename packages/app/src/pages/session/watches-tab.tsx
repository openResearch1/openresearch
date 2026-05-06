import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { useSDK } from "@/context/sdk"
import { legacyTask, RemoteTaskPanel } from "@/pages/session/remote-task-panel"

export interface RemoteTaskRow {
  task_id: string
  title: string
  kind: "resource_download" | "experiment_run" | "env_setup"
  status: "pending" | "running" | "finished" | "failed" | "crashed" | "canceled"
  resource_key: string | null
  target_path: string | null
  screen_name: string
  log_path: string | null
  error_message: string | null
  source_selection: string | null
  method: string | null
  time_created: number
  time_updated: number
}

export interface WatchRow {
  watch_id: string
  kind: "experiment" | "project_runtime"
  exp_id: string
  exp_session_id: string | null
  exp_result_path: string | null
  title: string
  wandb_entity: string | null
  wandb_project: string | null
  wandb_run_id: string | null
  remote_task_title: string | null
  remote_task_kind: "resource_download" | "experiment_run" | "env_setup" | null
  remote_task_status: "pending" | "running" | "finished" | "failed" | "crashed" | "canceled" | null
  remote_task_target_path: string | null
  remote_task_screen_name: string | null
  remote_task_log_path: string | null
  remote_task_error_message: string | null
  remote_tasks: RemoteTaskRow[]
  status: "pending" | "running" | "finished" | "failed" | "canceled"
  stage:
    | "pending"
    | "planning"
    | "coding"
    | "deploying_code"
    | "setting_up_env"
    | "remote_downloading"
    | "verifying_resources"
    | "running_experiment"
    | "watching_wandb"
  message: string | null
  error_message: string | null
  started_at: number | null
  finished_at: number | null
  time_created: number
  time_updated: number
}

function statusColor(status: string) {
  switch (status) {
    case "finished":
      return "text-icon-success-base"
    case "failed":
    case "crashed":
      return "text-icon-critical-base"
    case "running":
      return "text-icon-warning-base"
    default:
      return "text-text-weak"
  }
}

function stageLabel(stage: WatchRow["stage"]) {
  return stage.replaceAll("_", " ")
}

function formatTime(ts: number | null) {
  if (!ts) return "-"
  return new Date(ts).toLocaleString()
}

function watchNotice(watch: WatchRow) {
  const noun = watch.kind === "project_runtime" ? "Project runtime" : "Experiment"
  if (watch.stage === "watching_wandb") {
    if (watch.status === "finished") return "W&B run finished"
    if (watch.status === "failed") return "W&B run failed"
    return "Watching W&B run"
  }
  if (watch.status === "failed") return `${noun} failed`
  if (watch.status === "finished") return `${noun} finished`
}

export function WatchesTab(props: { onOpenFile?: (filePath: string) => void }) {
  const sdk = useSDK()
  const navigate = useNavigate()
  const dialog = useDialog()
  const [watches, setWatches] = createSignal<WatchRow[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal(false)
  const [syncing, setSyncing] = createSignal<Record<string, boolean>>({})
  const [open, setOpen] = createStore<Record<string, boolean>>({})

  const fetchWatches = async () => {
    try {
      setLoading(true)
      setError(false)
      const res = await sdk.client.research.experimentWatch.list()
      if (res.data) {
        setWatches(res.data as unknown as WatchRow[])
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    fetchWatches()
    const timer = window.setInterval(fetchWatches, 10000)
    onCleanup(() => window.clearInterval(timer))
  })

  const goToSession = async (expId: string) => {
    try {
      const res = await sdk.client.research.experiment.session.create({ expId })
      const sessionId = res.data?.session_id
      if (sessionId) {
        navigate(`/${base64Encode(sdk.directory)}/session/${sessionId}`)
      }
    } catch (err) {
      console.error("[watches-tab] failed to get/create experiment session", err)
    }
  }

  const openFile = (filePath: string) => {
    props.onOpenFile?.(filePath)
  }

  const openLog = async (watch: WatchRow, task?: RemoteTaskRow) => {
    try {
      const encodedDirectory = /[^\x00-\x7F]/.test(sdk.directory) ? encodeURIComponent(sdk.directory) : sdk.directory
      const params = task?.task_id ? `?taskId=${encodeURIComponent(task.task_id)}` : ""
      const res = await fetch(`${sdk.url}/research/experiment-watch/${watch.watch_id}/log${params}`, {
        headers: {
          "x-opencode-directory": encodedDirectory,
        },
      })
      if (!res.ok) throw new Error(await res.text())
      const log = (await res.json()) as { ok: boolean; path: string; content: string }
      if (!log) return
      dialog.show(() => <DialogRemoteLog title={task?.title ?? watch.title} path={log.path} content={log.content} />)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load remote log"
      showToast({ title: "Failed to load remote log", description: message })
    }
  }

  const refreshWatch = async (watchId: string, mode: "wandb" | "remote-task") => {
    try {
      setSyncing((prev) => ({ ...prev, [watchId]: true }))
      const encodedDirectory = /[^\x00-\x7F]/.test(sdk.directory) ? encodeURIComponent(sdk.directory) : sdk.directory
      const suffix = mode === "wandb" ? "refresh-wandb" : "refresh-remote-task"
      const res = await fetch(`${sdk.url}/research/experiment-watch/${watchId}/${suffix}`, {
        method: "POST",
        headers: {
          "x-opencode-directory": encodedDirectory,
        },
      })
      if (!res.ok) throw new Error(await res.text())
      await fetchWatches()
    } catch (err) {
      const message = err instanceof Error ? err.message : `Failed to refresh ${mode}`
      showToast({ title: `Failed to refresh ${mode}`, description: message })
    } finally {
      setSyncing((prev) => ({ ...prev, [watchId]: false }))
    }
  }

  const deleteWatch = async (watchId: string) => {
    try {
      await sdk.client.research.experimentWatch.delete({ watchId })
      await fetchWatches()
    } catch {
      // ignore
    }
  }

  const hasRemoteTask = (watch: WatchRow) =>
    !!watch.remote_tasks?.length ||
    !!watch.remote_task_log_path ||
    !!watch.remote_task_target_path ||
    !!watch.remote_task_screen_name

  const showRemoteTask = (watch: WatchRow) => hasRemoteTask(watch)

  const activeTasks = (watch: WatchRow) =>
    (watch.remote_tasks ?? []).filter((task) => task.status === "pending" || task.status === "running")

  const remoteKey = (watch: WatchRow, task: RemoteTaskRow) =>
    task.task_id || `${watch.watch_id}:${task.kind}:${task.title}`

  const canSyncWandb = (watch: WatchRow) =>
    watch.stage === "watching_wandb" && !!watch.wandb_entity && !!watch.wandb_project && !!watch.wandb_run_id

  return (
    <div class="relative flex-1 min-h-0 overflow-hidden h-full flex flex-col">
      <div class="px-3 pt-3 pb-1 flex items-center justify-between">
        <div class="text-12-semibold text-text-weak uppercase tracking-wider">Experiment Watches</div>
        <button
          class="px-2 py-1 rounded text-11-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors"
          onClick={fetchWatches}
        >
          Refresh
        </button>
      </div>

      <div class="flex-1 min-h-0 overflow-auto px-3 pb-3">
        <Switch>
          <Match when={loading() && watches().length === 0}>
            <div class="flex items-center justify-center py-10 text-12-regular text-text-weak">Loading...</div>
          </Match>
          <Match when={error()}>
            <div class="flex items-center justify-center py-10 text-12-regular text-text-weak">
              Failed to load watches
            </div>
          </Match>
          <Match when={watches().length === 0}>
            <div class="flex items-center justify-center py-10 text-12-regular text-text-weak">
              No experiment watches
            </div>
          </Match>
          <Match when={true}>
            <div class="flex flex-col gap-2">
              <For each={watches()}>
                {(watch) => (
                  <div
                    class={`rounded-md border border-border-weak-base bg-background-base px-3 py-2 text-12-regular text-text-base flex flex-col gap-1 transition-colors ${
                      watch.kind === "experiment" ? "cursor-pointer hover:border-border-base" : ""
                    }`}
                    onClick={() => {
                      if (watch.kind === "experiment") goToSession(watch.exp_id)
                    }}
                  >
                    <div class="flex items-center justify-between">
                      <div class="flex min-w-0 items-center gap-2">
                        <Show when={watch.kind === "project_runtime"}>
                          <span class="shrink-0 rounded bg-background-stronger px-1.5 py-0.5 text-10-regular uppercase tracking-wide text-text-weak">
                            Project Runtime
                          </span>
                        </Show>
                        <div class="font-mono text-11-regular truncate" title={watch.title}>
                          {watch.title}
                        </div>
                      </div>
                      <span class={`text-11-regular font-medium ${statusColor(watch.status)}`}>{watch.status}</span>
                    </div>
                    <div class="flex gap-3 text-11-regular text-text-weak">
                      <span>{stageLabel(watch.stage)}</span>
                      <Show when={watch.wandb_entity && watch.wandb_project}>
                        <span>
                          {watch.wandb_entity}/{watch.wandb_project}
                        </span>
                      </Show>
                    </div>
                    <Show when={watch.message}>
                      <span>{watch.message}</span>
                    </Show>
                    <Show when={watchNotice(watch)}>
                      {(text) => <div class={`text-11-regular mt-1 ${statusColor(watch.status)}`}>{text()}</div>}
                    </Show>
                    <Show when={watch.stage === "watching_wandb" && watch.wandb_run_id}>
                      <div class="flex flex-col gap-1 text-11-regular text-text-weak mt-1">
                        <span>
                          W&B: {watch.wandb_entity}/{watch.wandb_project}
                        </span>
                        <span class="font-mono break-all">Run: {watch.wandb_run_id}</span>
                      </div>
                    </Show>
                    <Show when={watch.kind === "project_runtime" && watch.remote_tasks?.length}>
                      <div class="mt-2 flex flex-col gap-2">
                        <div class="text-11-regular text-text-weak">
                          {activeTasks(watch).length} active / {watch.remote_tasks.length} remote tasks
                        </div>
                        <For each={watch.remote_tasks}>
                          {(task) => {
                            const key = remoteKey(watch, task)
                            return (
                              <RemoteTaskPanel
                                watch={watch}
                                task={task}
                                open={!!open[key]}
                                onOpenChange={(value) => setOpen(key, value)}
                                syncing={!!syncing()[watch.watch_id]}
                                onRefresh={() => refreshWatch(watch.watch_id, "remote-task")}
                                onOpenLog={(task) => openLog(watch, task)}
                              />
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                    <Show when={watch.kind !== "project_runtime" && showRemoteTask(watch) && legacyTask(watch)}>
                      {(task) => (
                        <div class="mt-2">
                          <RemoteTaskPanel
                            watch={watch}
                            task={task()}
                            open={!!open[remoteKey(watch, task())]}
                            onOpenChange={(value) => setOpen(remoteKey(watch, task()), value)}
                            syncing={!!syncing()[watch.watch_id]}
                            onRefresh={() => refreshWatch(watch.watch_id, "remote-task")}
                            onOpenLog={(task) => openLog(watch, task)}
                          />
                        </div>
                      )}
                    </Show>
                    <div class="flex gap-3 text-11-regular text-text-weak">
                      <span>Created: {formatTime(watch.time_created)}</span>
                      <span>Started: {formatTime(watch.started_at)}</span>
                      <span>Updated: {formatTime(watch.time_updated)}</span>
                    </div>
                    <Show when={watch.error_message}>
                      <div class="text-11-regular text-icon-critical-base mt-1">{watch.error_message}</div>
                    </Show>
                    <div class="flex gap-2 mt-1">
                      <Show when={watch.status === "finished" && watch.exp_result_path}>
                        <button
                          class="px-2 py-0.5 rounded text-11-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors"
                          onClick={(e) => {
                            e.stopPropagation()
                            openFile(`${watch.exp_result_path}/${watch.wandb_run_id}/summary.json`)
                          }}
                        >
                          Summary
                        </button>
                        <button
                          class="px-2 py-0.5 rounded text-11-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors"
                          onClick={(e) => {
                            e.stopPropagation()
                            openFile(`${watch.exp_result_path}/${watch.wandb_run_id}/config.json`)
                          }}
                        >
                          Config
                        </button>
                      </Show>
                      <Show
                        when={
                          watch.stage === "watching_wandb" &&
                          watch.wandb_entity &&
                          watch.wandb_project &&
                          watch.wandb_run_id
                        }
                      >
                        <button
                          class="px-2 py-0.5 rounded text-11-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors"
                          onClick={(e) => {
                            e.stopPropagation()
                            window.open(
                              `https://wandb.ai/${watch.wandb_entity}/${watch.wandb_project}/runs/${watch.wandb_run_id}`,
                              "_blank",
                            )
                          }}
                        >
                          W&B
                        </button>
                      </Show>
                      <Show when={canSyncWandb(watch)}>
                        <button
                          class="px-2 py-0.5 rounded text-11-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors disabled:opacity-50"
                          disabled={syncing()[watch.watch_id]}
                          onClick={(e) => {
                            e.stopPropagation()
                            refreshWatch(watch.watch_id, "wandb")
                          }}
                        >
                          {syncing()[watch.watch_id] ? "Syncing..." : "Sync"}
                        </button>
                      </Show>
                      <button
                        class="px-2 py-0.5 rounded text-11-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors"
                        onClick={(e) => {
                          e.stopPropagation()
                          deleteWatch(watch.watch_id)
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  )
}

function DialogRemoteLog(props: { title: string; path: string; content: string }) {
  return (
    <Dialog title={`Remote Log: ${props.title}`} class="w-full max-w-3xl mx-auto">
      <div class="flex flex-col gap-2 min-h-0">
        <div class="text-11-regular text-text-weak font-mono break-all">{props.path}</div>
        <pre class="max-h-[70vh] overflow-auto rounded-md bg-background-stronger p-3 text-11-regular text-text-base whitespace-pre-wrap break-words font-mono">
          {props.content || "(empty log)"}
        </pre>
      </div>
    </Dialog>
  )
}
