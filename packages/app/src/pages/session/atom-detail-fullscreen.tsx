import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import type { ResearchAtomsListResponse } from "@opencode-ai/sdk/v2"
import { AtomDetailView } from "./atom-detail-view"
import { AtomDetailPanel } from "./atom-detail-panel"

type Atom = ResearchAtomsListResponse["atoms"][number]
type Relation = ResearchAtomsListResponse["relations"][number]
type AtomKind = "fact" | "method" | "theorem" | "verification"

function computeInset(rect: { x: number; y: number; width: number; height: number }) {
  const top = (rect.y / window.innerHeight) * 100
  const right = ((1 - (rect.x + rect.width) / window.innerWidth) * 100)
  const bottom = ((1 - (rect.y + rect.height) / window.innerHeight) * 100)
  const left = (rect.x / window.innerWidth) * 100
  return `inset(${top}% ${right}% ${bottom}% ${left}%)`
}

export function AtomDetailFullscreen(props: {
  atoms: Atom[]
  relations: Relation[]
  loading: boolean
  error: boolean
  onAtomClick: (atomId: string) => void
  onAtomCreate: (input: { name: string; type: AtomKind }) => Promise<Atom>
  onAtomDelete: (atomId: string) => Promise<void>
  onRelationCreate: (input: { sourceAtomId: string; targetAtomId: string; relationType: string }) => Promise<void>
  onRelationUpdate: (input: { sourceAtomId: string; targetAtomId: string; relationType: string; nextRelationType: string }) => Promise<void>
  onRelationDelete: (input: { sourceAtomId: string; targetAtomId: string; relationType: string }) => Promise<void>
  researchProjectId: string
  originRect: { x: number; y: number; width: number; height: number }
  visible: boolean
  focusAtomId?: string | null
  onClose: () => void
}) {
  const [selectedAtomId, setSelectedAtomId] = createSignal<string | null>(null)
  const selectedAtom = createMemo(() => {
    const id = selectedAtomId()
    if (!id) return null
    return props.atoms.find((a) => a.atom_id === id) ?? null
  })

  // When opened with a focus atom, pre-select it to open the side panel
  createEffect(
    on(
      () => [props.visible, props.focusAtomId] as const,
      ([visible, focusId]) => {
        if (visible && focusId) {
          setSelectedAtomId(focusId)
        }
      },
    ),
  )

  // Track whether the overlay is actually shown (after close transition ends, hide it)
  const [hidden, setHidden] = createSignal(!props.visible)

  createEffect(
    on(
      () => props.visible,
      (visible) => {
        if (visible) {
          setHidden(false)
          document.body.style.overflow = "hidden"
        }
      },
    ),
  )

  const handleTransitionEnd = (e: TransitionEvent) => {
    if (e.propertyName === "clip-path" && !props.visible) {
      setHidden(true)
      document.body.style.overflow = ""
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && props.visible) {
      e.preventDefault()
      e.stopPropagation()
      props.onClose()
    }
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown, true)
  })
  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown, true)
    document.body.style.overflow = ""
  })

  const collapsedInset = () => computeInset(props.originRect)

  return (
    <Portal mount={document.body}>
      <style>{`
        @keyframes panel-slide-in {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .solid-flow {
          --xy-edge-label-background-color: rgba(15, 23, 42, 0.85);
          --xy-edge-label-color: #94a3b8;
          --xy-handle-background-color: #334155;
          --xy-handle-border-color: #475569;
          --xy-connectionline-stroke-default: #60a5fa;
          --xy-connectionline-stroke-width-default: 2;
        }
        .solid-flow__connectionline {
          overflow: visible !important;
        }
        .solid-flow__connection-path {
          stroke-dasharray: 6 3;
          animation: connectionLineDash 0.5s linear infinite;
        }
        @keyframes connectionLineDash {
          to { stroke-dashoffset: -9; }
        }
        .solid-flow__edge path {
          transition: stroke 0.2s, stroke-width 0.2s;
        }
        .solid-flow__edge:hover path {
          stroke-width: 3px !important;
          filter: drop-shadow(0 0 3px currentColor);
        }
        .solid-flow__handle.connectingfrom,
        .solid-flow__handle.connectionindicator {
          --xy-handle-background-color: #60a5fa;
          --xy-handle-border-color: #93c5fd;
        }
        .solid-flow__edge-label {
          border-radius: 4px;
          padding: 2px 6px !important;
          font-size: 10px;
          backdrop-filter: blur(4px);
        }
      `}</style>
      <div
        onTransitionEnd={handleTransitionEnd}
        style={{
          position: "fixed",
          inset: "0",
          "z-index": "50",
          display: "flex",
          "flex-direction": "column",
          background: "#0f172a",
          "clip-path": props.visible ? "inset(0)" : collapsedInset(),
          transition: "clip-path 300ms cubic-bezier(0.4, 0, 0.2, 1)",
          visibility: hidden() ? "hidden" : "visible",
          "pointer-events": props.visible ? "auto" : "none",
        }}
      >
        {/* Top bar */}
        <div
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "space-between",
            height: "44px",
            "padding-left": "16px",
            "padding-right": "12px",
            "border-bottom": "1px solid #1e293b",
            "flex-shrink": "0",
          }}
        >
          <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <line x1="12" y1="3" x2="12" y2="9" />
              <line x1="12" y1="15" x2="12" y2="21" />
              <line x1="3" y1="12" x2="9" y2="12" />
              <line x1="15" y1="12" x2="21" y2="12" />
            </svg>
            <span style={{ "font-size": "13px", "font-weight": "600", color: "#f1f5f9" }}>Atom Detail</span>
          </div>
          <button
            onClick={props.onClose}
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              width: "30px",
              height: "30px",
              border: "1px solid #334155",
              "border-radius": "6px",
              background: "transparent",
              color: "#94a3b8",
              cursor: "pointer",
              "font-size": "16px",
              transition: "background 0.15s, color 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "#1e293b"
              e.currentTarget.style.color = "#f1f5f9"
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent"
              e.currentTarget.style.color = "#94a3b8"
            }}
            title="Close (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Detail area: graph + optional side panel */}
        <div style={{ flex: "1", "min-height": "0", display: "flex" }}>
          <div style={{ flex: "1", "min-width": "0", position: "relative" }}>
            <AtomDetailView
              atoms={props.atoms}
              relations={props.relations}
              loading={props.loading}
              error={props.error}
              focusAtomId={props.focusAtomId}
              onAtomClick={(atomId) => setSelectedAtomId(atomId)}
              onAtomCreate={props.onAtomCreate}
              onAtomDelete={props.onAtomDelete}
              onRelationCreate={props.onRelationCreate}
              onRelationUpdate={props.onRelationUpdate}
              onRelationDelete={props.onRelationDelete}
              researchProjectId={props.researchProjectId}
            />
          </div>
          <Show when={selectedAtom()}>
            {(atom) => (
              <AtomDetailPanel
                atom={atom()}
                onClose={() => setSelectedAtomId(null)}
                onDelete={props.onAtomDelete}
              />
            )}
          </Show>
        </div>
      </div>
    </Portal>
  )
}
