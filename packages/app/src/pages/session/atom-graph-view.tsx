import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Graph } from "@antv/g6"
import type { ResearchAtomsListResponse } from "@opencode-ai/sdk/v2"
import { type GraphState, GraphStateManager } from "./graph-state-manager"

type Atom = ResearchAtomsListResponse["atoms"][number]
type Relation = ResearchAtomsListResponse["relations"][number]
type AtomKind = "fact" | "method" | "theorem" | "verification"
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

const STATUS_COLORS: Record<string, string> = {
  pending: "#64748b",
  in_progress: "#f59e0b",
  proven: "#22c55e",
  disproven: "#f87171",
}

const STATUS_DOT_BG: Record<string, string> = {
  pending: "rgba(100,116,139,0.15)",
  in_progress: "rgba(245,158,11,0.15)",
  proven: "rgba(34,197,94,0.15)",
  disproven: "rgba(248,113,113,0.15)",
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

const NODE_SIZE_MIN = 28
const NODE_SIZE_MAX = 60

const relationId = (rel: Pick<Relation, "atom_id_source" | "atom_id_target" | "relation_type">) =>
  `${rel.atom_id_source}-${rel.relation_type}-${rel.atom_id_target}`

export function AtomGraphView(props: {
  atoms: Atom[]
  relations: Relation[]
  loading: boolean
  error: boolean
  onAtomClick: (atomId: string) => void
  onAtomCreate: (input: { name: string; type: AtomKind }) => Promise<Atom>
  onAtomDelete: (atomId: string) => Promise<void>
  onRelationCreate: (input: { sourceAtomId: string; targetAtomId: string; relationType: string }) => Promise<void>
  onRelationUpdate: (input: {
    sourceAtomId: string
    targetAtomId: string
    relationType: string
    nextRelationType: string
  }) => Promise<void>
  onRelationDelete: (input: { sourceAtomId: string; targetAtomId: string; relationType: string }) => Promise<void>
  onAtomViewDetail?: (atomId: string) => void
  researchProjectId: string
}) {
  let containerRef: HTMLDivElement | undefined
  let graph: Graph | undefined
  let stateManager: GraphStateManager
  let ro: ResizeObserver | undefined
  let hoverId = ""
  let hoverRelationId = ""
  let hoverNodeId = ""
  let anchorPinned = false
  let hideAnchorTimer: ReturnType<typeof setTimeout> | undefined
  let dimDebounceTimer: ReturnType<typeof setTimeout> | undefined
  let pendingDimNodeId = "" // "" = schedule clear, non-empty = schedule apply
  let buildTooltipFn: ((nodeId: string, mouseEvent?: MouseEvent) => void) | undefined

  const [containerReady, setContainerReady] = createSignal(false)
  const [state, setState] = createStore({
    hoverNodeId: "",
    anchorVisible: false,
    anchorX: 0,
    anchorY: 0,
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
    selectedRelationId: "",
    relationSourceId: "",
    relationTargetId: "",
    relationPrevType: "" as "" | RelationType,
    relationDeleting: false,
    focusedNodeId: "", // pinned node: dim effect locked, info card stays visible
    layoutType: "force" as "force" | "radial" | "circular" | "dagre",
    layoutMenuOpen: false,
    createOpen: false,
    createX: 0,
    createY: 0,
    createNodeX: 0,
    createNodeY: 0,
    createName: "",
    createType: "fact" as AtomKind,
    createSaving: false,
    createError: "",
    pendingAtomId: "",
    pendingAtomX: 0,
    pendingAtomY: 0,
  })

  const setContainerRef = (el: HTMLDivElement) => {
    containerRef = el
    el.oncontextmenu = (evt) => {
      evt.preventDefault()
    }
    setContainerReady(true)
  }

  const frame = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })

  const syncSize = () => {
    if (!graph || !containerRef) return false

    const width = containerRef.clientWidth
    const height = containerRef.clientHeight

    if (width <= 0 || height <= 0) return false

    graph.resize(width, height)
    return true
  }

  const fit = async () => {
    if (!graph) return
    if (!syncSize()) return

    await frame()

    if (!graph || !syncSize()) return
    await graph.fitView()
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

  const getNeighborIds = (nodeId: string): Set<string> => {
    const neighbors = new Set<string>()
    for (const rel of props.relations) {
      if (rel.atom_id_source === nodeId) neighbors.add(rel.atom_id_target)
      else if (rel.atom_id_target === nodeId) neighbors.add(rel.atom_id_source)
    }
    return neighbors
  }

  const applyDimEffect = (nodeId: string) => {
    if (!graph) return
    const neighbors = getNeighborIds(nodeId)
    neighbors.add(nodeId)
    // Single batch call: set hover, clear neighbors, dim the rest — no intermediate flash
    const allStates: Record<string, string[]> = {}
    for (const n of graph.getNodeData()) {
      const id = String(n.id)
      allStates[id] = id === nodeId ? ["hover"] : neighbors.has(id) ? [] : ["dimmed"]
    }
    for (const e of graph.getEdgeData()) {
      const id = String(e.id)
      allStates[id] = e.source === nodeId || e.target === nodeId ? [] : ["dimmed"]
    }
    void graph.setElementState(allStates, true)
  }

  const clearDimEffect = () => {
    if (!graph) return
    const allStates: Record<string, string[]> = {}
    for (const n of graph.getNodeData()) allStates[String(n.id)] = []
    for (const e of graph.getEdgeData()) allStates[String(e.id)] = []
    void graph.setElementState(allStates, true)
  }

  const clearHover = () => {
    if (!hoverId) return
    syncState(hoverId, [])
    hoverId = ""
  }

  const clearRelationHover = () => {
    if (hoverRelationId) {
      syncState(hoverRelationId, [])
    }
    hoverRelationId = ""
  }

  const clearNodeHover = () => {
    if (hoverNodeId) {
      syncState(hoverNodeId, [])
    }
    hoverNodeId = ""
  }

  // Debounced dim effect: waits 110ms of inactivity before applying/clearing,
  // so rapid mouse movement between nodes doesn't cause jarring flashes.
  const scheduleDimEffect = (nodeId: string) => {
    clearTimeout(dimDebounceTimer)
    pendingDimNodeId = nodeId
    dimDebounceTimer = setTimeout(() => {
      if (state.focusedNodeId) return // focused node manages its own dim
      if (pendingDimNodeId) {
        applyDimEffect(pendingDimNodeId)
      } else {
        clearDimEffect()
      }
    }, 110)
  }

  const hideAnchor = () => {
    clearHideAnchor()
    if (anchorPinned || state.dragging || state.active || state.selectedRelationId || state.confirmOpen) return
    setState({ anchorVisible: false, hoverNodeId: "" })
  }

  const closeCreateForm = () => {
    setState({
      createOpen: false,
      createName: "",
      createType: "fact",
      createSaving: false,
      createError: "",
    })
  }

  const resetNodeVisualState = () => {
    clearHideAnchor()
    clearTimeout(dimDebounceTimer)
    pendingDimNodeId = ""
    anchorPinned = false
    clearHover()
    clearNodeHover()
    clearRelationHover()
    hideTooltip()
    clearDimEffect()
    setState({
      anchorVisible: false,
      hoverNodeId: "",
      focusedNodeId: "",
      selectedIds: [],
    })
  }

  const cancelAtomDelete = () => {
    resetNodeVisualState()
    setState({
      confirmOpen: false,
      deleting: false,
      deleteIds: [],
    })
  }

  const openCreateForm = (evt: MouseEvent | PointerEvent) => {
    if (!containerRef || !graph) return
    const rect = containerRef.getBoundingClientRect()
    const x = evt.clientX - rect.left
    const y = evt.clientY - rect.top
    const pad = 16
    const w = 260
    const h = 230
    const point = (graph as any).getCanvasByViewport?.([x, y]) ?? [x, y]

    hideAnchor()
    closeMenu()
    clearHover()
    clearNodeHover()
    clearRelationHover()
    setState({
      selectedIds: [],
      focusedNodeId: "",
      layoutMenuOpen: false,
      selectedRelationId: "",
      active: false,
      createOpen: true,
      createX: Math.min(Math.max(x, pad), Math.max(pad, rect.width - w - pad)),
      createY: Math.min(Math.max(y, pad), Math.max(pad, rect.height - h - pad)),
      createNodeX: point[0],
      createNodeY: point[1],
      createName: "",
      createType: "fact",
      createSaving: false,
      createError: "",
    })
  }

  const submitCreateAtom = async () => {
    if (state.createSaving) return
    const name = state.createName.trim()
    if (!name) {
      setState("createError", "Name is required")
      return
    }

    setState({ createSaving: true, createError: "" })
    try {
      const atom = await props.onAtomCreate({
        name,
        type: state.createType,
      })
      setState({
        createOpen: false,
        createName: "",
        createSaving: false,
        createError: "",
        pendingAtomId: atom.atom_id,
        pendingAtomX: state.createNodeX,
        pendingAtomY: state.createNodeY,
      })
    } catch (error) {
      setState({
        createSaving: false,
        createError: error instanceof Error ? error.message : "Failed to create atom",
      })
    }
  }

  const placePendingAtom = async () => {
    if (!graph || !state.pendingAtomId) return

    for (let i = 0; i < 12; i++) {
      const ok = graph.getNodeData().some((node: any) => String(node.id) === state.pendingAtomId)
      if (!ok) {
        await frame()
        continue
      }

      try {
        graph.updateNodeData([
          {
            id: state.pendingAtomId,
            style: {
              x: state.pendingAtomX,
              y: state.pendingAtomY,
            },
          },
        ])
        await graph.draw()
        applyDimEffect(state.pendingAtomId)
        setState({ selectedIds: [state.pendingAtomId], focusedNodeId: state.pendingAtomId })
        showAnchor(state.pendingAtomId)
        saveCurrentState()
      } catch {
      } finally {
        setState({
          pendingAtomId: "",
          pendingAtomX: 0,
          pendingAtomY: 0,
        })
      }
      return
    }
  }

  const showAnchor = (id: string) => {
    const point = getPoint(id)
    if (!point || state.dragging || state.active || state.selectedRelationId || state.confirmOpen) return

    clearHideAnchor()
    setState({
      hoverNodeId: id,
      anchorVisible: true,
      anchorX: point.x - 24,
      anchorY: point.y,
    })
  }

  const beginDraft = (sourceId: string) => {
    const point = getPoint(sourceId)
    if (!point) return

    resetNodeVisualState()
    anchorPinned = false
    syncState(sourceId, ["connect-source"])
    setState({
      anchorVisible: false,
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
    clearHideAnchor()
    clearTimeout(dimDebounceTimer)
    pendingDimNodeId = ""
    anchorPinned = false
    clearHover()
    clearNodeHover()
    clearRelationHover()
    hideTooltip()
    clearDimEffect()
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
      anchorVisible: false,
      hoverNodeId: "",
      focusedNodeId: "",
      selectedIds: [],
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

  const closeMenu = () => {
    if (state.saving || state.relationDeleting) return

    clearHideAnchor()
    clearTimeout(dimDebounceTimer)
    pendingDimNodeId = ""
    anchorPinned = false
    clearHover()
    clearNodeHover()
    clearRelationHover()
    hideTooltip()
    clearDimEffect()
    if (state.sourceId) {
      syncState(state.sourceId, [])
    }

    setState({
      active: false,
      dragging: false,
      sourceId: "",
      targetId: "",
      selectedRelationId: "",
      relationSourceId: "",
      relationTargetId: "",
      relationPrevType: "",
      relationType: "",
      error: "",
      relationX: 0,
      relationY: 0,
      startX: 0,
      startY: 0,
      endX: 0,
      endY: 0,
      anchorVisible: false,
      hoverNodeId: "",
      focusedNodeId: "",
      selectedIds: [],
    })
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
        size: (d: any) => d.data?.size ?? 40,
        fill: "#1e293b",
        fillOpacity: 1,
        stroke: (d: any) => TYPE_COLORS[d.data?.type] ?? "#6366f1",
        strokeOpacity: 1,
        lineWidth: 2,
        cursor: "pointer",
        shadowColor: "rgba(0,0,0,0.25)",
        shadowBlur: 8,
        shadowOffsetY: 2,
      },
      state: {
        hover: {
          size: (d: any) => (d.data?.size ?? 40) + 16,
          stroke: "#f8fafc",
          lineWidth: 4,
          shadowColor: "rgba(248,250,252,0.32)",
          shadowBlur: 18,
        },
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
          size: (d: any) => (d.data?.size ?? 40) + 12,
          stroke: "#f8fafc",
          lineWidth: 4,
          shadowColor: "rgba(248,250,252,0.45)",
          shadowBlur: 20,
        },
        dimmed: {
          fillOpacity: 0.15,
          strokeOpacity: 0.12,
          size: (d: any) => Math.max(14, Math.round((d.data?.size ?? 40) * 0.6)),
          lineWidth: 1,
          shadowBlur: 0,
        },
      },
      animation: {
        update: [
          {
            fields: ["size", "fillOpacity", "strokeOpacity", "lineWidth", "shadowBlur"],
            duration: 600,
            easing: "ease-in-out",
          },
        ],
      },
    },
    edge: {
      style: {
        stroke: (d: any) => RELATION_COLORS[d.data?.type] ?? "#94a3b8",
        fillOpacity: 1,
        strokeOpacity: 1,
        lineWidth: 1.5,
        endArrow: true,
        endArrowSize: 6,
      },
      state: {
        hover: {
          stroke: "#e2e8f0",
          lineWidth: 3,
        },
        dimmed: {
          fillOpacity: 0.08,
          strokeOpacity: 0.08,
          lineWidth: 0.5,
        },
      },
      animation: {
        update: [{ fields: ["fillOpacity", "strokeOpacity", "lineWidth"], duration: 600, easing: "ease-in-out" }],
      },
    },
    layout: {
      type: "force" as const,
      linkDistance: 150,
      nodeStrength: 30,
      edgeStrength: 200,
      preventOverlap: true,
      nodeSize: 60,
      nodeSpacing: 20,
      coulombDisScale: 0.003,
    },
    behaviors: [
      { type: "drag-canvas", key: "drag-canvas" },
      { type: "zoom-canvas", key: "zoom-canvas" },
      { type: "drag-element", key: "drag-element", enable: true },
    ],
    animation: { duration: 600, easing: "ease-in-out" },
  }

  onMount(() => {
    stateManager = new GraphStateManager(props.researchProjectId)
    if (!containerRef) return

    ro = new ResizeObserver(() => {
      syncSize()
    })
    ro.observe(containerRef)
  })

  // Reinitialize stateManager when researchProjectId changes
  createEffect(() => {
    const projectId = props.researchProjectId
    if (stateManager && stateManager.getProjectId() !== projectId) {
      stateManager = new GraphStateManager(projectId)
      if (graph) {
        const graphState = stateManager.loadState()
        if (graphState == null) {
          graph.render().then(() => {
            saveCurrentState()
          })
        } else {
          applySavedPositions(graphState).then(() => {})
        }
      }
    }
  })

  const toGraphData = () => {
    // Compute 2nd-order degree for each node (unique nodes reachable within 2 hops)
    const adj = new Map<string, Set<string>>()
    for (const atom of props.atoms) adj.set(atom.atom_id, new Set())
    for (const rel of props.relations) {
      adj.get(rel.atom_id_source)?.add(rel.atom_id_target)
      adj.get(rel.atom_id_target)?.add(rel.atom_id_source)
    }
    const degree2 = new Map<string, number>()
    for (const [id, neighbors] of adj) {
      const reach = new Set<string>(neighbors)
      for (const nb of neighbors) {
        for (const nb2 of adj.get(nb) ?? []) {
          if (nb2 !== id) reach.add(nb2)
        }
      }
      degree2.set(id, reach.size)
    }
    const maxDeg = Math.max(1, ...degree2.values())
    const nodeSize = (id: string) => {
      const d = degree2.get(id) ?? 0
      return Math.round(NODE_SIZE_MIN + (d / maxDeg) * (NODE_SIZE_MAX - NODE_SIZE_MIN))
    }

    const nodes = props.atoms.map((atom) => ({
      id: atom.atom_id,
      data: {
        name: atom.atom_name,
        type: atom.atom_type,
        status: atom.atom_evidence_status,
        size: nodeSize(atom.atom_id),
      },
    }))

    const edges = props.relations.map((rel) => ({
      id: relationId(rel),
      source: rel.atom_id_source,
      target: rel.atom_id_target,
      data: {
        sourceId: rel.atom_id_source,
        targetId: rel.atom_id_target,
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
          pointer-events: none;
          z-index: 1000;
          max-width: 260px;
          opacity: 0;
          transform: translateY(4px) scale(0.97);
          transition: opacity 0.15s ease, transform 0.15s ease;
        `
        document.body.appendChild(tooltip)
        requestAnimationFrame(() => {
          tooltip!.style.opacity = "1"
          tooltip!.style.transform = "translateY(0) scale(1)"
        })
      }
      return tooltip
    }

    const updateTooltipPosition = (tooltip: HTMLElement, e: MouseEvent) => {
      const tooltipRect = tooltip.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const offset = 16

      let left = e.clientX + offset
      let top = e.clientY + offset

      if (left + tooltipRect.width > viewportWidth - 8) {
        left = e.clientX - tooltipRect.width - offset
      }
      if (top + tooltipRect.height > viewportHeight - 8) {
        top = e.clientY - tooltipRect.height - offset
      }
      if (left < 8) left = 8
      if (top < 8) top = 8

      tooltip.style.left = `${left}px`
      tooltip.style.top = `${top}px`
    }

    const buildTooltip = (nodeId: string, mouseEvent?: MouseEvent) => {
      const atom = props.atoms.find((a) => a.atom_id === nodeId)
      if (!atom) return
      const typeColor = TYPE_COLORS[atom.atom_type] ?? "#6366f1"
      const typeLabel = TYPE_LABELS[atom.atom_type] ?? atom.atom_type
      const statusColor = STATUS_COLORS[atom.atom_evidence_status] ?? "#64748b"
      const statusBg = STATUS_DOT_BG[atom.atom_evidence_status] ?? "rgba(100,116,139,0.15)"
      const statusLabel = EVIDENCE_STATUS_LABELS[atom.atom_evidence_status] ?? atom.atom_evidence_status
      const evTypeLabel =
        atom.atom_evidence_type === "math"
          ? "Math"
          : atom.atom_evidence_type === "experiment"
            ? "Experiment"
            : atom.atom_evidence_type

      // Remove any existing tooltip first
      const existing = document.getElementById("atom-tooltip")
      if (existing) {
        if ((existing as any).cleanup) (existing as any).cleanup()
        existing.remove()
      }

      const tooltip = createTooltip()
      tooltip.innerHTML = `
        <div style="
          background: rgba(15,23,42,0.92);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(255,255,255,0.08);
          border-left: 3px solid ${typeColor};
          border-radius: 10px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.04) inset;
          overflow: hidden;
        ">
          <div style="padding: 12px 14px 10px;">
            <div style="
              font-size: 13px;
              font-weight: 600;
              color: #f1f5f9;
              line-height: 1.4;
              margin-bottom: 10px;
              word-break: break-word;
            ">${atom.atom_name}</div>
            <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
              <span style="
                display: inline-flex; align-items: center; gap: 4px;
                padding: 2px 8px;
                background: ${typeColor}1a;
                border: 1px solid ${typeColor}40;
                border-radius: 999px;
                font-size: 11px;
                font-weight: 500;
                color: ${typeColor};
                letter-spacing: 0.02em;
              ">
                <span style="width:6px;height:6px;border-radius:50%;background:${typeColor};flex-shrink:0;"></span>
                ${typeLabel}
              </span>
              <span style="
                display: inline-flex; align-items: center; gap: 4px;
                padding: 2px 8px;
                background: ${statusBg};
                border: 1px solid ${statusColor}40;
                border-radius: 999px;
                font-size: 11px;
                font-weight: 500;
                color: ${statusColor};
                letter-spacing: 0.02em;
              ">
                <span style="width:6px;height:6px;border-radius:50%;background:${statusColor};flex-shrink:0;"></span>
                ${statusLabel}
              </span>
            </div>
          </div>
          ${
            evTypeLabel
              ? `
          <div style="
            padding: 7px 14px;
            border-top: 1px solid rgba(255,255,255,0.06);
            background: rgba(255,255,255,0.02);
            font-size: 11px;
            color: #64748b;
            display: flex; align-items: center; gap: 6px;
          ">
            <span style="color:#475569;">Evidence</span>
            <span style="color:#94a3b8;font-weight:500;">${evTypeLabel}</span>
          </div>`
              : ""
          }
        </div>
      `

      if (mouseEvent) {
        updateTooltipPosition(tooltip, mouseEvent)
        const handleMouseMove = (e: MouseEvent) => updateTooltipPosition(tooltip, e)
        document.addEventListener("mousemove", handleMouseMove)
        ;(tooltip as any).cleanup = () => document.removeEventListener("mousemove", handleMouseMove)
      }
    }

    buildTooltipFn = buildTooltip

    graph.on("node:pointerenter", (evt: any) => {
      const nodeId = evt.target?.id
      if (nodeId) {
        hoverNodeId = nodeId
        if (!state.dragging && !state.active && !state.selectedRelationId && !state.confirmOpen) {
          scheduleDimEffect(nodeId)
        }
        if (state.focusedNodeId) return
        buildTooltip(nodeId, evt.originalEvent as MouseEvent)
      }
    })

    graph.on("node:pointerleave", () => {
      if (state.focusedNodeId) {
        // Keep dim locked on focused node; tooltip and toolbar stay pinned
        clearTimeout(dimDebounceTimer)
        applyDimEffect(state.focusedNodeId)
        hoverNodeId = ""
      } else {
        clearNodeHover()
        scheduleDimEffect("")
        const tooltip = document.getElementById("atom-tooltip")
        if (tooltip) {
          if ((tooltip as any).cleanup) {
            ;(tooltip as any).cleanup()
          }
          tooltip.remove()
        }
      }
    })
  }

  const initGraph = () => {
    try {
      graph = new Graph({
        container: containerRef,
        data: toGraphData(),
        ...graphOptions,
      } as any)
      syncSize()

      graph.on("node:click", (evt: any) => {
        if (state.dragging || state.active || state.confirmOpen || state.createOpen) return
        closeMenu()
        const nodeId = evt.target?.id
        if (!nodeId) return
        const e = evt.originalEvent as MouseEvent | PointerEvent | undefined
        const withCtrl = !!e && (("metaKey" in e && e.metaKey) || ("ctrlKey" in e && e.ctrlKey))
        // Ctrl+click: focus toggle (pin/unpin dim + tooltip)
        if (withCtrl) {
          const prevFocused = state.focusedNodeId
          if (prevFocused === nodeId) {
            // Unpin same node
            setState({ focusedNodeId: "", selectedIds: [] })
            clearDimEffect()
            hideAnchor()
            const tooltip = document.getElementById("atom-tooltip")
            if (tooltip) {
              if ((tooltip as any).cleanup) {
                ;(tooltip as any).cleanup()
              }
              tooltip.remove()
            }
          } else {
            // Pin new node (may be switching from another pinned node)
            setState({ focusedNodeId: nodeId, selectedIds: [nodeId] })
            applyDimEffect(nodeId)
            showAnchor(nodeId)
            // Build tooltip for new node, frozen at click position
            buildTooltipFn?.(nodeId, e as MouseEvent | undefined)
          }
          return
        }
        // Plain click: navigate to atom detail
        resetNodeVisualState()
        props.onAtomViewDetail?.(nodeId)
      })

      graph.on("edge:click", (evt: any) => {
        if (state.dragging || state.active || state.confirmOpen || state.createOpen || !containerRef) return
        const edgeId = evt.target?.id
        if (!edgeId) return
        const rel = props.relations.find((item) => relationId(item) === edgeId)
        if (!rel) return
        const e = evt.originalEvent as MouseEvent | PointerEvent | undefined
        const rect = containerRef.getBoundingClientRect()
        setState("selectedIds", [])
        setState({
          selectedRelationId: edgeId,
          relationSourceId: rel.atom_id_source,
          relationTargetId: rel.atom_id_target,
          relationPrevType: rel.relation_type as RelationType,
          relationType: rel.relation_type as RelationType,
          relationX: e ? e.clientX - rect.left : 0,
          relationY: e ? e.clientY - rect.top : 0,
          relationDeleting: false,
          error: "",
          anchorVisible: false,
        })
      })

      graph.on("edge:pointerenter", (evt: any) => {
        if (state.dragging || state.active || state.confirmOpen) return
        const edgeId = evt.target?.id
        if (!edgeId) return
        if (hoverRelationId && hoverRelationId !== edgeId) {
          syncState(hoverRelationId, [])
        }
        hoverRelationId = edgeId
        syncState(edgeId, ["hover"])
      })

      graph.on("edge:pointerleave", (evt: any) => {
        if (hoverRelationId !== evt.target?.id) return
        clearRelationHover()
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
        clearTimeout(dimDebounceTimer)
        closeCreateForm()
        if (state.focusedNodeId) {
          const tooltip = document.getElementById("atom-tooltip")
          if (tooltip) {
            if ((tooltip as any).cleanup) {
              ;(tooltip as any).cleanup()
            }
            tooltip.remove()
          }
        }
        setState({ selectedIds: [], focusedNodeId: "", layoutMenuOpen: false })
        clearNodeHover()
        clearRelationHover()
        clearDimEffect()
        closeMenu()
      })

      graph.on("canvas:contextmenu", (evt: any) => {
        const e = evt.originalEvent as MouseEvent | PointerEvent | undefined
        if (!e || state.dragging || state.active || state.confirmOpen) return
        e.preventDefault()
        openCreateForm(e)
      })

      graph.on("node:contextmenu", (evt: any) => {
        const e = evt.originalEvent as MouseEvent | PointerEvent | undefined
        e?.preventDefault()
        closeCreateForm()
      })

      graph.on("edge:contextmenu", (evt: any) => {
        const e = evt.originalEvent as MouseEvent | PointerEvent | undefined
        e?.preventDefault()
        closeCreateForm()
      })

      graph.on("node:dragend", () => {
        saveCurrentState()
      })

      graph.on("viewportchange", () => {
        saveCurrentState()
      })

      setupTooltip()
      const graphState = stateManager?.loadState()
      if (!graphState || !canRestore(graphState)) {
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

  const canRestore = (state: GraphState | null) => {
    if (!state?.positions) return false

    const saved = new Set(Object.keys(state.positions))
    if (saved.size !== props.atoms.length) return false

    return props.atoms.every((atom) => saved.has(atom.atom_id))
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
      await fit()
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

  const LAYOUT_CONFIGS: Record<string, object> = {
    force: {
      type: "force",
      linkDistance: 150,
      nodeStrength: 30,
      edgeStrength: 200,
      preventOverlap: true,
      nodeSize: 60,
      nodeSpacing: 20,
      coulombDisScale: 0.003,
    },
    radial: {
      type: "radial",
      linkDistance: 160,
      preventOverlap: true,
      nodeSize: 60,
      nodeSpacing: 16,
      unitRadius: 220,
      strictRadial: false,
      sortBy: "degree", // high-degree nodes near center
    },
    circular: {
      type: "circular",
      radius: 300, // explicit radius so nodes don't crowd
      clockwise: true,
      divisions: 1,
      ordering: "degree",
      angleRatio: 1,
    },
    dagre: {
      type: "dagre",
      rankdir: "TB",
      align: "UL",
      nodesep: 30,
      ranksep: 70,
      controlPoints: false,
    },
  }

  const triggerAutoLayout = async (type?: string) => {
    if (!graph || !stateManager) return
    const layoutType = type ?? state.layoutType
    stateManager.clearState()
    if (!syncSize()) return
    await graph.setLayout(LAYOUT_CONFIGS[layoutType] as any)
    await frame()
    await graph.layout()
    await fit()
    saveCurrentState()
  }

  const updateGraph = () => {
    if (!graph || !containerRef) return

    try {
      graph.setData(toGraphData())
      const graphState = stateManager.loadState()
      if (!graphState || !canRestore(graphState)) {
        graph.render().then(() => {
          saveCurrentState()
        })
      } else {
        applySavedPositions(graphState).then(() => {})
      }
    } catch (err) {
      console.warn("Error updating graph:", err)
    }
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
    const id = state.pendingAtomId
    props.atoms.length
    if (!id) return
    void placePendingAtom()
  })

  createEffect(() => {
    const ids = new Set(props.atoms.map((atom) => atom.atom_id))
    const selectedIds = state.selectedIds.filter((id) => ids.has(id))
    const deleteIds = state.deleteIds.filter((id) => ids.has(id))
    const focusedGone = !!state.focusedNodeId && !ids.has(state.focusedNodeId)
    const hoverGone = !!state.hoverNodeId && !ids.has(state.hoverNodeId)
    const sourceGone = !!state.sourceId && !ids.has(state.sourceId)
    const targetGone = !!state.targetId && !ids.has(state.targetId)

    if (
      !focusedGone &&
      !hoverGone &&
      !sourceGone &&
      !targetGone &&
      selectedIds.length === state.selectedIds.length &&
      deleteIds.length === state.deleteIds.length
    ) {
      return
    }

    if (hoverGone) {
      hoverNodeId = ""
      anchorPinned = false
      pendingDimNodeId = ""
      clearTimeout(dimDebounceTimer)
    }

    if (focusedGone) {
      hideTooltip()
      clearDimEffect()
      pendingDimNodeId = ""
      clearTimeout(dimDebounceTimer)
    }

    if (sourceGone || targetGone) {
      clearHover()
      setState({
        active: false,
        dragging: false,
        sourceId: "",
        targetId: "",
        relationType: "",
        saving: false,
        error: "",
        startX: 0,
        startY: 0,
        endX: 0,
        endY: 0,
      })
    }

    setState({
      hoverNodeId: hoverGone ? "" : state.hoverNodeId,
      anchorVisible: hoverGone ? false : state.anchorVisible,
      focusedNodeId: focusedGone ? "" : state.focusedNodeId,
      selectedIds,
      deleteIds,
    })
  })

  createEffect(() => {
    const deleting = state.deleting
    const confirmOpen = state.confirmOpen

    const onKey = (evt: KeyboardEvent) => {
      if (evt.key === "Escape" && state.createOpen) {
        evt.preventDefault()
        closeCreateForm()
        return
      }

      if (!containerRef || state.selectedIds.length === 0 || state.active || state.dragging || deleting || confirmOpen)
        return

      const target = evt.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return
      if (evt.key !== "Delete" && evt.key !== "Backspace") return
      evt.preventDefault()
      const ids = [...state.selectedIds]
      resetNodeVisualState()
      setState("deleteIds", ids)
      setState("confirmOpen", true)
      setState("anchorVisible", false)
    }

    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  onCleanup(() => {
    clearHideAnchor()
    clearTimeout(dimDebounceTimer)
    ro?.disconnect()
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

  const [legendExpanded, setLegendExpanded] = createSignal(false)

  const relationMenu = () => {
    if (!containerRef) return { left: state.relationX, top: state.relationY }

    const cardW = 220
    const cardH = state.selectedRelationId
      ? state.error
        ? 290
        : 268 // edit card: header + 7 types + error? + delete row
      : state.error
        ? 260
        : 240 // create card: header + 7 types + error?
    const gap = 8
    const pad = 8

    const left = Math.min(Math.max(state.relationX, cardW / 2 + pad), containerRef.clientWidth - cardW / 2 - pad)
    const spaceBelow = containerRef.clientHeight - state.relationY - gap - pad
    const top = spaceBelow >= cardH ? state.relationY + gap : Math.max(state.relationY - cardH - gap, pad)

    return { left, top }
  }

  const deleteAtoms = () => props.atoms.filter((item) => state.deleteIds.includes(item.atom_id))
  const relationSource = () => props.atoms.find((item) => item.atom_id === state.relationSourceId)
  const relationTarget = () => props.atoms.find((item) => item.atom_id === state.relationTargetId)

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
      setState("saving", false)
      closeMenu()
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create relation"
      setState("saving", false)
      setState("error", message)
    }
  }

  const updateRelation = async (next: RelationType) => {
    if (
      state.saving ||
      state.relationDeleting ||
      !state.selectedRelationId ||
      !state.relationSourceId ||
      !state.relationTargetId ||
      !state.relationPrevType
    ) {
      return
    }

    if (next === state.relationPrevType) {
      closeMenu()
      return
    }

    setState("saving", true)
    setState("error", "")

    try {
      await props.onRelationUpdate({
        sourceAtomId: state.relationSourceId,
        targetAtomId: state.relationTargetId,
        relationType: state.relationPrevType,
        nextRelationType: next,
      })
      setState("saving", false)
      closeMenu()
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update relation"
      setState("saving", false)
      setState("error", message)
    }
  }

  const removeRelation = async () => {
    if (
      state.saving ||
      state.relationDeleting ||
      !state.selectedRelationId ||
      !state.relationSourceId ||
      !state.relationTargetId ||
      !state.relationPrevType
    ) {
      return
    }

    setState("relationDeleting", true)
    setState("error", "")

    try {
      await props.onRelationDelete({
        sourceAtomId: state.relationSourceId,
        targetAtomId: state.relationTargetId,
        relationType: state.relationPrevType,
      })
      setState("relationDeleting", false)
      closeMenu()
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete relation"
      setState("relationDeleting", false)
      setState("error", message)
    }
  }

  const removeAtom = async () => {
    if (state.deleteIds.length === 0 || state.deleting) return

    resetNodeVisualState()
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
        anchorVisible: false,
        focusedNodeId: "",
      })
    } catch {
      setState("deleting", false)
    }
  }

  return (
    <div ref={setContainerRef} class="w-full h-full min-h-[400px] relative">
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
        <div
          class="absolute z-20"
          style={{
            left: `${state.anchorX}px`,
            top: `${state.anchorY}px`,
            transform: "translate(calc(-100% - 4px), -50%)",
            animation: "node-action-in 0.12s ease-out",
          }}
          onMouseEnter={() => {
            anchorPinned = true
            clearHideAnchor()
          }}
          onMouseLeave={() => {
            anchorPinned = false
            // Toolbar dismisses on unpin/canvas-click, not on mouse leave
          }}
        >
          <style>{`
            @keyframes node-action-in {
              from { opacity: 0; transform: translate(calc(-100% + 4px), -50%) scale(0.85); }
              to   { opacity: 1; transform: translate(calc(-100% - 4px), -50%) scale(1); }
            }
          `}</style>
          <div class="flex flex-col gap-1 rounded-lg border border-white/10 bg-[rgba(15,23,42,0.88)] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-sm">
            {/* Add relation */}
            <button
              class="group flex h-7 w-7 items-center justify-center rounded-md text-[#94a3b8] transition-all hover:bg-indigo-500/20 hover:text-indigo-400"
              title="Create relation"
              onMouseDown={(evt) => {
                evt.preventDefault()
                evt.stopPropagation()
                if (!state.hoverNodeId) return
                beginDraft(state.hoverNodeId)
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M10.5 5.5 C10.5 3.57 9.93 2 8 2 C6.07 2 5.5 3.57 5.5 5.5 L5.5 10.5 C5.5 12.43 6.07 14 8 14 C9.93 14 10.5 12.43 10.5 10.5" />
                <circle cx="5.5" cy="5.5" r="1.8" fill="currentColor" stroke="none" />
                <circle cx="10.5" cy="10.5" r="1.8" fill="currentColor" stroke="none" />
              </svg>
            </button>
            {/* Divider */}
            <div class="mx-1 h-px bg-white/8" />
            {/* Delete */}
            <Show when={state.hoverNodeId}>
              <button
                class="group flex h-7 w-7 items-center justify-center rounded-md text-[#64748b] transition-all hover:bg-red-500/15 hover:text-red-400"
                title="Delete atom"
                onClick={(evt) => {
                  evt.preventDefault()
                  evt.stopPropagation()
                  if (!state.hoverNodeId) return
                  const nodeId = state.hoverNodeId
                  resetNodeVisualState()
                  setState("selectedIds", [nodeId])
                  setState("deleteIds", [nodeId])
                  setState("confirmOpen", true)
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M2 4h12M5 4V2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V4M6 7v5M10 7v5M3 4l.8 9.1A1 1 0 0 0 4.8 14h6.4a1 1 0 0 0 1-.9L13 4" />
                </svg>
              </button>
            </Show>
            {/* View in Detail */}
            <Show when={state.hoverNodeId && props.onAtomViewDetail}>
              <button
                class="group flex h-7 w-7 items-center justify-center rounded-md text-[#64748b] transition-all hover:bg-blue-500/15 hover:text-blue-400"
                title="View in detail"
                onClick={(evt) => {
                  evt.preventDefault()
                  evt.stopPropagation()
                  if (!state.hoverNodeId) return
                  const nodeId = state.hoverNodeId
                  resetNodeVisualState()
                  props.onAtomViewDetail?.(nodeId)
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <rect x="1" y="1" width="14" height="14" rx="2" />
                  <line x1="9" y1="1" x2="9" y2="15" />
                  <polyline points="5.5 6 3.5 8 5.5 10" />
                </svg>
              </button>
            </Show>
          </div>
        </div>
      </Show>
      <Show when={state.createOpen}>
        <div
          class="absolute z-30 w-[260px] overflow-hidden rounded-2xl border border-white/10 bg-[rgba(15,23,42,0.96)] shadow-[0_24px_64px_rgba(0,0,0,0.55)]"
          style={{
            left: `${state.createX}px`,
            top: `${state.createY}px`,
            animation: "node-info-in 0.14s ease-out",
            "backdrop-filter": "blur(12px)",
          }}
          onClick={(evt) => evt.stopPropagation()}
        >
          <div class="border-b border-white/8 px-4 py-3">
            <div class="text-[10px] font-medium tracking-wider text-[#475569]">NEW ATOM</div>
            <div class="mt-1 text-[13px] font-medium text-[#e2e8f0]">Create atom at this location</div>
          </div>
          <div class="flex flex-col gap-3 px-4 py-4">
            <div class="flex flex-col gap-1.5">
              <label class="text-[11px] font-medium text-[#94a3b8]">Name</label>
              <input
                value={state.createName}
                onInput={(evt) => setState({ createName: evt.currentTarget.value, createError: "" })}
                onKeyDown={(evt) => {
                  if (evt.key === "Enter") {
                    evt.preventDefault()
                    void submitCreateAtom()
                  }
                }}
                placeholder="e.g. Gradient stability bound"
                class="h-9 rounded-lg border border-white/10 bg-white/5 px-3 text-[13px] text-[#e2e8f0] outline-none transition-colors placeholder:text-[#475569] focus:border-cyan-400/60"
                autofocus
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-[11px] font-medium text-[#94a3b8]">Type</label>
              <div class="overflow-hidden rounded-lg border border-white/8 bg-white/[0.02] py-1">
                {Object.entries(TYPE_LABELS).map(([value, label]) => {
                  const color = TYPE_COLORS[value] ?? "#64748b"
                  const isSelected = state.createType === value
                  return (
                    <button
                      class="w-full flex items-center gap-2.5 px-3 h-8 transition-colors text-left"
                      style={{
                        background: isSelected ? `${color}18` : undefined,
                        opacity: state.createSaving && !isSelected ? 0.4 : 1,
                      }}
                      disabled={state.createSaving}
                      onClick={() => setState("createType", value as AtomKind)}
                    >
                      <span
                        class="shrink-0 h-2 w-2 rounded-full"
                        style={{ background: color, "box-shadow": isSelected ? `0 0 6px ${color}80` : undefined }}
                      />
                      <span class="text-xs flex-1" style={{ color: isSelected ? color : "#cbd5e1" }}>
                        {label}
                      </span>
                      <Show when={isSelected}>
                        <svg class="w-3 h-3 shrink-0" style={{ color }} viewBox="0 0 16 16" fill="none">
                          <path
                            d="M3 8l3.5 3.5L13 4.5"
                            stroke="currentColor"
                            stroke-width="1.8"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                      </Show>
                    </button>
                  )
                })}
              </div>
            </div>
            <Show when={state.createError}>
              <div class="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
                {state.createError}
              </div>
            </Show>
            <div class="flex items-center justify-between gap-2 border-t border-white/8 pt-3">
              <button
                onClick={() => closeCreateForm()}
                disabled={state.createSaving}
                class="h-8 flex-1 rounded-lg bg-white/5 text-[12px] font-medium text-[#94a3b8] transition-colors hover:bg-white/10 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void submitCreateAtom()}
                disabled={state.createSaving}
                class="h-8 flex-1 rounded-lg bg-cyan-500 text-[12px] font-medium text-slate-950 transition-colors hover:bg-cyan-400 disabled:opacity-50"
              >
                {state.createSaving ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      </Show>
      <div
        class="absolute bottom-4 right-4 z-20 rounded-lg border border-white/8 backdrop-blur-sm"
        style={{ background: "rgba(15,23,42,0.82)" }}
        onMouseEnter={() => setLegendExpanded(true)}
        onMouseLeave={() => setLegendExpanded(false)}
      >
        <style>{`
          @keyframes legend-expand {
            from { opacity: 0; transform: translateY(6px) scale(0.97); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
          }
        `}</style>

        {/* Collapsed: 2×2 type grid with initials */}
        <Show when={!legendExpanded()}>
          <div class="p-2 grid grid-cols-2 gap-1.5">
            {legendItems.map((item) => (
              <div class="flex items-center gap-1 px-1.5 py-1 rounded" style={{ background: `${item.color}22` }}>
                <div class="w-2 h-2 rounded-full flex-shrink-0" style={{ background: item.color }} />
                <span class="text-[10px] font-medium" style={{ color: item.color }}>
                  {item.label.slice(0, 3)}
                </span>
              </div>
            ))}
          </div>
        </Show>

        {/* Expanded: full legend */}
        <Show when={legendExpanded()}>
          <div class="px-3 py-2.5 w-44" style={{ animation: "legend-expand 0.15s ease-out" }}>
            <div class="text-[10px] mb-2 font-medium tracking-wider" style={{ color: "#64748b" }}>
              ATOM TYPES
            </div>
            <div class="flex flex-col gap-1.5 mb-3">
              {legendItems.map((item) => (
                <div class="flex items-center gap-2">
                  <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: item.color }} />
                  <span class="text-xs" style={{ color: "#cbd5e1" }}>
                    {item.label}
                  </span>
                </div>
              ))}
            </div>
            <div class="border-t border-white/8 pt-2">
              <div class="text-[10px] mb-2 font-medium tracking-wider" style={{ color: "#64748b" }}>
                RELATIONS
              </div>
              <div class="flex flex-col gap-1.5">
                {relationLegendItems.map((item) => (
                  <div class="flex items-center gap-2">
                    <div class="w-3 h-0.5 rounded-full flex-shrink-0" style={{ background: item.color }} />
                    <span class="text-xs" style={{ color: "#cbd5e1" }}>
                      {item.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            {/* Layout picker */}
            <div class="relative mt-3">
              <button
                onClick={() => setState("layoutMenuOpen", !state.layoutMenuOpen)}
                class="w-full px-2 py-1.5 text-xs rounded transition-colors flex items-center justify-between gap-1 bg-white/5 hover:bg-white/10"
                style={{ color: "#94a3b8" }}
              >
                <span class="flex items-center gap-1">
                  <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                  {
                    (
                      { force: "Force", radial: "Radial", circular: "Circular", dagre: "Tree" } as Record<
                        string,
                        string
                      >
                    )[state.layoutType]
                  }
                </span>
                <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              <Show when={state.layoutMenuOpen}>
                <div
                  class="absolute bottom-full left-0 right-0 mb-1 rounded-lg border border-white/10 overflow-hidden z-50"
                  style={{ background: "rgba(15,23,42,0.97)", "backdrop-filter": "blur(12px)" }}
                >
                  {(
                    [
                      { key: "force", label: "Force", desc: "Physics simulation" },
                      { key: "radial", label: "Radial", desc: "Important nodes centered" },
                      { key: "circular", label: "Circular", desc: "Ring arrangement" },
                      { key: "dagre", label: "Tree", desc: "Hierarchical top-down" },
                    ] as const
                  ).map((item) => (
                    <button
                      class="w-full px-3 h-8 text-left transition-colors hover:bg-white/8 flex items-center justify-between gap-2"
                      style={{ background: state.layoutType === item.key ? "rgba(99,102,241,0.15)" : undefined }}
                      onClick={() => {
                        setState({ layoutType: item.key, layoutMenuOpen: false })
                        void triggerAutoLayout(item.key)
                      }}
                    >
                      <span
                        class="text-xs font-medium leading-none"
                        style={{ color: state.layoutType === item.key ? "#818cf8" : "#cbd5e1" }}
                      >
                        {item.label}
                      </span>
                      <span class="text-[10px] leading-none shrink-0" style={{ color: "#475569" }}>
                        {item.desc}
                      </span>
                    </button>
                  ))}
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </div>
      <Show when={props.loading}>
        <div class="absolute inset-0 flex items-center justify-center bg-[rgba(2,6,23,0.8)] z-10">
          <div class="text-slate-400">Loading graph...</div>
        </div>
      </Show>
      <Show when={state.active || !!state.selectedRelationId}>
        <div
          class="absolute z-30 w-[220px] rounded-xl border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.5)] overflow-hidden"
          style={{
            left: `${relationMenu().left}px`,
            top: `${relationMenu().top}px`,
            transform: "translateX(-50%)",
            background: "rgba(15,23,42,0.96)",
            "backdrop-filter": "blur(12px)",
            animation: "node-info-in 0.14s ease-out",
          }}
          onClick={(evt) => evt.stopPropagation()}
        >
          {/* Header: source → target */}
          <div class="px-3 pt-3 pb-2 border-b border-white/8">
            <div class="text-[10px] font-medium mb-1" style={{ color: "#475569" }}>
              {state.active ? "New relation" : "Edit relation"}
            </div>
            <div class="flex items-center gap-1 text-[12px] font-medium leading-tight" style={{ color: "#e2e8f0" }}>
              <span class="truncate max-w-[70px]">
                {state.active
                  ? (props.atoms.find((a) => a.atom_id === state.sourceId)?.atom_name ?? "…")
                  : (relationSource()?.atom_name ?? state.relationSourceId.slice(0, 8))}
              </span>
              <span style={{ color: "#475569" }} class="shrink-0">
                →
              </span>
              <span class="truncate max-w-[70px]">
                {state.active
                  ? (props.atoms.find((a) => a.atom_id === state.targetId)?.atom_name ?? "…")
                  : (relationTarget()?.atom_name ?? state.relationTargetId.slice(0, 8))}
              </span>
            </div>
          </div>

          {/* Relation type list */}
          <div class="py-1">
            {Object.entries(RELATION_LABELS).map(([value, label]) => {
              const color = RELATION_COLORS[value] ?? "#64748b"
              const isSelected = state.relationType === value
              const isSaving = state.saving && isSelected
              return (
                <button
                  class="w-full flex items-center gap-2.5 px-3 h-8 transition-colors text-left"
                  style={{
                    background: isSelected ? `${color}18` : undefined,
                    opacity: (state.saving || state.relationDeleting) && !isSelected ? 0.4 : 1,
                  }}
                  disabled={state.saving || state.relationDeleting}
                  onClick={() => {
                    if (isSaving) return
                    setState("relationType", value as RelationType)
                    if (state.selectedRelationId) {
                      void updateRelation(value as RelationType)
                    } else {
                      void submitRelation()
                    }
                  }}
                >
                  <span
                    class="shrink-0 h-2 w-2 rounded-full"
                    style={{ background: color, "box-shadow": isSelected ? `0 0 6px ${color}80` : undefined }}
                  />
                  <span class="text-xs flex-1" style={{ color: isSelected ? color : "#cbd5e1" }}>
                    {label}
                  </span>
                  <Show when={isSaving}>
                    <svg
                      class="w-3 h-3 animate-spin shrink-0"
                      style={{ color: "#64748b" }}
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <circle
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        stroke-width="3"
                        stroke-dasharray="31.4"
                        stroke-linecap="round"
                      />
                    </svg>
                  </Show>
                  <Show when={isSelected && !isSaving}>
                    <svg class="w-3 h-3 shrink-0" style={{ color }} viewBox="0 0 16 16" fill="none">
                      <path
                        d="M3 8l3.5 3.5L13 4.5"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </Show>
                </button>
              )
            })}
          </div>

          {/* Error */}
          <Show when={state.error}>
            <div class="mx-3 mb-2 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">
              {state.error}
            </div>
          </Show>

          {/* Footer: edit mode only — delete + cancel */}
          <Show when={!!state.selectedRelationId}>
            <div class="flex items-center gap-2 px-3 pb-3 pt-1 border-t border-white/8">
              <button
                onClick={() => removeRelation()}
                disabled={state.saving || state.relationDeleting}
                class="flex-1 h-7 text-[11px] rounded-lg border border-red-500/25 bg-red-500/15 hover:bg-red-500/25 disabled:opacity-50 transition-colors"
                style={{ color: "#fca5a5" }}
              >
                {state.relationDeleting ? "Deleting…" : "Delete"}
              </button>
              <button
                onClick={() => closeMenu()}
                disabled={state.saving || state.relationDeleting}
                class="flex-1 h-7 text-[11px] rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-colors"
                style={{ color: "#94a3b8" }}
              >
                Cancel
              </button>
            </div>
          </Show>

          {/* Footer: create mode — cancel */}
          <Show when={state.active && !state.selectedRelationId}>
            <div class="px-3 pb-3 pt-1 border-t border-white/8">
              <button
                onClick={() => closeMenu()}
                class="w-full h-7 text-[11px] rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
                style={{ color: "#94a3b8" }}
              >
                Cancel
              </button>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={state.confirmOpen}>
        <div class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-[rgba(2,6,23,0.6)] backdrop-blur-sm">
          <div
            class="pointer-events-auto w-[340px] overflow-hidden rounded-2xl border border-white/10 bg-[rgba(15,23,42,0.95)] shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
            style={{ animation: "confirm-in 0.15s cubic-bezier(0.34,1.4,0.64,1)" }}
          >
            <style>{`
              @keyframes confirm-in {
                from { opacity: 0; transform: scale(0.92) translateY(8px); }
                to   { opacity: 1; transform: scale(1) translateY(0); }
              }
            `}</style>
            {/* Icon + title */}
            <div class="flex flex-col items-center px-6 pt-6 pb-4 text-center">
              <div class="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/12 ring-1 ring-red-500/25">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="#f87171"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M2 4h12M5 4V2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V4M6 7v5M10 7v5M3 4l.8 9.1A1 1 0 0 0 4.8 14h6.4a1 1 0 0 0 1-.9L13 4" />
                </svg>
              </div>
              <div class="text-[15px] font-semibold text-[#f1f5f9]">Delete atom</div>
              <div class="mt-2 text-[13px] leading-relaxed text-[#94a3b8]">
                Delete{" "}
                <span class="font-medium text-[#e2e8f0]">
                  {(() => {
                    const atoms = deleteAtoms()
                    return atoms.length === 1
                      ? (atoms[0]?.atom_name ?? state.deleteIds[0]?.slice(0, 8))
                      : `${state.deleteIds.length} atoms`
                  })()}
                </span>
                ?<br />
                Related relations, files, and sessions will also be deleted.
              </div>
              <div class="mt-2 text-[11px] text-[#475569]">This action cannot be undone</div>
            </div>
            {/* Actions */}
            <div class="flex gap-2 border-t border-white/6 px-4 py-3">
              <button
                onClick={() => cancelAtomDelete()}
                disabled={state.deleting}
                class="flex-1 rounded-lg border border-white/8 bg-white/5 py-2 text-[13px] font-medium transition-all hover:bg-white/10 disabled:opacity-50"
                style={{ color: "#94a3b8" }}
              >
                Cancel
              </button>
              <button
                onClick={() => removeAtom()}
                disabled={state.deleting}
                class="flex-1 rounded-lg bg-red-500 py-2 text-[13px] font-medium transition-all hover:bg-red-400 disabled:opacity-50 shadow-[0_2px_8px_rgba(239,68,68,0.35)]"
                style={{ color: "#ffffff" }}
              >
                {state.deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      </Show>
      <Show when={props.error}>
        <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-[rgba(2,6,23,0.8)] z-10">
          <div class="text-red-400">Error loading graph</div>
        </div>
      </Show>
      <Show when={!props.loading && !props.error && props.atoms.length === 0}>
        <div class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[rgba(2,6,23,0.8)]">
          <div class="text-center text-slate-400">
            <div>No atoms to display</div>
            <div class="mt-2 text-[12px] text-slate-500">Right-click anywhere to create the first atom.</div>
          </div>
        </div>
      </Show>
    </div>
  )
}
