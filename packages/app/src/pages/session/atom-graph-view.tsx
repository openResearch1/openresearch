import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Graph } from "@antv/g6"
import type { ResearchAtomsListResponse } from "@opencode-ai/sdk/v2"
import { GraphState, GraphStateManager } from "./graph-state-manager"

type Atom = ResearchAtomsListResponse["atoms"][number]
type Relation = ResearchAtomsListResponse["relations"][number]
type RelationType = keyof typeof RELATION_LABELS

const TYPE_COLORS: Record<string, string> = {
  fact: "#60a5fa",
  method: "#34d399",
  theorem: "#f87171",
  verification: "#fbbf24",
}

const RELATION_COLORS: Record<string, string> = {
  motivates: "#8b5cf6",
  formalizes: "#06b6d4",
  derives: "#f97316",
  analyzes: "#ec4899",
  validates: "#22c55e",
  contradicts: "#ef4444",
  other: "#94a3b8",
}

const TYPE_LABELS: Record<string, string> = {
  fact: "Fact",
  method: "Method",
  theorem: "Theorem",
  verification: "Verification",
}

const EVIDENCE_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  proven: "Proven",
  disproven: "Disproven",
}

const RELATION_LABELS: Record<string, string> = {
  motivates: "Motivates",
  formalizes: "Formalizes",
  derives: "Derives",
  analyzes: "Analyzes",
  validates: "Validates",
  contradicts: "Contradicts",
  other: "Other",
}

