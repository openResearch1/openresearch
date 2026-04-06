import { createSignal, Show, For, Index, createMemo, createEffect, onCleanup } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { base64Encode } from "@opencode-ai/util/encode"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { Markdown } from "@opencode-ai/ui/markdown"
import { SessionReview } from "@opencode-ai/ui/session-review"
import { Accordion } from "@opencode-ai/ui/accordion"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import type { FileDiff } from "@opencode-ai/sdk/v2"

interface ServerConfig {
  address: string
  port: number
  user: string
  password: string
  resource_root?: string
  wandb_api_key?: string
  wandb_project_name?: string
}

interface ServerRow {
  id: string
  config: ServerConfig
  time_created: number
  time_updated: number
}

interface ExperimentTabProps {
  experiment: {
    exp_id: string
    research_project_id: string
    exp_name: string
    exp_session_id: string | null
    baseline_branch_name: string | null
    exp_branch_name: string | null
    exp_result_path: string | null
    atom_id: string | null
    exp_result_summary_path: string | null
    exp_plan_path: string | null
    remote_server_id: string | null
    remote_server_config: ServerConfig | null
    status: "pending" | "running" | "done" | "idle" | "failed"
    started_at: number | null
    finished_at: number | null
    time_created: number
    time_updated: number
    code_path: string | null
    atom: {
      atom_id: string
      research_project_id: string
      atom_name: string
      atom_type: string
      atom_claim_path: string | null
      atom_evidence_type: string
      atom_evidence_status: string
      atom_evidence_path: string | null
      atom_evidence_assessment_path: string | null
      article_id: string | null
      session_id: string | null
      time_created: number
      time_updated: number
    } | null
    article: {
      article_id: string
      research_project_id: string
      path: string
      title: string | null
      source_url: string | null
      status: "pending" | "parsed" | "failed"
      time_created: number
      time_updated: number
    } | null
  }
}

export function ExpPlanTab(props: ExperimentTabProps) {
  const file = useFile()
  const sdk = useSDK()
  const language = useLanguage()

  const planFilePath = createMemo(() => {
    const exp = props.experiment
    return exp?.exp_plan_path ?? null
  })

  // Load file when path changes
  createEffect(() => {
    const path = planFilePath()
    if (!path) return

    let isMounted = true

    // Only load if mounted
    if (isMounted) {
      file.load(path).catch(console.error)
    }

    onCleanup(() => {
      isMounted = false
    })
  })

  // Listen for file changes and reload content
  createEffect(() => {
    const currentFilePath = planFilePath()
    if (!currentFilePath) return

    let isMounted = true

    const unsub = sdk.event.on("file.watcher.updated" as any, (event: { file: string; event: string }) => {
      // Check if component is still mounted
      if (!isMounted) return

      // Check if the event file matches our current file path
      // The event.file might be absolute while currentFilePath might be relative, or vice versa
      // So we check if one ends with the other
      if (
        (event.file === currentFilePath ||
          event.file.endsWith(currentFilePath) ||
          currentFilePath.endsWith(event.file)) &&
        (event.event === "change" || event.event === "add")
      ) {
        console.log("[exp-plan-tab] File changed, reloading:", currentFilePath)
        file.load(currentFilePath, { force: true }).catch(console.error)
      }
    })

    onCleanup(() => {
      isMounted = false
      unsub()
    })
  })

  // Get reactive file state directly from context
  const fileState = createMemo(() => {
    const path = planFilePath()
    if (!path) return null
    return file.get(path)
  })

  const planContent = createMemo(() => {
    return fileState()?.content?.content ?? null
  })

  const isLoading = createMemo(() => {
    return fileState()?.loading ?? false
  })

  const hasError = createMemo(() => {
    return !!fileState()?.error
  })

  return (
    <div class="h-full flex flex-col overflow-hidden">
      <div class="flex-1 overflow-auto p-4">
        <Show when={isLoading()}>
          <div class="text-14-regular text-text-weak">{language.t("session.experiment.loading")}</div>
        </Show>

        <Show when={hasError()}>
          <div class="text-14-regular text-icon-critical-base">{language.t("session.experiment.loadError")}</div>
        </Show>

        <Show when={!isLoading() && !hasError()}>
          <Show
            when={planContent()}
            fallback={<div class="text-14-regular text-text-weak">{language.t("session.experiment.noPlan")}</div>}
          >
            {(content) => <Markdown text={content()} />}
          </Show>
        </Show>
      </div>
    </div>
  )
}

