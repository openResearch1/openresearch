import { Show, For, createMemo, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useFile } from "@/context/file"
import { useSDK } from "@/context/sdk"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { base64Encode } from "@opencode-ai/util/encode"
import { Markdown } from "@opencode-ai/ui/markdown"
import type { ResearchSessionAtomGetResponse } from "@opencode-ai/sdk/v2"

type Atom = NonNullable<ResearchSessionAtomGetResponse["atom"]>

export function AtomSessionTab(props: {
  atom: Atom
  activeTab: "content" | "evidence" | "plan" | "assessment"
  onRefresh?: () => void
}) {
  const file = useFile()
  const navigate = useNavigate()
  const params = useParams()
  const sdk = useSDK()

  const returnSessionId = createMemo(() => {
    return sessionStorage.getItem(`atom-session-return-${params.id}`)
  })

  const dialog = useDialog()
  const [creating, setCreating] = createSignal(false)

  const handleReturn = () => {
    const sessionId = returnSessionId()
    if (sessionId) {
      navigate(`/${base64Encode(sdk.directory)}/session/${sessionId}`)
    }
  }

  const navigateToExpSession = (expSessionId: string) => {
    navigate(`/${base64Encode(sdk.directory)}/session/${expSessionId}`)
  }

  const doCreateExperiment = async (baselineBranch: string, codePath: string) => {
    if (creating()) return
    setCreating(true)
    try {
      const res = await sdk.client.research.experiment.create({
        atomId: props.atom.atom_id,
        baselineBranch,
        codePath,
      })
      const sessionId = res.data?.session_id
      if (sessionId) {
        dialog.close()
        navigateToExpSession(sessionId)
      }
    } catch (err) {
      console.error("[atom-session-tab] failed to create experiment", err)
    } finally {
      setCreating(false)
    }
  }

  const handleCreateExperiment = () => {
    dialog.show(() => (
      <DialogCreateExperiment
        creating={creating()}
        onSubmit={(baselineBranch, codePath) => doCreateExperiment(baselineBranch, codePath)}
      />
    ))
  }

  const [updatingStatus, setUpdatingStatus] = createSignal(false)

  const handleUpdateEvidenceStatus = async (status: "in_progress" | "proven" | "disproven") => {
    if (updatingStatus()) return
    setUpdatingStatus(true)
    try {
      await sdk.client.research.atom.update({
        researchProjectId: props.atom.research_project_id,
        atomId: props.atom.atom_id,
        evidence_status: status,
      })
      props.onRefresh?.()
    } catch (err) {
      console.error("[atom-session-tab] failed to update evidence status", err)
    } finally {
      setUpdatingStatus(false)
    }
  }

  const [deleting, setDeleting] = createSignal<string | null>(null)

  const handleDeleteExperiment = async (expId: string) => {
    if (deleting()) return
    setDeleting(expId)
    try {
      await sdk.client.research.experiment.delete({ expId })
      props.onRefresh?.()
    } catch (err) {
      console.error("[atom-session-tab] failed to delete experiment", err)
    } finally {
      setDeleting(null)
    }
  }

  const statusColor = (status: string) => {
    switch (status) {
      case "running":
        return "bg-surface-info-base"
      case "done":
        return "bg-surface-success-base"
      case "failed":
        return "bg-surface-critical-base"
      case "idle":
        return "bg-surface-warning-base"
      default:
        return "bg-surface-base"
    }
  }

  const filePath = createMemo(() => {
    switch (props.activeTab) {
      case "content":
        return props.atom.atom_claim_path
      case "evidence":
        return props.atom.atom_evidence_path
      case "assessment":
        return props.atom.atom_evidence_assessment_path
      case "plan":
        return null
      default:
        return null
    }
  })

  // Load file when path changes
  createEffect(() => {
    const path = filePath()
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
    const currentFilePath = filePath()
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
        console.log("[atom-session-tab] File changed, reloading:", currentFilePath)
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
    const path = filePath()
    if (!path) return null
    return file.get(path)
  })

  const fileContent = createMemo(() => {
    return fileState()?.content?.content ?? null
  })

  const isLoading = createMemo(() => {
    return fileState()?.loading ?? false
  })

  const hasError = createMemo(() => {
    return !!fileState()?.error
  })

  const tabTitle = () => {
    switch (props.activeTab) {
      case "content":
        return "Content"
      case "evidence":
        return "Evidence"
      case "assessment":
        return "Assessment"
      case "plan":
        return "Plan"
      default:
        return ""
    }
  }

  return (
    <div class="relative flex-1 min-h-0 overflow-hidden h-full flex flex-col">
      <div class="px-3 pt-3 pb-1">
        <div class="flex items-center justify-between">
          <div class="text-12-semibold text-text-weak uppercase tracking-wider">
            {props.atom.atom_name}
            <span class="ml-1.5 text-11-regular normal-case tracking-normal text-text-weak">
              ({props.atom.atom_type})
            </span>
          </div>
          <Show when={returnSessionId()}>
            <button
              onClick={handleReturn}
              class="text-11-regular text-text-weak hover:text-text-base transition-colors"
            >
              ← Return
            </button>
          </Show>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-auto px-3 py-2">
        {/* Atom status - only on content tab */}
        <Show when={props.activeTab === "content"}>
          <div class="rounded-md border border-border-weak-base bg-background-base p-3 mb-2">
            <div class="text-12-semibold text-text-strong mb-2">Status</div>
            <div class="flex flex-wrap gap-x-4 gap-y-1 text-12-regular">
              <div class="flex items-center gap-1.5">
                <span class="text-text-weak">Type:</span>
                <span class="text-text-base">{props.atom.atom_type}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="text-text-weak">Evidence Type:</span>
                <span class="text-text-base">{props.atom.atom_evidence_type}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="text-text-weak">Evidence Status:</span>
                <span
                  class={`font-medium ${
                    props.atom.atom_evidence_status === "proven"
                      ? "text-icon-success-base"
                      : props.atom.atom_evidence_status === "disproven"
                        ? "text-icon-critical-base"
                        : props.atom.atom_evidence_status === "in_progress"
                          ? "text-icon-warning-base"
                          : "text-text-weak"
                  }`}
                >
                  {props.atom.atom_evidence_status}
                </span>
              </div>
            </div>
          </div>
        </Show>

        {/* Experiments section - only on plan/experiment tab */}
        <Show when={props.activeTab === "plan"}>
          <div class="rounded-md border border-border-weak-base bg-background-base p-3 mb-2">
            <div class="flex items-center justify-between mb-2">
              <div class="text-12-semibold text-text-strong">Experiments</div>
              <button
                onClick={handleCreateExperiment}
                disabled={creating()}
                class="px-2 py-1 rounded text-11-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors disabled:opacity-50"
              >
                {creating() ? "Creating..." : "+ New"}
              </button>
            </div>
            <Show
              when={props.atom.experiments?.length > 0}
              fallback={
                <div class="text-12-regular text-text-weak">No experiments yet. Create one to get started.</div>
              }
            >
              <div class="flex flex-col gap-1">
                <For each={props.atom.experiments ?? []}>
                  {(exp) => (
                    <div class="flex items-center gap-1 group">
                      <button
                        class="flex-1 flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-background-stronger transition-colors"
                        onClick={() => exp.exp_session_id && navigateToExpSession(exp.exp_session_id)}
                        disabled={!exp.exp_session_id}
                      >
                        <span class={`w-2 h-2 rounded-full shrink-0 ${statusColor(exp.status)}`} />
                        <span class="text-12-regular text-text-base truncate">{exp.exp_id.slice(0, 8)}</span>
                        <span class="text-11-regular text-text-weak ml-auto shrink-0">{exp.status}</span>
                      </button>
                      <button
                        class="shrink-0 px-1.5 py-1 rounded text-11-regular text-text-weak hover:text-icon-critical-base opacity-0 group-hover:opacity-100 transition-all"
                        disabled={deleting() === exp.exp_id}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteExperiment(exp.exp_id)
                        }}
                        title="Delete experiment"
                      >
                        {deleting() === exp.exp_id ? "..." : "Del"}
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={isLoading()}>
          <div class="rounded-md border border-border-weak-base bg-background-base p-3">
            <div class="text-12-semibold text-text-strong mb-2">{tabTitle()}</div>
            <div class="text-12-regular text-text-weak">Loading...</div>
          </div>
        </Show>

        <Show when={hasError()}>
          <div class="rounded-md border border-border-weak-base bg-background-base p-3">
            <div class="text-12-semibold text-text-strong mb-2">{tabTitle()}</div>
            <div class="text-12-regular text-text-weak">Failed to load file content.</div>
          </div>
        </Show>

        <Show when={props.activeTab === "assessment"}>
          <div class="rounded-md border border-border-weak-base bg-background-base p-3 mb-2">
            <div class="text-12-semibold text-text-strong mb-2">Update Evidence Status</div>
            <div class="flex gap-2">
              <button
                disabled={updatingStatus() || props.atom.atom_evidence_status === "in_progress"}
                onClick={() => handleUpdateEvidenceStatus("in_progress")}
                class="px-2 py-1 rounded text-11-regular transition-colors disabled:opacity-50 bg-background-stronger hover:text-text-strong"
                classList={{
                  "text-icon-warning-base": props.atom.atom_evidence_status === "in_progress",
                  "text-text-base": props.atom.atom_evidence_status !== "in_progress",
                }}
              >
                In Progress
              </button>
              <button
                disabled={updatingStatus() || props.atom.atom_evidence_status === "proven"}
                onClick={() => handleUpdateEvidenceStatus("proven")}
                class="px-2 py-1 rounded text-11-regular transition-colors disabled:opacity-50 bg-background-stronger hover:text-text-strong"
                classList={{
                  "text-icon-success-base": props.atom.atom_evidence_status === "proven",
                  "text-text-base": props.atom.atom_evidence_status !== "proven",
                }}
              >
                Proven
              </button>
              <button
                disabled={updatingStatus() || props.atom.atom_evidence_status === "disproven"}
                onClick={() => handleUpdateEvidenceStatus("disproven")}
                class="px-2 py-1 rounded text-11-regular transition-colors disabled:opacity-50 bg-background-stronger hover:text-text-strong"
                classList={{
                  "text-icon-critical-base": props.atom.atom_evidence_status === "disproven",
                  "text-text-base": props.atom.atom_evidence_status !== "disproven",
                }}
              >
                Disproven
              </button>
            </div>
          </div>
        </Show>

        <Show when={!isLoading() && !hasError() && props.activeTab !== "plan"}>
          <div class="rounded-md border border-border-weak-base bg-background-base p-3">
            <div class="text-12-semibold text-text-strong mb-2">{tabTitle()}</div>
            <Show when={fileContent()?.trim() ? fileContent() : null} keyed>
              {(content) => <Markdown text={content} class="text-12-regular" />}
            </Show>
            <Show when={!fileContent() || fileContent()!.trim().length === 0}>
              <div class="text-12-regular text-text-weak">
                This atom does not have {tabTitle().toLowerCase()} content yet.
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

function DialogCreateExperiment(props: {
  creating: boolean
  onSubmit: (baselineBranch: string, codePath: string) => void
}) {
  const sdk = useSDK()
  const [branch, setBranch] = createSignal("master")
  const [codePath, setCodePath] = createSignal("")
  const [codePaths, setCodePaths] = createSignal<Array<{ name: string; path: string }>>([])

  onMount(async () => {
    try {
      const res = await sdk.client.research.codePaths()
      if (res.data) setCodePaths(res.data)
    } catch (err) {
      console.error("[DialogCreateExperiment] failed to load code paths", err)
    }
  })

  const handleSubmit = (e: SubmitEvent) => {
    e.preventDefault()
    if (!codePath().trim()) return
    props.onSubmit(branch(), codePath().trim())
  }

  const selectedOption = createMemo(() => codePaths().find((o) => o.path === codePath()) ?? null)

  return (
    <Dialog title="New Experiment">
      <form onSubmit={handleSubmit} class="flex flex-col gap-4 px-5 pb-5">
        <div class="flex flex-col gap-1.5">
          <label class="text-sm font-medium">Code Path</label>
          <Show when={codePaths().length > 0}>
            <Select
              options={codePaths()}
              current={selectedOption()}
              value={(o) => o?.path ?? ""}
              label={(o) => o?.name ?? ""}
              onSelect={(option) => option && setCodePath(option.path)}
              variant="secondary"
              size="small"
            />
          </Show>
          <TextField placeholder="/path/to/code" value={codePath()} onChange={(v) => setCodePath(v)} />
        </div>
        <TextField label="Baseline Branch" placeholder="master" value={branch()} onChange={(v) => setBranch(v)} />
        <Button type="submit" size="large" variant="primary" disabled={props.creating || !codePath().trim()}>
          {props.creating ? "Creating..." : "Create"}
        </Button>
      </form>
    </Dialog>
  )
}
