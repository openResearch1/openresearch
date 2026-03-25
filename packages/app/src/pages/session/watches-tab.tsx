import { createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { useSDK } from "@/context/sdk"

interface WatchRow {
  watch_id: string
  exp_id: string
  exp_session_id: string | null
  exp_result_path: string | null
  wandb_entity: string
  wandb_project: string
  wandb_run_id: string
  status: string
  wandb_state: string | null
  last_polled_at: number | null
  error_message: string | null
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

function formatTime(ts: number | null) {
  if (!ts) return "-"
  return new Date(ts).toLocaleString()
}

export function WatchesTab(props: { onOpenFile?: (filePath: string) => void }) {
  const sdk = useSDK()
  const navigate = useNavigate()
  const [watches, setWatches] = createSignal<WatchRow[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal(false)

  const fetchWatches = async () => {
    try {
      setLoading(true)
      setError(false)
      const res = await sdk.client.research.experimentWatch.list()
      if (res.data) {
        setWatches(res.data as WatchRow[])
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    fetchWatches()
  })

  const goToSession = (sessionId: string) => {
    navigate(`/${base64Encode(sdk.directory)}/session/${sessionId}`)
  }

  const openFile = (filePath: string) => {
    props.onOpenFile?.(filePath)
  }

  const deleteWatch = async (watchId: string) => {
    try {
      await sdk.client.research.experimentWatch.delete({ watchId })
      await fetchWatches()
    } catch {
      // ignore
    }
  }

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
                    class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 text-12-regular text-text-base flex flex-col gap-1 cursor-pointer hover:border-border-base transition-colors"
                    onClick={() => watch.exp_session_id && goToSession(watch.exp_session_id)}
                  >
                    <div class="flex items-center justify-between">
                      <div class="font-mono text-11-regular truncate" title={watch.wandb_run_id}>
                        {watch.wandb_run_id}
                      </div>
                      <span class={`text-11-regular font-medium ${statusColor(watch.status)}`}>{watch.status}</span>
                    </div>
                    <div class="flex gap-3 text-11-regular text-text-weak">
                      <span>
                        {watch.wandb_entity}/{watch.wandb_project}
                      </span>
                    </div>
                    <div class="flex gap-3 text-11-regular text-text-weak">
                      <span>Created: {formatTime(watch.time_created)}</span>
                      <span>Polled: {formatTime(watch.last_polled_at)}</span>
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
                      <button
                        class="px-2 py-0.5 rounded text-11-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors"
                        onClick={(e) => {
                          e.stopPropagation()
                          window.open(`https://wandb.ai/${watch.wandb_entity}/${watch.wandb_project}/runs/${watch.wandb_run_id}`, "_blank")
                        }}
                      >
                        W&B
                      </button>
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
