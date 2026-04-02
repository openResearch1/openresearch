import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Graph } from "@antv/g6"
import type { ResearchAtomsListResponse } from "@opencode-ai/sdk/v2"
import { type GraphState, GraphStateManager } from "./graph-state-manager"

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
  onAtomDelete: (atomId: string) => Promise<void>
  onRelationCreate: (input: { sourceAtomId: string; targetAtomId: string; relationType: string }) => Promise<void>
  onRelationUpdate: (input: {
    sourceAtomId: string
    targetAtomId: string
    relationType: string
    nextRelationType: string
  }) => Promise<void>
  onRelationDelete: (input: { sourceAtomId: string; targetAtomId: string; relationType: string }) => Promise<void>
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

  const hideAnchor = () => {
    clearHideAnchor()
    if (anchorPinned || state.dragging || state.active || state.selectedRelationId || state.confirmOpen) return
    setState({ anchorVisible: false, hoverNodeId: "" })
  }

  const scheduleAnchorHide = () => {
    clearHideAnchor()
    hideAnchorTimer = setTimeout(() => {
      hideAnchor()
    }, 120)
  }

  const showAnchor = (id: string) => {
    const point = getPoint(id)
    if (!point || state.dragging || state.active || state.selectedRelationId || state.confirmOpen) return

    clearHideAnchor()
    setState({
      hoverNodeId: id,
      anchorVisible: true,
      anchorX: point.x + 24,
      anchorY: point.y,
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
    if (state.saving || state.relationDeleting) return
    setState({
      active: false,
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
        stroke: (d: any) => TYPE_COLORS[d.data?.type] ?? "#6366f1",
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
      },
      animation: {
        update: [{ fields: ["size", "lineWidth", "shadowBlur"], duration: 200, easing: "ease-out" }],
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
        hover: {
          stroke: "#e2e8f0",
          lineWidth: 3,
        },
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
    animation: { duration: 400, easing: "ease-in-out" },
  }

  onMount(() => {
    stateManager = new GraphStateManager(props.researchProjectId)
    if (!containerRef) return

    ro = new ResizeObserver(() => {
      syncSize()
    })
    ro.observe(containerRef)
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

    graph.on("node:pointerenter", (evt: any) => {
      const nodeId = evt.target?.id
      if (nodeId) {
        if (hoverNodeId && hoverNodeId !== nodeId) {
          syncState(hoverNodeId, [])
        }
        hoverNodeId = nodeId
        if (!state.dragging && !state.active && !state.selectedRelationId && !state.confirmOpen) {
          syncState(nodeId, ["hover"])
        }
        showAnchor(nodeId)
        const atom = props.atoms.find((a) => a.atom_id === nodeId)
        if (atom) {
          const typeColor = TYPE_COLORS[atom.atom_type] ?? "#6366f1"
          const typeLabel = TYPE_LABELS[atom.atom_type] ?? atom.atom_type
          const statusColor = STATUS_COLORS[atom.atom_evidence_status] ?? "#64748b"
          const statusBg = STATUS_DOT_BG[atom.atom_evidence_status] ?? "rgba(100,116,139,0.15)"
          const statusLabel = EVIDENCE_STATUS_LABELS[atom.atom_evidence_status] ?? atom.atom_evidence_status
          const evTypeLabel = atom.atom_evidence_type === "math" ? "Math" : atom.atom_evidence_type === "experiment" ? "Experiment" : atom.atom_evidence_type

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
              ${evTypeLabel ? `
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
              </div>` : ""}
            </div>
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
      clearNodeHover()
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
      syncSize()

      graph.on("node:click", (evt: any) => {
        if (state.dragging || state.active || state.confirmOpen) return
        closeMenu()
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

      graph.on("edge:click", (evt: any) => {
        if (state.dragging || state.active || state.confirmOpen || !containerRef) return
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
        clearNodeHover()
        clearRelationHover()
        closeMenu()
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

  const triggerAutoLayout = async () => {
    if (!graph || !stateManager) return
    stateManager.clearState()
    if (!syncSize()) return
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
    }

    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  onCleanup(() => {
    clearHideAnchor()
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

  const relationMenu = () => {
    if (!containerRef) {
      return {
        left: state.relationX,
        top: state.relationY,
        up: true,
      }
    }

    const width = state.selectedRelationId ? 220 : 188
    const height = state.selectedRelationId ? (state.error ? 116 : 72) : state.error ? 88 : 44
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
            transform: "translate(4px, -50%)",
            animation: "node-action-in 0.12s ease-out",
          }}
          onMouseEnter={() => {
            anchorPinned = true
            clearHideAnchor()
          }}
          onMouseLeave={() => {
            anchorPinned = false
            scheduleAnchorHide()
          }}
        >
          <style>{`
            @keyframes node-action-in {
              from { opacity: 0; transform: translate(0px, -50%) scale(0.85); }
              to   { opacity: 1; transform: translate(4px, -50%) scale(1); }
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
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
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
                  hideTooltip()
                  setState("selectedIds", [state.hoverNodeId])
                  setState("deleteIds", [state.hoverNodeId])
                  setState("confirmOpen", true)
                  setState("anchorVisible", false)
                }}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M2 4h12M5 4V2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V4M6 7v5M10 7v5M3 4l.8 9.1A1 1 0 0 0 4.8 14h6.4a1 1 0 0 0 1-.9L13 4" />
                </svg>
              </button>
            </Show>
          </div>
        </div>
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
                if (state.selectedRelationId) {
                  void updateRelation(value)
                  return
                }
                void submitRelation()
              }}
              class="w-full appearance-none bg-transparent px-3 py-1.5 pr-8 text-[13px] font-medium tracking-[0.01em] text-text-strong outline-none"
              disabled={state.saving || state.relationDeleting}
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
      <Show when={state.selectedRelationId}>
        <div class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background-strong/70 backdrop-blur-[1px]">
          <div class="pointer-events-auto w-[360px] rounded-xl border border-border-weak-base bg-surface-float-base shadow-2xl p-4">
            <div class="text-sm font-medium text-text-strong">Edit Relation</div>
            <div class="mt-3 text-sm text-text-base">
              <span class="text-text-strong">
                {relationSource()?.atom_name ?? state.relationSourceId.slice(0, 8)}
              </span>{" "}
              →{" "}
              <span class="text-text-strong">
                {relationTarget()?.atom_name ?? state.relationTargetId.slice(0, 8)}
              </span>
            </div>
            <div class="mt-4">
              <div class="mb-2 text-xs text-text-weaker">Relation type</div>
              <select
                value={state.relationType}
                onInput={(evt) => {
                  const value = evt.currentTarget.value as RelationType
                  setState("relationType", value)
                }}
                disabled={state.saving || state.relationDeleting}
                class="w-full rounded-lg border border-border-weak-base bg-surface-raised-base px-3 py-2 text-sm text-text-strong outline-none"
              >
                {Object.entries(RELATION_LABELS).map(([value, label]) => (
                  <option value={value}>{label}</option>
                ))}
              </select>
            </div>
            <Show when={state.error}>
              <div class="mt-3 rounded-lg border border-border-critical-base/20 bg-surface-critical-base/10 px-3 py-2 text-xs text-text-on-critical-base">
                {state.error}
              </div>
            </Show>
            <div class="mt-4 flex items-center justify-between gap-2">
              <button
                onClick={() => removeRelation()}
                disabled={state.saving || state.relationDeleting}
                class="px-3 py-1.5 text-xs rounded border border-red-300/80 bg-red-500 text-white shadow-lg hover:bg-red-400 disabled:opacity-60 transition-colors"
              >
                {state.relationDeleting ? "Deleting..." : "Delete"}
              </button>
              <div class="flex items-center gap-2">
                <button
                  onClick={() => closeMenu()}
                  disabled={state.saving || state.relationDeleting}
                  class="px-3 py-1.5 text-xs rounded bg-surface-raised-base text-text-base hover:bg-surface-raised-base-hover disabled:opacity-60 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void updateRelation(state.relationType as RelationType)}
                  disabled={state.saving || state.relationDeleting}
                  class="px-3 py-1.5 text-xs rounded bg-surface-primary-base text-text-on-primary-base hover:bg-surface-primary-base disabled:opacity-60 transition-colors"
                >
                  {state.saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
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
                <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="#f87171" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M2 4h12M5 4V2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V4M6 7v5M10 7v5M3 4l.8 9.1A1 1 0 0 0 4.8 14h6.4a1 1 0 0 0 1-.9L13 4" />
                </svg>
              </div>
              <div class="text-[15px] font-semibold text-[#f1f5f9]">删除原子</div>
              <div class="mt-2 text-[13px] leading-relaxed text-[#94a3b8]">
                确认删除{" "}
                <span class="font-medium text-[#e2e8f0]">
                  {deleteAtoms().length === 1
                    ? (deleteAtoms()[0]?.atom_name ?? state.deleteIds[0]?.slice(0, 8))
                    : `${state.deleteIds.length} 个原子`}
                </span>
                ？<br />相关联的关系、文件和会话将一并删除。
              </div>
              <div class="mt-2 text-[11px] text-[#475569]">此操作不可撤销</div>
            </div>
            {/* Actions */}
            <div class="flex gap-2 border-t border-white/6 px-4 py-3">
              <button
                onClick={() => setState({ confirmOpen: false, deleting: false, deleteIds: [] })}
                disabled={state.deleting}
                class="flex-1 rounded-lg border border-white/8 bg-white/5 py-2 text-[13px] font-medium text-[#94a3b8] transition-all hover:bg-white/10 hover:text-[#e2e8f0] disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={() => removeAtom()}
                disabled={state.deleting}
                class="flex-1 rounded-lg bg-red-500/90 py-2 text-[13px] font-medium text-white transition-all hover:bg-red-500 disabled:opacity-50 shadow-[0_2px_8px_rgba(239,68,68,0.35)]"
              >
                {state.deleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      </Show>
      <Show when={props.error}>
        <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-background-strong/80 z-10">
          <div class="text-icon-critical-base">Error loading graph</div>
        </div>
      </Show>
      <Show when={!props.loading && !props.error && props.atoms.length === 0}>
        <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-background-strong/80 z-10">
          <div class="text-text-weak">No atoms to display</div>
        </div>
      </Show>
    </div>
  )
}