export interface CommitDiff {
  hash: string
  message: string
  author: string
  date: string
  diffs: FileDiff[]
}

interface ExpHistoryChangeTabProps extends ExperimentTabProps {
  commits: CommitDiff[]
  loading?: boolean
  error?: unknown
  onRefresh?: () => void
}

export function ExpHistoryChangeTab(props: ExpHistoryChangeTabProps) {
  const sdk = useSDK()
  const language = useLanguage()
  const [openCommits, setOpenCommits] = createSignal<string[]>([])

  const readFile = async (filePath: string) => {
    return sdk.client.file
      .read({ path: filePath })
      .then((x) => x.data)
      .catch(() => undefined)
  }

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleString()
    } catch {
      return dateStr
    }
  }

  const totalStats = createMemo(() => {
    const commits = props.commits
    let additions = 0
    let deletions = 0
    const files = new Set<string>()
    for (const c of commits) {
      for (const d of c.diffs) {
        additions += d.additions
        deletions += d.deletions
        files.add(d.file)
      }
    }
    return { additions, deletions, files: files.size, commits: commits.length }
  })

  // Track whether we've ever received data, to avoid DOM teardown on subsequent updates
  const [hasLoaded, setHasLoaded] = createSignal(false)
  createEffect(() => {
    if (props.commits.length > 0) setHasLoaded(true)
  })

  // Preserve scroll position across data refreshes
  let scrollRef: HTMLDivElement | undefined
  let savedScrollTop = 0
  createEffect(() => {
    // Subscribe to commits so this runs on every update
    props.commits
    // After DOM updates, restore scroll position
    if (scrollRef) {
      const el = scrollRef
      queueMicrotask(() => {
        el.scrollTop = savedScrollTop
      })
    }
  })

  const handleScroll = (e: Event) => {
    savedScrollTop = (e.target as HTMLDivElement).scrollTop
  }

  return (
    <div class="h-full flex flex-col overflow-hidden">
      <div ref={scrollRef} onScroll={handleScroll} class="flex-1 overflow-auto">
        {/* Only show loading on initial fetch (never received data yet) */}
        <Show when={props.loading && !hasLoaded()}>
          <div class="p-4 text-14-regular text-text-weak">{language.t("session.experiment.loading")}</div>
        </Show>

        <Show when={props.error && !hasLoaded()}>
          <div class="p-4 text-14-regular text-icon-critical-base">{language.t("session.experiment.loadError")}</div>
        </Show>

        <Show when={hasLoaded() || (!props.loading && !props.error)}>
          <Show
            when={hasLoaded()}
            fallback={
              <div class="p-4 text-14-regular text-text-weak">{language.t("session.experiment.noChanges")}</div>
            }
          >
            {/* Summary bar */}
            <div class="px-4 py-3 border-b border-border-weaker-base flex items-center justify-between">
              <div class="flex items-center gap-4 text-12-regular text-text-weak">
                <span>{totalStats().commits} commits</span>
                <span>{totalStats().files} files</span>
                <span class="text-icon-success-base">+{totalStats().additions}</span>
                <span class="text-icon-critical-base">-{totalStats().deletions}</span>
              </div>
              <Show when={props.onRefresh}>
                <IconButton
                  icon="refresh"
                  variant="ghost"
                  size="small"
                  classList={{ "animate-spin": !!props.loading }}
                  onClick={() => props.onRefresh?.()}
                />
              </Show>
            </div>

            {/* Level 1: Commit accordion */}
            <Accordion multiple value={openCommits()} onChange={setOpenCommits}>
              <Index each={props.commits}>
                {(commit) => (
                  <Accordion.Item value={commit().hash}>
                    <Accordion.Trigger class="w-full px-4 py-3 flex items-center gap-3 hover:bg-background-stronger cursor-pointer border-b border-border-weaker-base">
                      <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                          <span class="text-14-medium truncate">{commit().message}</span>
                        </div>
                        <div class="flex items-center gap-3 mt-0.5 text-12-regular text-text-weak">
                          <span class="font-mono">{commit().hash.slice(0, 7)}</span>
                          <span>{commit().author}</span>
                          <span>{formatDate(commit().date)}</span>
                        </div>
                      </div>
                      <div class="shrink-0 flex items-center gap-2 text-12-regular">
                        <span class="text-text-weak">{commit().diffs.length} files</span>
                        <span class="text-icon-success-base">
                          +{commit().diffs.reduce((s, d) => s + d.additions, 0)}
                        </span>
                        <span class="text-icon-critical-base">
                          -{commit().diffs.reduce((s, d) => s + d.deletions, 0)}
                        </span>
                      </div>
                    </Accordion.Trigger>
                    <Accordion.Content>
                      {/* Level 2: File diffs via SessionReview */}
                      <div class="border-b border-border-weaker-base">
                        <SessionReview
                          diffs={commit().diffs}
                          readFile={readFile}
                          classes={{
                            root: "pr-3",
                            header: "px-3",
                            container: "pl-3",
                          }}
                        />
                      </div>
                    </Accordion.Content>
                  </Accordion.Item>
                )}
              </Index>
            </Accordion>
          </Show>
        </Show>
      </div>
    </div>
  )
}

