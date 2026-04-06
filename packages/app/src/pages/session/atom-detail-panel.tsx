import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { useFile } from "@/context/file"
import { useSDK } from "@/context/sdk"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { Combobox as KobalteCombobox } from "@kobalte/core/combobox"
import { Icon } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/ui/markdown"
import type { ResearchAtomsListResponse } from "@opencode-ai/sdk/v2"

type Atom = ResearchAtomsListResponse["atoms"][number]

const TYPE_COLORS: Record<string, string> = {
  fact: "#60a5fa",
  method: "#34d399",
  theorem: "#f87171",
  verification: "#fbbf24",
}

const STATUS_COLORS: Record<string, string> = {
  pending: "#64748b",
  in_progress: "#f59e0b",
  proven: "#22c55e",
  disproven: "#f87171",
}

const EXP_STATUS_COLORS: Record<string, string> = {
  running: "#3b82f6",
  done: "#22c55e",
  failed: "#ef4444",
  idle: "#f59e0b",
  pending: "#64748b",
}

type Experiment = {
  exp_id: string
  exp_name: string
  status: string
}

const PANEL_MIN_WIDTH = 400
const PANEL_MAX_WIDTH = 1200
const PANEL_DEFAULT_WIDTH = 680

export function AtomDetailPanel(props: {
  atom: Atom
  onClose: () => void
  onDelete?: (atomId: string) => Promise<void>
  onAtomSessionId?: (sessionId: string | null) => void
  chatOpen?: boolean
  onToggleChat?: () => void
  onOpenFileDetail?: (path: string, title: string) => void
  onOpenExpDetail?: (expId: string) => void
}) {
  const file = useFile()
  const sdk = useSDK()
  const navigate = useNavigate()
  const dialog = useDialog()
  const [experiments, setExperiments] = createSignal<Experiment[]>([])
  const [loadingExps, setLoadingExps] = createSignal(false)
  const [atomSessionId, setAtomSessionId] = createSignal<string | null>(null)
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [deleting, setDeleting] = createSignal(false)
  const [creatingExp, setCreatingExp] = createSignal(false)
  const [deletingExpId, setDeletingExpId] = createSignal<string | null>(null)
  const [updatingStatus, setUpdatingStatus] = createSignal(false)
  const [panelWidth, setPanelWidth] = createSignal(PANEL_DEFAULT_WIDTH)
  const [dragging, setDragging] = createSignal(false)

  const handleResizeStart = (e: MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = panelWidth()
    setDragging(true)

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX
      const newWidth = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, startWidth + delta))
      setPanelWidth(newWidth)
    }

    const onMouseUp = () => {
      setDragging(false)
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
    }

    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }

  const typeColor = () => TYPE_COLORS[props.atom.atom_type] ?? "#64748b"
  const statusColor = () => STATUS_COLORS[props.atom.atom_evidence_status] ?? "#64748b"

  // Load & watch claim file
  createEffect(() => {
    const path = props.atom.atom_claim_path
    if (!path) return
    file.load(path).catch(console.error)
    let mounted = true
    const unsub = sdk.event.on("file.watcher.updated" as any, (event: { file: string; event: string }) => {
      if (!mounted) return
      if (
        (event.file === path || event.file.endsWith(path) || path.endsWith(event.file)) &&
        (event.event === "change" || event.event === "add")
      ) {
        file.load(path, { force: true }).catch(console.error)
      }
    })
    onCleanup(() => { mounted = false; unsub() })
  })

  // Load & watch evidence file
  createEffect(() => {
    const path = props.atom.atom_evidence_path
    if (!path) return
    file.load(path).catch(console.error)
    let mounted = true
    const unsub = sdk.event.on("file.watcher.updated" as any, (event: { file: string; event: string }) => {
      if (!mounted) return
      if (
        (event.file === path || event.file.endsWith(path) || path.endsWith(event.file)) &&
        (event.event === "change" || event.event === "add")
      ) {
        file.load(path, { force: true }).catch(console.error)
      }
    })
    onCleanup(() => { mounted = false; unsub() })
  })

  // Load & watch evidence assessment file
  createEffect(() => {
    const path = props.atom.atom_evidence_assessment_path
    if (!path) return
    file.load(path).catch(console.error)
    let mounted = true
    const unsub = sdk.event.on("file.watcher.updated" as any, (event: { file: string; event: string }) => {
      if (!mounted) return
      if (
        (event.file === path || event.file.endsWith(path) || path.endsWith(event.file)) &&
        (event.event === "change" || event.event === "add")
      ) {
        file.load(path, { force: true }).catch(console.error)
      }
    })
    onCleanup(() => { mounted = false; unsub() })
  })

  const claimContent = createMemo(() => {
    const path = props.atom.atom_claim_path
    if (!path) return null
    return file.get(path)?.content?.content ?? null
  })

  const evidenceContent = createMemo(() => {
    const path = props.atom.atom_evidence_path
    if (!path) return null
    return file.get(path)?.content?.content ?? null
  })

  const assessmentContent = createMemo(() => {
    const path = props.atom.atom_evidence_assessment_path
    if (!path) return null
    return file.get(path)?.content?.content ?? null
  })

  const [evidenceTab, setEvidenceTab] = createSignal<"evidence" | "assessment">("evidence")

  const fetchExperiments = async (atomId: string) => {
    setLoadingExps(true)
    setExperiments([])
    setAtomSessionId(null)
    try {
      const sessionRes = await sdk.client.research.atom.session.create({ atomId })
      const sessionId = sessionRes.data?.session_id
      if (!sessionId) return
      setAtomSessionId(sessionId)
      const atomRes = await sdk.client.research.session.atom.get({ sessionId })
      const exps = (atomRes.data as any)?.atom?.experiments
      if (Array.isArray(exps)) setExperiments(exps)
    } catch (e) {
      console.error(e)
    } finally {
      setLoadingExps(false)
    }
  }

  // Fetch experiments via atom session
  createEffect(() => {
    fetchExperiments(props.atom.atom_id)
  })

  // Notify parent of atom session ID changes
  createEffect(() => {
    props.onAtomSessionId?.(atomSessionId())
  })

  const navigateToAtomSession = () => {
    const sessionId = atomSessionId()
    if (sessionId) {
      navigate(`/${base64Encode(sdk.directory)}/session/${sessionId}`)
    }
  }

  const handleDelete = async () => {
    if (!props.onDelete || deleting()) return
    setDeleting(true)
    try {
      await props.onDelete(props.atom.atom_id)
      props.onClose()
    } catch (e) {
      console.error("[atom-detail-panel] failed to delete atom", e)
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const navigateToExpSession = async (expId: string) => {
    try {
      const res = await sdk.client.research.experiment.session.create({ expId })
      const sessionId = res.data?.session_id
      if (sessionId) {
        navigate(`/${base64Encode(sdk.directory)}/session/${sessionId}`)
      }
    } catch (e) {
      console.error("[atom-detail-panel] failed to navigate to experiment session", e)
    }
  }

  const doCreateExperiment = async (expName: string, baselineBranch: string, codePath: string) => {
    if (creatingExp()) return
    setCreatingExp(true)
    try {
      await sdk.client.research.experiment.create({
        atomId: props.atom.atom_id,
        expName,
        baselineBranch,
        codePath,
      })
      dialog.close()
      fetchExperiments(props.atom.atom_id)
    } catch (e) {
      console.error("[atom-detail-panel] failed to create experiment", e)
    } finally {
      setCreatingExp(false)
    }
  }

  const handleCreateExperiment = () => {
    dialog.show(() => (
      <DialogCreateExperiment
        creating={creatingExp()}
        onSubmit={(expName, baselineBranch, codePath) => doCreateExperiment(expName, baselineBranch, codePath)}
      />
    ))
  }

  const handleDeleteExperiment = async (expId: string, evt: MouseEvent) => {
    evt.stopPropagation()
    if (deletingExpId()) return
    setDeletingExpId(expId)
    try {
      await sdk.client.research.experiment.delete({ expId })
      fetchExperiments(props.atom.atom_id)
    } catch (e) {
      console.error("[atom-detail-panel] failed to delete experiment", e)
    } finally {
      setDeletingExpId(null)
    }
  }

  const handleUpdateStatus = async (status: string) => {
    if (updatingStatus()) return
    setUpdatingStatus(true)
    try {
      await sdk.client.research.atom.update({
        researchProjectId: props.atom.research_project_id,
        atomId: props.atom.atom_id,
        evidence_status: status as any,
      })
    } catch (e) {
      console.error("[atom-detail-panel] failed to update status", e)
    } finally {
      setUpdatingStatus(false)
    }
  }

  return (
    <div
      class="bg-background-base border-l border-border-base flex flex-col overflow-hidden relative"
      style={{
        width: `${panelWidth()}px`,
        height: "100%",
        "flex-shrink": "0",
        animation: "panel-slide-in 250ms cubic-bezier(0.4, 0, 0.2, 1) forwards",
        "user-select": dragging() ? "none" : "auto",
      }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={handleResizeStart}
        class="absolute left-0 top-0 w-[5px] h-full z-10 cursor-col-resize"
        style={{
          background: dragging() ? "var(--accent-base)" : "transparent",
          transition: dragging() ? "none" : "background 0.15s",
        }}
        onMouseEnter={(e) => { if (!dragging()) e.currentTarget.style.background = "var(--border-base)" }}
        onMouseLeave={(e) => { if (!dragging()) e.currentTarget.style.background = "transparent" }}
      />
      {/* Header */}
      <div class="flex items-start justify-between p-4 border-b border-border-base shrink-0">
        <div class="flex-1 min-w-0">
          <div class="flex items-start gap-2 mb-2">
            <div class="text-sm font-semibold text-text-base break-words leading-snug flex-1 min-w-0">
              {props.atom.atom_name}
            </div>
            <Show when={atomSessionId()}>
              <Show when={props.onToggleChat}>
                <button
                  onClick={props.onToggleChat}
                  title={props.chatOpen ? "Close chat panel" : "Open chat panel"}
                  class="flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] cursor-pointer shrink-0 whitespace-nowrap transition-colors"
                  classList={{
                    "border-accent-base bg-accent-base/10 text-accent-base": props.chatOpen,
                    "border-border-base bg-transparent text-text-weak hover:text-text-base": !props.chatOpen,
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  Chat
                </button>
              </Show>
              <button
                onClick={navigateToAtomSession}
                title="Go to atom session"
                class="flex items-center gap-1 px-2 py-0.5 rounded border border-border-base bg-transparent text-accent-base text-[11px] cursor-pointer shrink-0 whitespace-nowrap hover:bg-background-stronger transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                Session
              </button>
            </Show>
            <Show when={props.onDelete}>
              <Show
                when={!confirmDelete()}
                fallback={
                  <div class="flex items-center gap-1 shrink-0">
                    <button
                      onClick={handleDelete}
                      disabled={deleting()}
                      class="flex items-center gap-1 px-2 py-0.5 rounded border border-red-600 bg-red-600 text-white text-[11px] whitespace-nowrap"
                      style={{
                        cursor: deleting() ? "not-allowed" : "pointer",
                        opacity: deleting() ? "0.6" : "1",
                      }}
                    >
                      {deleting() ? "Deleting..." : "Confirm"}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      class="px-2 py-0.5 rounded border border-border-base bg-transparent text-text-weak text-[11px] cursor-pointer whitespace-nowrap hover:text-text-base transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                }
              >
                <button
                  onClick={() => setConfirmDelete(true)}
                  title="Delete atom"
                  class="flex items-center gap-1 px-2 py-0.5 rounded border border-border-base bg-transparent text-red-400 text-[11px] cursor-pointer shrink-0 whitespace-nowrap hover:border-red-400 transition-colors"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
                  </svg>
                  Delete
                </button>
              </Show>
            </Show>
          </div>
          <div class="flex items-center gap-1.5 flex-wrap">
            <span
              class="text-[11px] font-medium px-2 py-0.5 rounded"
              style={{
                background: `${typeColor()}22`,
                color: typeColor(),
              }}
            >
              {props.atom.atom_type}
            </span>
            <StatusSelector
              current={props.atom.atom_evidence_status}
              updating={updatingStatus()}
              onSelect={handleUpdateStatus}
            />
            <span class="text-[11px] px-2 py-0.5 rounded bg-background-stronger text-text-weak">
              {props.atom.atom_evidence_type}
            </span>
          </div>
        </div>
        <button
          onClick={props.onClose}
          class="flex items-center justify-center w-7 h-7 border border-border-base rounded-md bg-transparent text-text-weak cursor-pointer shrink-0 ml-3 hover:text-text-base hover:bg-background-stronger transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Two-column content */}
      <div class="flex-1 min-h-0 flex">
        {/* Left column: Experiments + Claim */}
        <div class="flex-1 min-w-0 p-4 flex flex-col gap-4 border-r border-border-base">
          <Section
            title="Experiments"
            scrollable
            action={
              <button
                onClick={handleCreateExperiment}
                class="px-1.5 py-px border border-border-base rounded bg-transparent text-text-weak text-[11px] cursor-pointer whitespace-nowrap hover:text-text-base transition-colors"
              >
                + New
              </button>
            }
          >
            <Show when={!loadingExps()} fallback={<EmptyHint text="Loading..." />}>
              <Show when={experiments().length > 0} fallback={<EmptyHint text="No experiments yet" />}>
                <div class="flex flex-col gap-1">
                  <For each={experiments()}>
                    {(exp) => (
                      <div
                        class="flex items-center gap-2 px-2 py-1.5 rounded-md bg-background-base cursor-pointer hover:bg-background-stronger transition-colors"
                        onClick={() => props.onOpenExpDetail ? props.onOpenExpDetail(exp.exp_id) : navigateToExpSession(exp.exp_id)}
                        title="View experiment detail"
                      >
                        <span
                          class="w-2 h-2 rounded-full shrink-0"
                          style={{ background: EXP_STATUS_COLORS[exp.status] ?? "var(--text-weakest)" }}
                        />
                        <span class="text-xs text-text-base flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                          {exp.exp_name}
                        </span>
                        <span
                          class="text-[11px] shrink-0"
                          style={{ color: EXP_STATUS_COLORS[exp.status] ?? "var(--text-weak)" }}
                        >
                          {exp.status}
                        </span>
                        <button
                          onClick={(evt) => handleDeleteExperiment(exp.exp_id, evt)}
                          disabled={deletingExpId() === exp.exp_id}
                          title="Delete experiment"
                          class="flex items-center justify-center w-[18px] h-[18px] border-none rounded bg-transparent text-text-weakest shrink-0 p-0 hover:text-text-weak transition-colors"
                          style={{ cursor: deletingExpId() === exp.exp_id ? "not-allowed" : "pointer" }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          </svg>
                        </button>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-text-weakest">
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                          <polyline points="15 3 21 3 21 9" />
                          <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Section>

          <Section
            title="Claim"
            fill
            action={
              <Show when={props.onOpenFileDetail && props.atom.atom_claim_path}>
                <DetailButton onClick={() => props.onOpenFileDetail!(props.atom.atom_claim_path!, "Claim")} />
              </Show>
            }
          >
            <Show when={claimContent()} fallback={<EmptyHint text="No claim yet" />}>
              {(content) => <Markdown text={content()} class="text-12-regular" />}
            </Show>
          </Section>
        </div>

        {/* Right column: Evidence / Assessment */}
        <div class="flex-1 min-w-0 p-4 flex flex-col">
          <div class="bg-background-stronger rounded-lg border border-border-base flex flex-col flex-1 min-h-0">
            <div class="px-3 py-0 border-b border-border-base shrink-0 flex items-center gap-0">
              <button
                onClick={() => setEvidenceTab("evidence")}
                class="px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 bg-transparent cursor-pointer transition-colors"
                classList={{
                  "border-accent-base text-accent-base": evidenceTab() === "evidence",
                  "border-transparent text-text-weak hover:text-text-base": evidenceTab() !== "evidence",
                }}
              >
                Evidence
              </button>
              <button
                onClick={() => setEvidenceTab("assessment")}
                class="px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 bg-transparent cursor-pointer transition-colors"
                classList={{
                  "border-accent-base text-accent-base": evidenceTab() === "assessment",
                  "border-transparent text-text-weak hover:text-text-base": evidenceTab() !== "assessment",
                }}
              >
                Assessment
              </button>
              <Show when={props.onOpenFileDetail}>
                <div class="flex-1" />
                <DetailButton onClick={() => {
                  const path = evidenceTab() === "evidence"
                    ? props.atom.atom_evidence_path
                    : props.atom.atom_evidence_assessment_path
                  if (path) props.onOpenFileDetail!(path, evidenceTab() === "evidence" ? "Evidence" : "Assessment")
                }} />
              </Show>
            </div>
            <div class="p-3 overflow-y-auto flex-1 min-h-0">
              <Show when={evidenceTab() === "evidence"}>
                <Show when={evidenceContent()} fallback={<EmptyHint text="No evidence yet" />}>
                  {(content) => <Markdown text={content()} class="text-12-regular" />}
                </Show>
              </Show>
              <Show when={evidenceTab() === "assessment"}>
                <Show when={assessmentContent()} fallback={<EmptyHint text="No assessment yet" />}>
                  {(content) => <Markdown text={content()} class="text-12-regular" />}
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Section(props: { title: string; scrollable?: boolean; fill?: boolean; action?: any; children: any }) {
  return (
    <div
      class="bg-background-stronger rounded-lg border border-border-base flex flex-col"
      classList={{
        "flex-1 min-h-0": props.fill,
      }}
      style={props.scrollable ? { "max-height": "340px" } : undefined}
    >
      <div class="px-3 py-2.5 border-b border-border-base text-xs font-semibold text-text-weak uppercase tracking-wider shrink-0 flex items-center justify-between">
        {props.title}
        {props.action}
      </div>
      <div
        class="p-3"
        classList={{
          "overflow-y-auto flex-1 min-h-0": props.fill || props.scrollable,
        }}
      >
        {props.children}
      </div>
    </div>
  )
}

const EVIDENCE_STATUSES = ["pending", "in_progress", "proven", "disproven"] as const

function StatusSelector(props: { current: string; updating: boolean; onSelect: (status: string) => void }) {
  const [open, setOpen] = createSignal(false)
  const color = () => STATUS_COLORS[props.current] ?? "var(--text-weakest)"

  return (
    <div class="relative">
      <button
        onClick={() => setOpen(!open())}
        disabled={props.updating}
        class="text-[11px] font-medium px-2 py-0.5 rounded border-none flex items-center gap-1"
        style={{
          background: `${color()}22`,
          color: color(),
          cursor: props.updating ? "not-allowed" : "pointer",
          opacity: props.updating ? "0.6" : "1",
        }}
      >
        {props.updating ? "Updating..." : props.current}
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="absolute top-full left-0 mt-1 z-50 bg-background-stronger border border-border-base rounded-md p-1 shadow-lg min-w-[120px]">
          <For each={EVIDENCE_STATUSES}>
            {(status) => {
              const c = () => STATUS_COLORS[status] ?? "var(--text-weakest)"
              return (
                <button
                  onClick={() => {
                    setOpen(false)
                    if (status !== props.current) props.onSelect(status)
                  }}
                  class="flex items-center gap-2 w-full px-2 py-1 border-none rounded text-[11px] cursor-pointer text-left"
                  classList={{
                    "bg-background-base": status === props.current,
                    "bg-transparent hover:bg-background-base": status !== props.current,
                  }}
                  style={{ color: c() }}
                >
                  <span
                    class="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: c() }}
                  />
                  {status}
                </button>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

function EmptyHint(props: { text: string }) {
  return (
    <div class="text-xs text-text-weakest">{props.text}</div>
  )
}

function DetailButton(props: { onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      title="View detail"
      class="px-1.5 py-px border border-border-base rounded bg-transparent text-text-weak text-[11px] cursor-pointer whitespace-nowrap hover:text-text-base transition-colors"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    </button>
  )
}

type BranchOption = {
  branch: string
  displayName: string
  experimentId: string | null
}

function DialogCreateExperiment(props: {
  creating: boolean
  onSubmit: (expName: string, baselineBranch: string, codePath: string) => void
}) {
  const sdk = useSDK()
  const [expName, setExpName] = createSignal("")
  const [selectedBranch, setSelectedBranch] = createSignal<BranchOption | null>(null)
  const [codePath, setCodePath] = createSignal("")
  const [codePaths, setCodePaths] = createSignal<Array<{ name: string; path: string }>>([])
  const [branches, setBranches] = createSignal<BranchOption[]>([])
  const [loadingBranches, setLoadingBranches] = createSignal(false)

  onMount(async () => {
    try {
      const res = await sdk.client.research.codePaths()
      if (res.data) setCodePaths(res.data)
    } catch (err) {
      console.error("[DialogCreateExperiment] failed to load code paths", err)
    }
  })

  createEffect(() => {
    const cp = codePath()
    if (!cp.trim()) {
      setBranches([])
      setSelectedBranch(null)
      return
    }
    setLoadingBranches(true)
    setSelectedBranch(null)
    sdk.client.research
      .branches({ codePath: cp })
      .then((res) => {
        if (res.data) setBranches(res.data)
      })
      .catch((err) => {
        console.error("[DialogCreateExperiment] failed to load branches", err)
        setBranches([])
      })
      .finally(() => setLoadingBranches(false))
  })

  const handleSubmit = (e: SubmitEvent) => {
    e.preventDefault()
    const branch = selectedBranch()
    if (!expName().trim() || !codePath().trim() || !branch) return
    props.onSubmit(expName().trim(), branch.branch, codePath().trim())
  }

  const selectedOption = createMemo(() => codePaths().find((o) => o.path === codePath()) ?? null)

  return (
    <Dialog title="New Experiment">
      <form onSubmit={handleSubmit} class="flex flex-col gap-4 px-5 pb-5">
        <TextField
          label="Experiment Name"
          placeholder="e.g. baseline-lr-sweep"
          value={expName()}
          onChange={(v) => setExpName(v)}
        />
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
        <div class="flex flex-col gap-1.5">
          <label class="text-sm font-medium">Baseline Branch</label>
          <Show when={!loadingBranches()} fallback={<div class="text-xs text-text-weak py-1">Loading branches...</div>}>
            <KobalteCombobox<BranchOption>
              options={branches()}
              value={selectedBranch()}
              onChange={(val) => setSelectedBranch(val)}
              optionValue="branch"
              optionTextValue="displayName"
              optionLabel="displayName"
              placeholder="Search and select a branch..."
              triggerMode="focus"
              itemComponent={(itemProps) => (
                <KobalteCombobox.Item item={itemProps.item} data-slot="select-select-item">
                  <KobalteCombobox.ItemLabel data-slot="select-select-item-label">
                    {itemProps.item.rawValue.displayName}
                    <Show when={itemProps.item.rawValue.experimentId}>
                      <span class="ml-1.5 text-text-weak text-xs">({itemProps.item.rawValue.branch.slice(0, 8)})</span>
                    </Show>
                  </KobalteCombobox.ItemLabel>
                  <KobalteCombobox.ItemIndicator data-slot="select-select-item-indicator">
                    <Icon name="check-small" size="small" />
                  </KobalteCombobox.ItemIndicator>
                </KobalteCombobox.Item>
              )}
            >
              <KobalteCombobox.Control data-component="combobox-control" class="flex items-center">
                <KobalteCombobox.Input
                  data-component="combobox-input"
                  class="flex-1 bg-transparent outline-none text-sm"
                  style={{
                    height: "32px",
                    padding: "0 8px",
                    "border-radius": "var(--radius-md)",
                    "background-color": "var(--input-base)",
                    "box-shadow": "var(--shadow-xs-border-base)",
                    color: "var(--text-strong)",
                  }}
                />
                <KobalteCombobox.Trigger data-component="combobox-trigger" class="absolute right-2">
                  <KobalteCombobox.Icon>
                    <Icon name="chevron-down" size="small" />
                  </KobalteCombobox.Icon>
                </KobalteCombobox.Trigger>
              </KobalteCombobox.Control>
              <KobalteCombobox.Portal>
                <KobalteCombobox.Content data-component="select-content">
                  <KobalteCombobox.Listbox data-slot="select-select-content-list" />
                </KobalteCombobox.Content>
              </KobalteCombobox.Portal>
            </KobalteCombobox>
          </Show>
          <Show when={branches().length === 0 && codePath().trim() && !loadingBranches()}>
            <div class="text-xs text-text-weak">No branches found for this code path</div>
          </Show>
        </div>
        <Button
          type="submit"
          size="large"
          variant="primary"
          disabled={props.creating || !expName().trim() || !codePath().trim() || !selectedBranch()}
        >
          {props.creating ? "Creating..." : "Create"}
        </Button>
      </form>
    </Dialog>
  )
}
