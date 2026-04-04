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

export function AtomDetailPanel(props: {
  atom: Atom
  onClose: () => void
  onDelete?: (atomId: string) => Promise<void>
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

  const typeColor = () => TYPE_COLORS[props.atom.atom_type] ?? "#64748b"
  const statusColor = () => STATUS_COLORS[props.atom.atom_evidence_status] ?? "#64748b"

  // Load claim file
  createEffect(() => {
    const path = props.atom.atom_claim_path
    if (path) file.load(path).catch(console.error)
  })

  // Load evidence file
  createEffect(() => {
    const path = props.atom.atom_evidence_path
    if (path) file.load(path).catch(console.error)
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
      style={{
        width: "680px",
        height: "100%",
        "border-left": "1px solid #1e293b",
        background: "#0f172a",
        display: "flex",
        "flex-direction": "column",
        "flex-shrink": "0",
        overflow: "hidden",
        animation: "panel-slide-in 250ms cubic-bezier(0.4, 0, 0.2, 1) forwards",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          "align-items": "flex-start",
          "justify-content": "space-between",
          padding: "16px",
          "border-bottom": "1px solid #1e293b",
          "flex-shrink": "0",
        }}
      >
        <div style={{ flex: "1", "min-width": "0" }}>
          <div
            style={{
              display: "flex",
              "align-items": "flex-start",
              gap: "8px",
              "margin-bottom": "8px",
            }}
          >
            <div
              style={{
                "font-size": "14px",
                "font-weight": "600",
                color: "#f1f5f9",
                "word-break": "break-word",
                "line-height": "1.3",
                flex: "1",
                "min-width": "0",
              }}
            >
              {props.atom.atom_name}
            </div>
            <Show when={atomSessionId()}>
              <button
                onClick={navigateToAtomSession}
                title="Go to atom session"
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "4px",
                  padding: "2px 8px",
                  border: "1px solid #334155",
                  "border-radius": "4px",
                  background: "transparent",
                  color: "#60a5fa",
                  "font-size": "11px",
                  cursor: "pointer",
                  "flex-shrink": "0",
                  "white-space": "nowrap",
                }}
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
                  <div style={{ display: "flex", "align-items": "center", gap: "4px", "flex-shrink": "0" }}>
                    <button
                      onClick={handleDelete}
                      disabled={deleting()}
                      style={{
                        display: "flex",
                        "align-items": "center",
                        gap: "4px",
                        padding: "2px 8px",
                        border: "1px solid #dc2626",
                        "border-radius": "4px",
                        background: "#dc2626",
                        color: "#fff",
                        "font-size": "11px",
                        cursor: deleting() ? "not-allowed" : "pointer",
                        opacity: deleting() ? "0.6" : "1",
                        "white-space": "nowrap",
                      }}
                    >
                      {deleting() ? "Deleting..." : "Confirm"}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      style={{
                        padding: "2px 8px",
                        border: "1px solid #334155",
                        "border-radius": "4px",
                        background: "transparent",
                        color: "#94a3b8",
                        "font-size": "11px",
                        cursor: "pointer",
                        "white-space": "nowrap",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                }
              >
                <button
                  onClick={() => setConfirmDelete(true)}
                  title="Delete atom"
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "4px",
                    padding: "2px 8px",
                    border: "1px solid #334155",
                    "border-radius": "4px",
                    background: "transparent",
                    color: "#f87171",
                    "font-size": "11px",
                    cursor: "pointer",
                    "flex-shrink": "0",
                    "white-space": "nowrap",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
                  </svg>
                  Delete
                </button>
              </Show>
            </Show>
          </div>
          <div style={{ display: "flex", "align-items": "center", gap: "6px", "flex-wrap": "wrap" }}>
            <span
              style={{
                "font-size": "11px",
                "font-weight": "500",
                padding: "2px 8px",
                "border-radius": "4px",
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
            <span
              style={{
                "font-size": "11px",
                padding: "2px 8px",
                "border-radius": "4px",
                background: "#334155",
                color: "#94a3b8",
              }}
            >
              {props.atom.atom_evidence_type}
            </span>
          </div>
        </div>
        <button
          onClick={props.onClose}
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            width: "28px",
            height: "28px",
            border: "1px solid #334155",
            "border-radius": "6px",
            background: "transparent",
            color: "#94a3b8",
            cursor: "pointer",
            "flex-shrink": "0",
            "margin-left": "12px",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Two-column content */}
      <div
        style={{
          flex: "1",
          "min-height": "0",
          display: "flex",
          gap: "0",
        }}
      >
        {/* Left column: Experiments + Claim */}
        <div
          style={{
            flex: "1",
            "min-width": "0",
            padding: "16px",
            display: "flex",
            "flex-direction": "column",
            gap: "16px",
            "border-right": "1px solid #1e293b",
          }}
        >
          <Section
            title="Experiments"
            scrollable
            action={
              <button
                onClick={handleCreateExperiment}
                style={{
                  padding: "1px 6px",
                  border: "1px solid #334155",
                  "border-radius": "4px",
                  background: "transparent",
                  color: "#94a3b8",
                  "font-size": "11px",
                  cursor: "pointer",
                  "white-space": "nowrap",
                }}
              >
                + New
              </button>
            }
          >
            <Show when={!loadingExps()} fallback={<EmptyHint text="Loading..." />}>
              <Show when={experiments().length > 0} fallback={<EmptyHint text="No experiments yet" />}>
                <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                  <For each={experiments()}>
                    {(exp) => (
                      <div
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "8px",
                          padding: "6px 8px",
                          "border-radius": "6px",
                          background: "#0f172a",
                          cursor: "pointer",
                        }}
                        onClick={() => navigateToExpSession(exp.exp_id)}
                        title="Go to experiment session"
                      >
                        <span
                          style={{
                            width: "8px",
                            height: "8px",
                            "border-radius": "50%",
                            background: EXP_STATUS_COLORS[exp.status] ?? "#64748b",
                            "flex-shrink": "0",
                          }}
                        />
                        <span
                          style={{
                            "font-size": "12px",
                            color: "#e2e8f0",
                            flex: "1",
                            "min-width": "0",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                        >
                          {exp.exp_name}
                        </span>
                        <span
                          style={{
                            "font-size": "11px",
                            color: EXP_STATUS_COLORS[exp.status] ?? "#94a3b8",
                            "flex-shrink": "0",
                          }}
                        >
                          {exp.status}
                        </span>
                        <button
                          onClick={(evt) => handleDeleteExperiment(exp.exp_id, evt)}
                          disabled={deletingExpId() === exp.exp_id}
                          title="Delete experiment"
                          style={{
                            display: "flex",
                            "align-items": "center",
                            "justify-content": "center",
                            width: "18px",
                            height: "18px",
                            border: "none",
                            "border-radius": "4px",
                            background: "transparent",
                            color: deletingExpId() === exp.exp_id ? "#64748b" : "#64748b",
                            cursor: deletingExpId() === exp.exp_id ? "not-allowed" : "pointer",
                            "flex-shrink": "0",
                            padding: "0",
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          </svg>
                        </button>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "flex-shrink": "0" }}>
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

          <Section title="Claim" fill>
            <Show when={claimContent()} fallback={<EmptyHint text="No claim yet" />}>
              {(content) => <Markdown text={content()} class="text-12-regular" />}
            </Show>
          </Section>
        </div>

        {/* Right column: Evidence */}
        <div
          style={{
            flex: "1",
            "min-width": "0",
            padding: "16px",
            display: "flex",
            "flex-direction": "column",
          }}
        >
          <Section title="Evidence" fill>
            <Show when={evidenceContent()} fallback={<EmptyHint text="No evidence yet" />}>
              {(content) => <Markdown text={content()} class="text-12-regular" />}
            </Show>
          </Section>
        </div>
      </div>
    </div>
  )
}

function Section(props: { title: string; scrollable?: boolean; fill?: boolean; action?: any; children: any }) {
  return (
    <div
      style={{
        background: "#1e293b",
        "border-radius": "8px",
        border: "1px solid #334155",
        display: "flex",
        "flex-direction": "column",
        ...(props.fill ? { flex: "1", "min-height": "0" } : {}),
        ...(props.scrollable ? { "max-height": "340px" } : {}),
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          "border-bottom": "1px solid #334155",
          "font-size": "12px",
          "font-weight": "600",
          color: "#94a3b8",
          "text-transform": "uppercase",
          "letter-spacing": "0.05em",
          "flex-shrink": "0",
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
        }}
      >
        {props.title}
        {props.action}
      </div>
      <div
        style={{
          padding: "12px",
          "overflow-y": props.fill || props.scrollable ? "auto" : "visible",
          ...(props.fill ? { flex: "1", "min-height": "0" } : {}),
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
  const color = () => STATUS_COLORS[props.current] ?? "#64748b"

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(!open())}
        disabled={props.updating}
        style={{
          "font-size": "11px",
          "font-weight": "500",
          padding: "2px 8px",
          "border-radius": "4px",
          background: `${color()}22`,
          color: color(),
          border: "none",
          cursor: props.updating ? "not-allowed" : "pointer",
          opacity: props.updating ? "0.6" : "1",
          display: "flex",
          "align-items": "center",
          gap: "4px",
        }}
      >
        {props.updating ? "Updating..." : props.current}
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <Show when={open()}>
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: "0",
            "margin-top": "4px",
            "z-index": "50",
            background: "#1e293b",
            border: "1px solid #334155",
            "border-radius": "6px",
            padding: "4px",
            "box-shadow": "0 8px 24px rgba(0,0,0,0.4)",
            "min-width": "120px",
          }}
        >
          <For each={EVIDENCE_STATUSES}>
            {(status) => {
              const c = () => STATUS_COLORS[status] ?? "#64748b"
              return (
                <button
                  onClick={() => {
                    setOpen(false)
                    if (status !== props.current) props.onSelect(status)
                  }}
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "8px",
                    width: "100%",
                    padding: "5px 8px",
                    border: "none",
                    "border-radius": "4px",
                    background: status === props.current ? "#334155" : "transparent",
                    color: c(),
                    "font-size": "11px",
                    cursor: "pointer",
                    "text-align": "left",
                  }}
                >
                  <span
                    style={{
                      width: "6px",
                      height: "6px",
                      "border-radius": "50%",
                      background: c(),
                      "flex-shrink": "0",
                    }}
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
    <div style={{ "font-size": "12px", color: "#64748b" }}>{props.text}</div>
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