export function AtomGraphView(props: {
  atoms: Atom[]
  relations: Relation[]
  loading: boolean
  error: boolean
  onAtomClick: (atomId: string) => void
  onAtomDelete: (atomId: string) => Promise<void>
  onRelationCreate: (input: { sourceAtomId: string; targetAtomId: string; relationType: string }) => Promise<void>
  researchProjectId: string
}) {
  let containerRef: HTMLDivElement | undefined
  let graph: Graph | undefined
  let stateManager: GraphStateManager
  let hoverId = ""
  let anchorPinned = false
  let hideAnchorTimer: ReturnType<typeof setTimeout> | undefined

  const [containerReady, setContainerReady] = createSignal(false)
  const [state, setState] = createStore({
    hoverNodeId: "",
    anchorVisible: false,
    anchorX: 0,
    anchorY: 0,
    deleteVisible: false,
    deleteX: 0,
    deleteY: 0,
    active: false,
    dragging: false,
    sourceId: "",
    targetId: "",
    selectedIds: [] as string[],
    relationType: "" as "" | RelationType,
    relationX: 0,
    relationY: 0,
    saving: false,
    error: "",
    startX: 0,
    startY: 0,
    endX: 0,
    endY: 0,
    deleting: false,
    confirmOpen: false,
    deleteIds: [] as string[],
  })

  const setContainerRef = (el: HTMLDivElement) => {
    containerRef = el
    el.oncontextmenu = (evt) => {
      evt.preventDefault()
    }
    setContainerReady(true)
  }

  const clearHideAnchor = () => {
    if (!hideAnchorTimer) return
    clearTimeout(hideAnchorTimer)
    hideAnchorTimer = undefined
  }

  const getPoint = (id: string) => {
    if (!graph) return
    const pos = graph.getElementPosition(id)
    const point = graph.getViewportByCanvas(pos)
    return {
      x: point[0],
      y: point[1],
    }
  }

  const syncState = (id: string, next: string[]) => {
    if (!graph || !id) return
    void graph.setElementState(id, next)
  }

  const clearHover = () => {
    if (!hoverId) return
    syncState(hoverId, [])
    hoverId = ""
  }

  const hideAnchor = () => {
    clearHideAnchor()
    if (anchorPinned || state.dragging || state.active || state.confirmOpen) return
    setState({
      anchorVisible: false,
      hoverNodeId: "",
      deleteVisible: false,
    })
  }

  const scheduleAnchorHide = () => {
    clearHideAnchor()
    hideAnchorTimer = setTimeout(() => {
      hideAnchor()
    }, 120)
  }

  const showAnchor = (id: string) => {
    const point = getPoint(id)
    if (!point || state.dragging || state.active || state.confirmOpen) return

    clearHideAnchor()
    setState({
      hoverNodeId: id,
      anchorVisible: true,
      anchorX: point.x + 24,
      anchorY: point.y,
      deleteVisible: true,
      deleteX: point.x + 14,
      deleteY: point.y - 18,
    })
  }

  const beginDraft = (sourceId: string) => {
    const point = getPoint(sourceId)
    if (!point) return

    anchorPinned = false
    clearHover()
    syncState(sourceId, ["connect-source"])
    setState({
      anchorVisible: false,
      deleteVisible: false,
      hoverNodeId: "",
      dragging: true,
      sourceId,
      targetId: "",
      startX: point.x,
      startY: point.y,
      endX: point.x,
      endY: point.y,
      error: "",
    })
  }

  const moveDraft = (evt: any) => {
    if (!state.dragging || !containerRef) return

    const e = evt.originalEvent as MouseEvent | PointerEvent | undefined
    if (!e) return

    const rect = containerRef.getBoundingClientRect()
    setState({
      endX: e.clientX - rect.left,
      endY: e.clientY - rect.top,
    })
  }

  const resetDraft = () => {
    clearHover()
    if (state.sourceId) {
      syncState(state.sourceId, [])
    }
    setState({
      dragging: false,
      sourceId: "",
      targetId: "",
      startX: 0,
      startY: 0,
      endX: 0,
      endY: 0,
    })
  }

  const finishDraft = (targetId: string) => {
    if (!state.dragging || !state.sourceId || !targetId || state.sourceId === targetId) {
      resetDraft()
      return
    }

    const sourcePoint = getPoint(state.sourceId)
    const targetPoint = getPoint(targetId)

    clearHover()
    syncState(state.sourceId, [])

    setState({
      active: true,
      dragging: false,
      targetId,
      relationType: "",
      saving: false,
      error: "",
      relationX: sourcePoint && targetPoint ? (sourcePoint.x + targetPoint.x) / 2 : state.endX,
      relationY: sourcePoint && targetPoint ? (sourcePoint.y + targetPoint.y) / 2 : state.endY,
      startX: 0,
      startY: 0,
      endX: 0,
      endY: 0,
      anchorVisible: false,
      hoverNodeId: "",
    })
  }

  const closeDraft = () => {
    if (state.saving) return
    setState({
      active: false,
      dragging: false,
      sourceId: "",
      targetId: "",
      relationType: "",
      error: "",
      relationX: 0,
      relationY: 0,
      startX: 0,
      startY: 0,
      endX: 0,
      endY: 0,
    })
  }

  const closeMenu = () => {
    return
  }

  const hideTooltip = () => {
    const tooltip = document.getElementById("atom-tooltip")
    if (!tooltip) return
    if ((tooltip as any).cleanup) {
      ;(tooltip as any).cleanup()
    }
    tooltip.remove()
  }

  const graphOptions = {
    autoFit: "view" as const,
    padding: 10,
    node: {
      type: "circle",
      style: {
        size: 40,
        fill: "#1e293b",
        stroke: (d: any) => TYPE_COLORS[d.data?.type] ?? "#6366f1",
        lineWidth: 2,
        cursor: "pointer",
        shadowColor: "rgba(0,0,0,0.25)",
        shadowBlur: 8,
        shadowOffsetY: 2,
      },
      state: {
        active: {
          stroke: "#818cf8",
          lineWidth: 3,
          shadowColor: "rgba(99,102,241,0.4)",
          shadowBlur: 16,
        },
        "connect-source": {
          stroke: "#818cf8",
          lineWidth: 3,
          shadowColor: "rgba(99,102,241,0.35)",
          shadowBlur: 18,
        },
        "connect-target": {
          stroke: "#f8fafc",
          lineWidth: 4,
          shadowColor: "rgba(248,250,252,0.45)",
          shadowBlur: 20,
        },
        selected: {
          stroke: "#f8fafc",
          lineWidth: 4,
          shadowColor: "rgba(248,250,252,0.32)",
          shadowBlur: 18,
        },
      },
    },
    edge: {
      style: {
        stroke: (d: any) => RELATION_COLORS[d.data?.type] ?? "#94a3b8",
        lineWidth: 1.5,
        endArrow: true,
        endArrowSize: 6,
      },
      state: {
        active: {
          stroke: "#818cf8",
          lineWidth: 2.5,
        },
      },
    },
    layout: {
      type: "dagre" as const,
      rankdir: "TB",
      nodesep: 25,
      ranksep: 40,
    },
    behaviors: [
      { type: "drag-canvas", key: "drag-canvas" },
      { type: "zoom-canvas", key: "zoom-canvas" },
      { type: "drag-element", key: "drag-element", enable: true },
    ],
    animation: false,
  }

  onMount(() => {
    stateManager = new GraphStateManager(props.researchProjectId)
  })

  const toGraphData = () => {
    const nodes = props.atoms.map((atom) => ({
      id: atom.atom_id,
      data: {
        name: atom.atom_name,
        type: atom.atom_type,
        status: atom.atom_evidence_status,
      },
    }))

    const edges = props.relations.map((rel) => ({
      id: `${rel.atom_id_source}-${rel.relation_type}-${rel.atom_id_target}`,
      source: rel.atom_id_source,
      target: rel.atom_id_target,
      data: {
        type: rel.relation_type,
        note: rel.note,
      },
    }))

    return { nodes, edges }
  }

  const setupTooltip = () => {
    if (!graph) return

    const createTooltip = () => {
      let tooltip = document.getElementById("atom-tooltip")
      if (!tooltip) {
        tooltip = document.createElement("div")
        tooltip.id = "atom-tooltip"
        tooltip.style.cssText = `
          position: fixed;
          padding: 8px 12px;
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 6px;
          color: #e2e8f0;
          font-size: 12px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          pointer-events: none;
          z-index: 1000;
          max-width: 200px;
        `
        document.body.appendChild(tooltip)
      }
      return tooltip
    }

    const destroyTooltip = () => {
      const tooltip = document.getElementById("atom-tooltip")
      if (!tooltip) return
      if ((tooltip as any).cleanup) {
        ;(tooltip as any).cleanup()
      }
      tooltip.remove()
    }

    const updateTooltipPosition = (tooltip: HTMLElement, e: MouseEvent) => {
      const tooltipRect = tooltip.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      let left = e.clientX + 10
      let top = e.clientY + 10

      if (left + tooltipRect.width > viewportWidth) {
        left = e.clientX - tooltipRect.width - 10
      }

      if (top + tooltipRect.height > viewportHeight) {
        top = e.clientY - tooltipRect.height - 10
      }

      if (left < 0) left = 10
      if (top < 0) top = 10

      tooltip.style.left = `${left}px`
      tooltip.style.top = `${top}px`
    }

    graph.on("node:pointerenter", (evt: any) => {
      const nodeId = evt.target?.id
      if (nodeId) {
        showAnchor(nodeId)
        const atom = props.atoms.find((a) => a.atom_id === nodeId)
        if (atom) {
          const typeLabel = TYPE_LABELS[atom.atom_type] ?? atom.atom_type
          const statusLabel = EVIDENCE_STATUS_LABELS[atom.atom_evidence_status] ?? atom.atom_evidence_status
          const tooltip = createTooltip()

          tooltip.innerHTML = `
            <div style="font-weight: 600; margin-bottom: 4px;">${atom.atom_name}</div>
            <div style="color: #94a3b8; margin-bottom: 2px;">Type: ${typeLabel}</div>
            <div style="color: #94a3b8;">Status: ${statusLabel}</div>
          `

          updateTooltipPosition(tooltip, evt.originalEvent as MouseEvent)

          const handleMouseMove = (e: MouseEvent) => {
            updateTooltipPosition(tooltip, e)
          }

          document.addEventListener("mousemove", handleMouseMove)
          ;(tooltip as any).cleanup = () => {
            document.removeEventListener("mousemove", handleMouseMove)
          }
        }
      }
    })

    graph.on("node:pointerleave", () => {
      const tooltip = document.getElementById("atom-tooltip")
      if (tooltip) {
        if ((tooltip as any).cleanup) {
          ;(tooltip as any).cleanup()
        }
        tooltip.remove()
      }
      scheduleAnchorHide()
    })
  }

  const initGraph = () => {
    try {
      graph = new Graph({
        container: containerRef,
        data: toGraphData(),
        ...graphOptions,
      } as any)

      graph.on("node:click", (evt: any) => {
        if (state.dragging || state.active || state.confirmOpen) return
        const nodeId = evt.target?.id
        if (!nodeId) return
        const e = evt.originalEvent as MouseEvent | PointerEvent | undefined
        const multi = !!e && (("metaKey" in e && e.metaKey) || ("ctrlKey" in e && e.ctrlKey))
        const next = multi
          ? state.selectedIds.includes(nodeId)
            ? state.selectedIds.filter((id) => id !== nodeId)
            : [...state.selectedIds, nodeId]
          : [nodeId]
        setState("selectedIds", next)
      })

      graph.on("node:dblclick", (evt: any) => {
        if (state.dragging || state.active || state.confirmOpen) return
        const nodeId = evt.target?.id
        if (nodeId) props.onAtomClick(nodeId)
      })

      graph.on("node:pointermove", (evt: any) => {
        if (state.dragging) {
          moveDraft(evt)
          const nodeId = evt.target?.id
          if (!nodeId || nodeId === state.sourceId) {
            clearHover()
            return
          }
          if (hoverId === nodeId) return
          clearHover()
          hoverId = nodeId
          syncState(nodeId, ["connect-target"])
          return
        }

        const nodeId = evt.target?.id
        if (nodeId) {
          showAnchor(nodeId)
        }
      })

      graph.on("canvas:pointermove", (evt: any) => {
        if (!state.dragging) return
        moveDraft(evt)
        clearHover()
      })

      graph.on("node:pointerup", (evt: any) => {
        if (!state.dragging) return
        const nodeId = evt.target?.id
        finishDraft(nodeId)
      })

      graph.on("canvas:pointerup", () => {
        if (!state.dragging) return
        resetDraft()
      })

      graph.on("canvas:click", () => {
        hideAnchor()
        setState("selectedIds", [])
        if (state.active && !state.saving) {
          closeDraft()
        }
      })

      graph.on("node:dragend", () => {
        saveCurrentState()
      })

      graph.on("viewportchange", () => {
        saveCurrentState()
      })

      setupTooltip()
      const graphState = stateManager?.loadState()
      if (graphState == null) {
        graph.render().then(() => {
          saveCurrentState()
        })
      } else {
        applySavedPositions(graphState).then(() => {})
      }
    } catch {
      if (graph) {
        graph.destroy()
        graph = undefined
      }
    }
  }

  const applySavedPositions = async (savedState: GraphState) => {
    if (!graph || !stateManager || !savedState?.positions) return

    const updateData = {
      nodes: [] as any[],
      edges: [] as any[],
    }

    Object.entries(savedState.positions).forEach(([atomId, position]) => {
      updateData.nodes.push({
        id: atomId,
        style: {
          x: position.x,
          y: position.y,
        },
      })
    })

    const ids = new Set<string>()
    props.atoms.forEach((atom) => {
      ids.add(atom.atom_id)
    })

    const filteredNodes = updateData.nodes.filter((node) => ids.has(node.id))
    if (filteredNodes.length <= 0) return

    try {
      graph.updateNodeData(filteredNodes)
      await graph.draw()
      await graph.fitView()
    } catch {}
  }

  const saveCurrentState = () => {
    if (!graph || !stateManager) return

    try {
      const positions: Record<string, { x: number; y: number }> = {}
      if (graph.getNodeData().length === 0) {
        stateManager.clearState()
        return
      }

      graph.getNodeData().forEach((node: any) => {
        if (node.id && node.style) {
          positions[node.id] = {
            x: node.style.x || 0,
            y: node.style.y || 0,
          }
        }
      })

      const zoom = graph.getZoom()
      const viewport = graph.getCanvasCenter()
      stateManager.saveState(positions, {
        zoom,
        centerX: viewport[0],
        centerY: viewport[1],
      })
    } catch (error) {
      console.warn("Failed to save graph state:", error)
    }
  }

  const triggerAutoLayout = async () => {
    if (!graph || !stateManager) return
    stateManager.clearState()
    await graph.layout()
    await graph.fitView()
    await graph.render()
    saveCurrentState()
  }

  const updateGraph = () => {
    if (!graph || !containerRef) return

    try {
      graph.setData(toGraphData())
      const graphState = stateManager.loadState()
      if (graphState == null) {
        graph.render().then(() => {
          saveCurrentState()
        })
      } else {
        applySavedPositions(graphState).then(() => {})
      }
    } catch {}
  }

  createEffect(() => {
    const atoms = props.atoms
    const relations = props.relations
    const ready = containerReady()

    if (!ready || !containerRef) return

    if (!graph) {
      initGraph()
      return
    }

    updateGraph()
  })

  createEffect(() => {
    const selected = state.selectedIds
    if (!graph) return

    const ids = new Set(selected)
    props.atoms.forEach((atom) => {
      if (atom.atom_id === state.sourceId && state.dragging) return
      if (atom.atom_id === hoverId) return
      void graph!.setElementState(atom.atom_id, ids.has(atom.atom_id) ? ["selected"] : [])
    })
  })

  createEffect(() => {
    const deleting = state.deleting
    const confirmOpen = state.confirmOpen

    const onKey = (evt: KeyboardEvent) => {
      if (
        !containerRef ||
        state.selectedIds.length === 0 ||
        state.active ||
        state.dragging ||
        deleting ||
        confirmOpen
      ) {
        return
      }
      const target = evt.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return
      if (evt.key !== "Delete" && evt.key !== "Backspace") return
      evt.preventDefault()
      setState("deleteIds", [...state.selectedIds])
      setState("confirmOpen", true)
      setState("anchorVisible", false)
      setState("deleteVisible", false)
    }

    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  onCleanup(() => {
    clearHideAnchor()
    if (graph) {
      saveCurrentState()
    }

    const tooltip = document.getElementById("atom-tooltip")
    if (tooltip) {
      if ((tooltip as any).cleanup) {
        ;(tooltip as any).cleanup()
      }
      tooltip.remove()
    }

    if (graph) {
      try {
        graph.destroy()
      } catch (error) {
        console.warn("Error destroying graph:", error)
      }
      graph = undefined
    }
  })

  const legendItems = Object.entries(TYPE_LABELS).map(([type, label]) => ({
    type,
    label,
    color: TYPE_COLORS[type],
  }))

  const relationLegendItems = Object.entries(RELATION_LABELS).map(([type, label]) => ({
    type,
    label,
    color: RELATION_COLORS[type],
  }))

  const relationMenu = () => {
    if (!containerRef) {
      return {
        left: state.relationX,
        top: state.relationY,
        up: true,
      }
    }

    const width = 188
    const height = state.error ? 88 : 44
    const gap = 12
    const pad = 8
    const maxX = containerRef.clientWidth - width / 2 - pad
    const minX = width / 2 + pad
    const preferUp = state.relationY - height - gap >= pad
    const up = preferUp || state.relationY + height + gap > containerRef.clientHeight - pad
    const left = Math.min(Math.max(state.relationX, minX), maxX)
    const top = up
      ? Math.max(state.relationY - height / 2 - gap, height / 2 + pad)
      : Math.min(state.relationY + height / 2 + gap, containerRef.clientHeight - height / 2 - pad)

    return { left, top, up }
  }

  const source = () => props.atoms.find((item) => item.atom_id === state.sourceId)
  const target = () => props.atoms.find((item) => item.atom_id === state.targetId)
  const deleteAtoms = () => props.atoms.filter((item) => state.deleteIds.includes(item.atom_id))

  const submitRelation = async () => {
    if (state.saving || !state.sourceId || !state.targetId || !state.relationType) return

    setState("saving", true)
    setState("error", "")

    try {
      await props.onRelationCreate({
        sourceAtomId: state.sourceId,
        targetAtomId: state.targetId,
        relationType: state.relationType,
      })
      setState({
        active: false,
        dragging: false,
        sourceId: "",
        targetId: "",
        relationType: "",
        saving: false,
        error: "",
        relationX: 0,
        relationY: 0,
        startX: 0,
        startY: 0,
        endX: 0,
        endY: 0,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create relation"
      setState("saving", false)
      setState("error", message)
    }
  }

  const removeAtom = async () => {
    if (state.deleteIds.length === 0 || state.deleting) return

    setState("deleting", true)
    try {
      for (const id of state.deleteIds) {
        await props.onAtomDelete(id)
      }
      setState({
        confirmOpen: false,
        deleting: false,
        deleteIds: [],
        selectedIds: [],
      })
    } catch {
      setState("deleting", false)
    }
  }

  return (
    <div ref={setContainerRef} class="w-full h-full min-h-[400px] relative" onClick={() => closeMenu()}>
      <Show when={state.dragging}>
        <svg class="absolute inset-0 z-20 pointer-events-none overflow-visible">
          <line
            x1={state.startX}
            y1={state.startY}
            x2={state.endX}
            y2={state.endY}
            stroke="#818cf8"
            stroke-width="2"
            stroke-dasharray="6 4"
            stroke-linecap="round"
          />
        </svg>
      </Show>
      <Show when={state.anchorVisible && !state.dragging && !state.active}>
        <button
          class="absolute z-20 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border-interactive-base/70 bg-background-strong/90 text-[12px] font-medium text-text-interactive-base shadow-lg transition-transform hover:scale-110"
          style={{
            left: `${state.anchorX}px`,
            top: `${state.anchorY}px`,
          }}
          onMouseEnter={() => {
            anchorPinned = true
            clearHideAnchor()
          }}
          onMouseLeave={() => {
            anchorPinned = false
            scheduleAnchorHide()
          }}
          onMouseDown={(evt) => {
            evt.preventDefault()
            evt.stopPropagation()
            if (!state.hoverNodeId) return
            beginDraft(state.hoverNodeId)
          }}
          title="Create relation"
        >
          +
        </button>
      </Show>
      <Show when={state.deleteVisible && !state.dragging && !state.active && state.hoverNodeId}>
        <button
          class="absolute z-20 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-surface-raised-base/80 text-[12px] text-text-weak shadow-lg transition-colors hover:text-icon-critical-hover"
          style={{
            left: `${state.deleteX}px`,
            top: `${state.deleteY}px`,
          }}
          onMouseEnter={() => {
            anchorPinned = true
            clearHideAnchor()
          }}
          onMouseLeave={() => {
            anchorPinned = false
            scheduleAnchorHide()
          }}
          onClick={(evt) => {
            evt.preventDefault()
            evt.stopPropagation()
            if (!state.hoverNodeId) return
            hideTooltip()
            setState("selectedIds", [state.hoverNodeId])
            setState("deleteIds", [state.hoverNodeId])
            setState("confirmOpen", true)
            setState("anchorVisible", false)
            setState("deleteVisible", false)
          }}
          title="Delete atom"
        >
          ×
        </button>
      </Show>
      <div class="absolute bottom-4 right-4 z-20 bg-surface-raised-base/90 backdrop-blur-sm rounded-lg px-3 py-2 border border-border-weak-base">
        <div class="text-[10px] text-text-weak mb-2 font-medium">ATOM TYPES</div>
        <div class="flex flex-col gap-1.5 mb-3">
          {legendItems.map((item) => (
            <div class="flex items-center gap-2">
              <div class="w-3 h-3 rounded-full" style={{ background: item.color }} />
              <span class="text-xs text-text-base">{item.label}</span>
            </div>
          ))}
        </div>
        <div class="border-t border-border-weak-base pt-2">
          <div class="text-[10px] text-text-weak mb-2 font-medium">RELATIONS</div>
          <div class="flex flex-col gap-1.5">
            {relationLegendItems.map((item) => (
              <div class="flex items-center gap-2">
                <div class="w-3 h-0.5 rounded-full" style={{ background: item.color }} />
                <span class="text-xs text-text-base">{item.label}</span>
              </div>
            ))}
          </div>
        </div>
        <button
          onClick={() => triggerAutoLayout()}
          class="mt-3 w-full px-2 py-1.5 text-xs bg-surface-weak hover:bg-surface-weaker text-text-base rounded transition-colors flex items-center justify-center gap-1"
        >
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          Auto Layout
        </button>
      </div>
      <Show when={props.loading}>
        <div class="absolute inset-0 flex items-center justify-center bg-background-strong/80 z-10">
          <div class="text-text-weak">Loading graph...</div>
        </div>
      </Show>
      <Show when={state.active}>
        <div
          class="absolute z-30 w-[188px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/8 bg-[linear-gradient(180deg,rgba(84,101,126,0.34),rgba(37,46,60,0.22))] shadow-[0_12px_24px_rgba(0,0,0,0.20)] backdrop-blur-2xl px-2.5 py-1"
          style={{
            left: `${relationMenu().left}px`,
            top: `${relationMenu().top}px`,
          }}
          onClick={(evt) => evt.stopPropagation()}
        >
          <div class="relative">
            <select
              value={state.relationType}
              onInput={(evt) => {
                const value = evt.currentTarget.value as RelationType
                setState("relationType", value)
                void submitRelation()
              }}
              class="w-full appearance-none bg-transparent px-3 py-1.5 pr-8 text-[13px] font-medium tracking-[0.01em] text-text-strong outline-none"
            >
              <option value="" disabled>
                Select relation
              </option>
              {Object.entries(RELATION_LABELS).map(([value, label]) => (
                <option value={value}>{label}</option>
              ))}
            </select>
            <div class="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-text-weak">
              <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7">
                <path d="M5 7.5L10 12.5L15 7.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </div>
          </div>
          <Show when={state.error}>
            <div class="mt-1 rounded-2xl border border-border-critical-base/20 bg-surface-critical-base/10 px-2.5 py-1.5 text-[11px] text-text-on-critical-base">
              {state.error}
            </div>
          </Show>
        </div>
      </Show>
      <Show when={state.confirmOpen}>
        <div class="absolute inset-0 z-30 flex items-center justify-center bg-background-strong/70 backdrop-blur-[1px]">
          <div class="w-[360px] rounded-xl border border-border-weak-base bg-surface-float-base shadow-2xl p-4">
            <div class="text-sm font-medium text-text-strong">Delete Atom</div>
            <div class="mt-3 text-sm text-text-base">
              Delete{" "}
              <span class="text-text-strong">
                {deleteAtoms().length === 1
                  ? (deleteAtoms()[0]?.atom_name ?? state.deleteIds[0]?.slice(0, 8))
                  : `${state.deleteIds.length} atoms`}
              </span>{" "}
              and all related relations, local files, and linked sessions?
            </div>
            <div class="mt-2 text-xs text-text-weaker">This action cannot be undone.</div>
            <div class="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() =>
                  setState({
                    confirmOpen: false,
                    deleting: false,
                    deleteIds: [],
                  })
                }
                disabled={state.deleting}
                class="px-3 py-1.5 text-xs rounded bg-surface-raised-base text-text-base hover:bg-surface-raised-base-hover disabled:opacity-60 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => removeAtom()}
                disabled={state.deleting}
                class="px-3 py-1.5 text-xs rounded bg-surface-critical-strong text-text-on-critical-base hover:bg-surface-critical-strong disabled:opacity-60 transition-colors"
              >
                {state.deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      </Show>
      <Show when={props.error}>
        <div class="absolute inset-0 flex items-center justify-center bg-background-strong/80 z-10">
          <div class="text-icon-critical-base">Error loading graph</div>
        </div>
      </Show>
      <Show when={!props.loading && !props.error && props.atoms.length === 0}>
        <div class="absolute inset-0 flex items-center justify-center bg-background-strong/80 z-10">
          <div class="text-text-weak">No atoms to display</div>
        </div>
      </Show>
    </div>
  )
}