interface RunInfo {
  name: string
  path: string
  files: string[]
}

async function queryWandbEntity(apiKey: string): Promise<string | null> {
  try {
    const resp = await fetch("https://api.wandb.ai/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: "query { viewer { entity } }" }),
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as any
    return data?.data?.viewer?.entity ?? null
  } catch {
    return null
  }
}

export function ExpResultTab(props: ExperimentTabProps & { onOpenFile?: (filePath: string) => void }) {
  const sdk = useSDK()
  const language = useLanguage()
  const [runs, setRuns] = createSignal<RunInfo[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal(false)
  const [wandbEntity, setWandbEntity] = createSignal<string | null>(null)

  const fetchRuns = async () => {
    try {
      setLoading(true)
      setError(false)
      const res = await sdk.client.research.experiment.runs({ expId: props.experiment.exp_id })
      if (res.data) {
        setRuns(res.data as RunInfo[])
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    fetchRuns()
    const apiKey = props.experiment.remote_server_config?.wandb_api_key
    if (apiKey) {
      queryWandbEntity(apiKey).then(setWandbEntity)
    }
  })

  return (
    <div class="h-full flex flex-col overflow-hidden">
      <div class="px-4 pt-3 pb-1 flex items-center justify-between">
        <div class="text-12-semibold text-text-weak uppercase tracking-wider">Runs</div>
        <button
          class="px-2 py-1 rounded text-11-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors"
          onClick={fetchRuns}
        >
          Refresh
        </button>
      </div>

      <div class="flex-1 min-h-0 overflow-auto px-4 pb-3">
        <Show when={loading() && runs().length === 0}>
          <div class="flex items-center justify-center py-10 text-12-regular text-text-weak">
            {language.t("session.experiment.loading")}
          </div>
        </Show>

        <Show when={error() && runs().length === 0}>
          <div class="flex items-center justify-center py-10 text-12-regular text-icon-critical-base">
            {language.t("session.experiment.loadError")}
          </div>
        </Show>

        <Show when={!loading() && !error() && runs().length === 0}>
          <div class="flex items-center justify-center py-10 text-12-regular text-text-weak">
            {language.t("session.experiment.noResult")}
          </div>
        </Show>

        <Show when={runs().length > 0}>
          <div class="flex flex-col gap-2">
            <For each={runs()}>
              {(run) => (
                <div class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 text-12-regular text-text-base flex flex-col gap-1">
                  <div class="font-mono text-11-regular truncate" title={run.name}>
                    {run.name}
                  </div>
                  <div class="flex flex-wrap gap-2 mt-1">
                    <For each={run.files}>
                      {(file) => (
                        <button
                          class="px-2 py-0.5 rounded text-11-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors"
                          onClick={() => props.onOpenFile?.(`${run.path}/${file}`)}
                        >
                          {file}
                        </button>
                      )}
                    </For>
                    <Show when={wandbEntity() && props.experiment.remote_server_config?.wandb_project_name}>
                      <button
                        class="px-2 py-0.5 rounded text-11-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors"
                        onClick={() =>
                          window.open(
                            `https://wandb.ai/${wandbEntity()}/${props.experiment.remote_server_config!.wandb_project_name}/runs/${run.name}`,
                            "_blank",
                          )
                        }
                      >
                        W&B
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

export function ExpProgressTab(props: ExperimentTabProps & { onUpdated?: () => void; hideStatus?: boolean; hideAtom?: boolean }) {
  const language = useLanguage()
  const sdk = useSDK()
  const navigate = useNavigate()
  const [readyLoading, setReadyLoading] = createSignal(false)
  const [readyError, setReadyError] = createSignal<string | null>(null)
  const [conflicts, setConflicts] = createSignal<{ exp_id: string; exp_session_id: string | null }[]>([])

  // Editable fields
  const [editingServer, setEditingServer] = createSignal(false)
  const [serverList, setServerList] = createSignal<ServerRow[]>([])
  const [selectedServerId, setSelectedServerId] = createSignal<string | null>(props.experiment.remote_server_id ?? null)
  const [saving, setSaving] = createSignal(false)

  // Current server config (mutable after update)
  const [currentServerConfig, setCurrentServerConfig] = createSignal<ServerConfig | null>(
    props.experiment.remote_server_config ?? null,
  )
  const codePath = createMemo(() => props.experiment.code_path)

  const navigateToSession = async (expId: string) => {
    try {
      const res = await sdk.client.research.experiment.session.create({ expId })
      const sessionId = res.data?.session_id
      if (sessionId) {
        navigate(`/${base64Encode(sdk.directory)}/session/${sessionId}`)
      }
    } catch (err) {
      console.error("[experiment-tab] failed to get/create experiment session", err)
    }
  }

  const handleOpenInVSCode = async () => {
    const expId = props.experiment.exp_id
    setReadyLoading(true)
    setReadyError(null)
    setConflicts([])
    try {
      await sdk.client.research.experiment.ready({ expId })
      const cp = codePath()
      if (cp) {
        window.open(`vscode://file/${cp}`, "_blank")
      }
    } catch (err: any) {
      const message = err?.message ?? "Failed to prepare experiment"
      setReadyError(message)
      if (err?.conflicts) {
        setConflicts(err.conflicts)
      }
    } finally {
      setReadyLoading(false)
    }
  }

  const fetchServers = async () => {
    try {
      const res = await sdk.client.research.server.list()
      if (res.data) setServerList(res.data as ServerRow[])
    } catch {
      // ignore
    }
  }

  const handleSaveServer = async () => {
    setSaving(true)
    try {
      await sdk.client.research.experiment.update({
        expId: props.experiment.exp_id,
        remoteServerId: selectedServerId(),
      })
      // Update displayed config
      if (selectedServerId()) {
        const server = serverList().find((s) => s.id === selectedServerId())
        setCurrentServerConfig(server?.config ?? null)
      } else {
        setCurrentServerConfig(null)
      }
      setEditingServer(false)
      props.onUpdated?.()
    } catch (e) {
      console.error("Failed to update server", e)
    } finally {
      setSaving(false)
    }
  }

  const statusColor = (status: string) => {
    switch (status) {
      case "pending":
        return "bg-surface-warning-base"
      case "running":
        return "bg-surface-info-base"
      case "done":
        return "bg-surface-success-base"
      case "failed":
        return "bg-surface-critical-base"
      default:
        return "bg-surface-base"
    }
  }

  const statusText = (status: string) => {
    switch (status) {
      case "pending":
        return language.t("session.experiment.status.pending")
      case "running":
        return language.t("session.experiment.status.running")
      case "done":
        return language.t("session.experiment.status.done")
      case "failed":
        return language.t("session.experiment.status.failed")
      case "idle":
        return language.t("session.experiment.status.idle")
      default:
        return status
    }
  }

  return (
    <div class="h-full flex flex-col overflow-hidden">
      <div class="flex-1 overflow-auto p-4">
        <div class="space-y-4">
          <Show when={!props.hideStatus}>
            <div>
              <div class="text-12-medium text-text-weak mb-1">{language.t("session.experiment.status")}</div>
              <div class="flex items-center gap-2">
                <div class={`w-2 h-2 rounded-full ${statusColor(props.experiment.status)}`} />
                <span class="text-14-regular">{statusText(props.experiment.status)}</span>
              </div>
            </div>
          </Show>

          <Show when={props.experiment.exp_branch_name}>
            <div>
              <div class="text-12-medium text-text-weak mb-1">{language.t("session.experiment.branch")}</div>
              <div class="text-14-regular font-mono">{props.experiment.exp_branch_name}</div>
            </div>
          </Show>

          {/* Baseline branch - read-only */}
          <Show when={props.experiment.baseline_branch_name}>
            <div>
              <div class="text-12-medium text-text-weak mb-1">{language.t("session.experiment.baseline")}</div>
              <div class="text-14-regular font-mono">{props.experiment.baseline_branch_name}</div>
            </div>
          </Show>

          {/* Remote server - editable */}
          <div>
            <div class="text-12-medium text-text-weak mb-1">Remote Server</div>
            <Show
              when={editingServer()}
              fallback={
                <div class="flex items-center gap-2">
                  <Show when={currentServerConfig()} fallback={<div class="text-14-regular text-text-weak">None</div>}>
                    {(cfg) => (
                      <div class="flex flex-col gap-1">
                        <div class="text-14-regular font-mono">
                          {cfg().user}@{cfg().address}:{cfg().port}
                        </div>
                        <Show when={cfg().resource_root}>
                          <div class="text-12-regular text-text-weak font-mono">
                            resource_root: {cfg().resource_root}
                          </div>
                        </Show>
                      </div>
                    )}
                  </Show>
                  <button
                    class="text-11-regular text-text-weak hover:text-text-base transition-colors"
                    onClick={() => {
                      fetchServers()
                      setSelectedServerId(props.experiment.remote_server_id ?? null)
                      setEditingServer(true)
                    }}
                  >
                    Edit
                  </button>
                </div>
              }
            >
              <div class="flex flex-col gap-2">
                <select
                  value={selectedServerId() ?? ""}
                  onChange={(e) => setSelectedServerId(e.currentTarget.value || null)}
                  class="rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-13-regular text-text-base outline-none focus:border-border-base"
                >
                  <option value="">None</option>
                  <For each={serverList()}>
                    {(server) => (
                      <option value={server.id}>
                        {server.config.user}@{server.config.address}:{server.config.port}
                      </option>
                    )}
                  </For>
                </select>
                <div class="flex items-center gap-2">
                  <button
                    disabled={saving()}
                    onClick={handleSaveServer}
                    class="px-2 py-1 rounded text-11-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors disabled:opacity-50"
                  >
                    {saving() ? "Saving..." : "Save"}
                  </button>
                  <button
                    onClick={() => setEditingServer(false)}
                    class="px-2 py-1 rounded text-11-regular text-text-weak hover:text-text-base transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </Show>
          </div>

          <Show when={!props.hideAtom && props.experiment.atom}>
            <div>
              <div class="text-12-medium text-text-weak mb-1">{language.t("session.experiment.atom")}</div>
              <div class="text-14-regular">{props.experiment.atom!.atom_name}</div>
            </div>
          </Show>

          <Show when={codePath()}>
            <div>
              <div class="text-12-medium text-text-weak mb-1">Code Path</div>
              <div class="flex items-center justify-between gap-2">
                <div class="text-14-regular font-mono truncate">{codePath()}</div>
                <button
                  onClick={handleOpenInVSCode}
                  disabled={readyLoading()}
                  class="shrink-0 px-2 py-1 rounded text-12-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors disabled:opacity-50"
                >
                  {readyLoading() ? "Preparing..." : "Open in VSCode"}
                </button>
              </div>
              <Show when={readyError()}>
                <div class="mt-2 rounded border border-border-critical-base/20 bg-surface-critical-base/5 p-2">
                  <div class="text-12-regular text-icon-critical-base">{readyError()}</div>
                  <Show when={conflicts().length > 0}>
                    <div class="mt-2 text-12-regular text-text-weak">
                      Please stop the following experiment(s) first:
                    </div>
                    <div class="mt-1 flex flex-col gap-1">
                      <For each={conflicts()}>
                        {(c) => (
                          <button
                            class="flex items-center gap-2 px-2 py-1 rounded text-left w-full hover:bg-background-stronger transition-colors"
                            onClick={() => navigateToSession(c.exp_id)}
                          >
                            <span class="w-2 h-2 rounded-full shrink-0 bg-surface-info-base" />
                            <span class="text-12-regular text-text-base font-mono">{c.exp_id.slice(0, 8)}</span>
                            <span class="text-11-regular text-text-weak">running</span>
                            <Show when={c.exp_session_id}>
                              <span class="text-11-regular text-icon-info-base ml-auto">Go to session →</span>
                            </Show>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>

          <Show when={props.experiment.started_at}>
            <div>
              <div class="text-12-medium text-text-weak mb-1">{language.t("session.experiment.started")}</div>
              <div class="text-14-regular">{new Date(props.experiment.started_at! * 1000).toLocaleString()}</div>
            </div>
          </Show>

          <Show when={props.experiment.finished_at}>
            <div>
              <div class="text-12-medium text-text-weak mb-1">{language.t("session.experiment.finished")}</div>
              <div class="text-14-regular">{new Date(props.experiment.finished_at! * 1000).toLocaleString()}</div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}
