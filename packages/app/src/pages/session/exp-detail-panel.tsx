import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"
import { ExpProgressTab, ExpPlanTab, ExpHistoryChangeTab, ExpResultTab } from "./experiment-tab"
import type { CommitDiff } from "./experiment-tab"

const PANEL_MIN_WIDTH = 400
const PANEL_MAX_WIDTH = 1200
const PANEL_DEFAULT_WIDTH = 720

const EXP_STATUS_COLORS: Record<string, string> = {
  running: "#3b82f6",
  done: "#22c55e",
  failed: "#ef4444",
  idle: "#f59e0b",
  pending: "#64748b",
}

export function ExpDetailPanel(props: {
  expId: string
  onClose: () => void
  onOpenFileDetail?: (path: string, title: string) => void
  onExpSessionId?: (sessionId: string | null) => void
  chatOpen?: boolean
  onToggleChat?: () => void
  onDelete?: (expId: string) => Promise<void>
}) {
  const sdk = useSDK()
  const navigate = useNavigate()
  const local = useLocal()
  const [panelWidth, setPanelWidth] = createSignal(PANEL_DEFAULT_WIDTH)
  const [dragging, setDragging] = createSignal(false)
  const [rightTab, setRightTab] = createSignal<"plan" | "changes">("plan")
  const [expSessionId, setExpSessionId] = createSignal<string | null>(null)
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [deleting, setDeleting] = createSignal(false)
  const [changesDetailOpen, setChangesDetailOpen] = createSignal(false)

  // Switch to experiment agent on mount, restore on unmount
  const prevAgent = local.agent.current()?.name
  local.agent.set("experiment")
  onCleanup(() => {
    if (prevAgent) local.agent.set(prevAgent)
  })

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

  // Fetch experiment data: expId → session → bySession
  const [experiment, { refetch: refetchExperiment }] = createResource(
    () => props.expId,
    async (expId) => {
      if (!expId) return null
      try {
        const sessionRes = await sdk.client.research.experiment.session.create({ expId })
        const sessionId = sessionRes.data?.session_id
        if (!sessionId) return null
        setExpSessionId(sessionId)
        const res = await sdk.client.research.experiment.bySession({ sessionId })
        return res.data ?? null
      } catch (e) {
        console.error("[exp-detail-panel] failed to fetch experiment", e)
        return null
      }
    },
  )

  // Notify parent of session ID changes
  createEffect(() => {
    props.onExpSessionId?.(expSessionId())
  })

  const navigateToExpSession = () => {
    const sessionId = expSessionId()
    if (sessionId) {
      navigate(`/${base64Encode(sdk.directory)}/session/${sessionId}`)
    }
  }

  const handleDelete = async () => {
    if (!props.onDelete || deleting()) return
    setDeleting(true)
    try {
      await props.onDelete(props.expId)
      props.onClose()
    } catch (e) {
      console.error("[exp-detail-panel] failed to delete experiment", e)
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  // Fetch commits for changes tab
  const [experimentDiff, { refetch: refetchDiff }] = createResource(
    () => props.expId,
    async (expId) => {
      if (!expId) return []
      try {
        const res = await sdk.client.research.experiment.diff({ expId })
        return (
          (
            res.data as
              | { commits: Array<{ hash: string; message: string; author: string; date: string; diffs: any[] }> }
              | undefined
          )?.commits ?? []
        )
      } catch {
        return []
      }
    },
  )

  // Auto-refresh while running
  createEffect(() => {
    const exp = experiment()
    if (!exp || exp.status !== "running") return
    const interval = setInterval(() => {
      refetchExperiment()
      refetchDiff()
    }, 10000)
    onCleanup(() => clearInterval(interval))
  })

  // Poll changes every 5s when changes tab is active
  createEffect(() => {
    if (rightTab() !== "changes") return
    refetchDiff()
    const timer = setInterval(() => refetchDiff(), 5000)
    onCleanup(() => clearInterval(timer))
  })

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
        onMouseEnter={(e) => {
          if (!dragging()) e.currentTarget.style.background = "var(--border-base)"
        }}
        onMouseLeave={(e) => {
          if (!dragging()) e.currentTarget.style.background = "transparent"
        }}
      />

      {/* Header */}
      <div class="flex items-start justify-between p-4 border-b border-border-base shrink-0">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <button
              onClick={props.onClose}
              class="flex items-center justify-center w-6 h-6 rounded-md bg-transparent text-text-weak cursor-pointer hover:text-text-base hover:bg-background-stronger transition-colors shrink-0"
              title="Back to atom detail"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <div class="text-sm font-semibold text-text-base break-words leading-snug flex-1 min-w-0">
              {experiment()?.exp_name ?? "Experiment"}
            </div>
            <Show when={expSessionId()}>
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
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  Chat
                </button>
              </Show>
              <button
                onClick={navigateToExpSession}
                title="Go to experiment session"
                class="flex items-center gap-1 px-2 py-0.5 rounded border border-border-base bg-transparent text-accent-base text-[11px] cursor-pointer shrink-0 whitespace-nowrap hover:bg-background-stronger transition-colors"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
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
                  title="Delete experiment"
                  class="flex items-center gap-1 px-2 py-0.5 rounded border border-border-base bg-transparent text-red-400 text-[11px] cursor-pointer shrink-0 whitespace-nowrap hover:border-red-400 transition-colors"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
                  </svg>
                  Delete
                </button>
              </Show>
            </Show>
          </div>
          <div class="flex items-center gap-1.5 flex-wrap pl-8">
            <Show when={experiment()}>
              {(exp) => {
                const color = () => EXP_STATUS_COLORS[exp().status] ?? "#64748b"
                return (
                  <span
                    class="text-[11px] font-medium px-2 py-0.5 rounded flex items-center gap-1.5"
                    style={{ background: `${color()}22`, color: color() }}
                  >
                    <span class="w-1.5 h-1.5 rounded-full" style={{ background: color() }} />
                    {exp().status}
                  </span>
                )
              }}
            </Show>
            <Show when={experiment()?.exp_branch_name}>
              {(branch) => (
                <span class="text-[11px] px-2 py-0.5 rounded bg-background-stronger text-text-weak font-mono">
                  {branch()}
                </span>
              )}
            </Show>
          </div>
        </div>
        <button
          onClick={props.onClose}
          class="flex items-center justify-center w-7 h-7 border border-border-base rounded-md bg-transparent text-text-weak cursor-pointer shrink-0 ml-3 hover:text-text-base hover:bg-background-stronger transition-colors"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Changes detail overlay */}
      <Show when={changesDetailOpen() && experiment()}>
        {(exp) => (
          <div
            class="absolute inset-0 top-0 bg-background-base flex flex-col"
            style:z-index={130}
            style={{ animation: "file-detail-slide-in 200ms cubic-bezier(0.4, 0, 0.2, 1) forwards" }}
          >
            <style>{`
              @keyframes file-detail-slide-in {
                from { opacity: 0; transform: translateX(40px); }
                to { opacity: 1; transform: translateX(0); }
              }
            `}</style>
            <div class="flex items-center justify-between px-4 py-2.5 border-b border-border-base shrink-0">
              <div class="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => setChangesDetailOpen(false)}
                  class="flex items-center justify-center w-7 h-7 rounded-md bg-transparent text-text-weak cursor-pointer hover:text-text-base hover:bg-background-stronger transition-colors shrink-0"
                  title="Back"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
                <span class="text-sm font-semibold text-text-base">Changes</span>
              </div>
            </div>
            <div class="flex-1 min-h-0 overflow-hidden">
              <ExpHistoryChangeTab
                experiment={exp()}
                commits={(experimentDiff() ?? []) as CommitDiff[]}
                loading={experimentDiff.loading}
                error={experimentDiff.error}
                onRefresh={refetchDiff}
              />
            </div>
          </div>
        )}
      </Show>

      {/* Two-column content */}
      <div class="flex-1 min-h-0 flex">
        {/* Left column: Info + Result */}
        <div class="flex-1 min-w-0 flex flex-col border-r border-border-base">
          {/* Info section */}
          <div class="flex flex-col" style={{ "max-height": "50%" }}>
            <div class="px-3 py-2.5 border-b border-border-base text-xs font-semibold text-text-weak uppercase tracking-wider shrink-0">
              Info
            </div>
            <div class="overflow-y-auto flex-1 min-h-0">
              <Show when={experiment()} fallback={<div class="p-3 text-xs text-text-weakest">Loading...</div>}>
                {(exp) => <ExpProgressTab experiment={exp()} onUpdated={refetchExperiment} hideStatus hideAtom />}
              </Show>
            </div>
          </div>

          {/* Result section */}
          <div class="flex-1 min-h-0 flex flex-col border-t border-border-base">
            <div class="px-3 py-2.5 border-b border-border-base text-xs font-semibold text-text-weak uppercase tracking-wider shrink-0">
              Result
            </div>
            <div class="flex-1 min-h-0 overflow-hidden">
              <Show when={experiment()} fallback={<div class="p-3 text-xs text-text-weakest">Loading...</div>}>
                {(exp) => (
                  <ExpResultTab
                    experiment={exp()}
                    onOpenFile={(filePath) => props.onOpenFileDetail?.(filePath, filePath.split("/").pop() ?? "File")}
                  />
                )}
              </Show>
            </div>
          </div>
        </div>

        {/* Right column: Plan / Changes tabs */}
        <div class="flex-1 min-w-0 flex flex-col">
          <div class="px-3 py-0 border-b border-border-base shrink-0 flex items-center gap-0">
            <button
              onClick={() => setRightTab("plan")}
              class="px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 bg-transparent cursor-pointer transition-colors"
              classList={{
                "border-accent-base text-accent-base": rightTab() === "plan",
                "border-transparent text-text-weak hover:text-text-base": rightTab() !== "plan",
              }}
            >
              Plan
            </button>
            <button
              onClick={() => setRightTab("changes")}
              class="px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 bg-transparent cursor-pointer transition-colors"
              classList={{
                "border-accent-base text-accent-base": rightTab() === "changes",
                "border-transparent text-text-weak hover:text-text-base": rightTab() !== "changes",
              }}
            >
              Changes
            </button>
            <Show
              when={
                (rightTab() === "plan" && props.onOpenFileDetail && experiment()?.exp_plan_path) ||
                rightTab() === "changes"
              }
            >
              <div class="flex-1" />
              <button
                onClick={() => {
                  if (rightTab() === "plan") {
                    const path = experiment()?.exp_plan_path
                    if (path) props.onOpenFileDetail!(path, "Plan")
                  } else {
                    setChangesDetailOpen(true)
                  }
                }}
                title="View detail"
                class="px-1.5 py-px border border-border-base rounded bg-transparent text-text-weak text-[11px] cursor-pointer whitespace-nowrap hover:text-text-base transition-colors"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </button>
            </Show>
          </div>
          <div class="flex-1 min-h-0 overflow-hidden">
            <Show when={experiment()} fallback={<div class="p-3 text-xs text-text-weakest">Loading...</div>}>
              {(exp) => (
                <>
                  <div class="h-full" style={{ display: rightTab() === "plan" ? "block" : "none" }}>
                    <ExpPlanTab experiment={exp()} />
                  </div>
                  <div class="h-full" style={{ display: rightTab() === "changes" ? "block" : "none" }}>
                    <ExpHistoryChangeTab
                      experiment={exp()}
                      commits={(experimentDiff() ?? []) as CommitDiff[]}
                      loading={experimentDiff.loading}
                      error={experimentDiff.error}
                      onRefresh={refetchDiff}
                    />
                  </div>
                </>
              )}
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
