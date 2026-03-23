import { createEffect, createSignal, onCleanup, onMount, Show, untrack } from "solid-js"
import { Graph } from "@antv/g6"
import type { ResearchAtomsListResponse } from "@opencode-ai/sdk/v2"
import { GraphState, GraphStateManager } from "./graph-state-manager"

type Atom = ResearchAtomsListResponse["atoms"][number]
type Relation = ResearchAtomsListResponse["relations"][number]

// 颜色映射
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

const PROOF_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  done: "Done",
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
  researchProjectId: string
}) {
  let containerRef: HTMLDivElement | undefined
  const [containerReady, setContainerReady] = createSignal(false)
  const setContainerRef = (el: HTMLDivElement) => {
    containerRef = el
    setContainerReady(true) // 触发响应式更新
  }
  let graph: Graph | undefined
  let stateManager: GraphStateManager

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
    behaviors: ["drag-canvas", "zoom-canvas", "drag-element"],
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
        status: atom.atom_proof_status,
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

  const initGraph = () => {
    try {
      graph = new Graph({
        container: containerRef,
        data: toGraphData(),
        ...graphOptions,
      } as any)

      graph.on("node:click", (evt: any) => {
        const nodeId = evt.target?.id
        if (nodeId) props.onAtomClick(nodeId)
      })

      graph.on("node:dragend", (evt: any) => {
        saveCurrentState()
      })

      graph.on("viewportchange", (evt: any) => {
        saveCurrentState()
      })

      setupTooltip()
      let graphState = stateManager?.loadState()
      if (graphState == null) {
        graph.render().then(() => {
          saveCurrentState()
        })
      } else {
        applySavedPositions(graphState).then(() => {})
      }
    } catch (error) {
      // 清理失败的状态
      if (graph) {
        graph.destroy()
        graph = undefined
      }
    }
  }

  const applySavedPositions = async (savedState: GraphState) => {
    if (!graph || !stateManager) return

    if (!savedState?.positions) return

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

    const currentAtomIdList = new Set<String>()
    props.atoms.forEach((atom) => {
      currentAtomIdList.add(atom.atom_id)
    })
    const filteredNodes = updateData.nodes.filter((node) => {
      return currentAtomIdList.has(node.id)
    })

    if (filteredNodes.length > 0) {
      try {
        graph?.updateNodeData(filteredNodes)
        await graph?.draw()
        await graph?.fitView()
      } catch (error) {}
    }
  }

  const saveCurrentState = () => {
    if (!graph || !stateManager) return

    try {
      const positions: Record<string, { x: number; y: number }> = {}
      if (graph.getNodeData().length == 0) {
        stateManager?.clearState()
        return
      }

      // 获取当前所有节点位置
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

      let centerX = viewport[0],
        centerY = viewport[1]

      stateManager.saveState(positions, {
        zoom: zoom,
        centerX: centerX,
        centerY: centerY,
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
      if (tooltip) {
        if ((tooltip as any).cleanup) {
          ;(tooltip as any).cleanup()
        }
        tooltip.remove()
      }
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

      if (left < 0) {
        left = 10
      }

      if (top < 0) {
        top = 10
      }

      tooltip.style.left = `${left}px`
      tooltip.style.top = `${top}px`
    }

    graph.on("node:pointerenter", (evt: any) => {
      const nodeId = evt.target?.id
      if (nodeId) {
        const atom = props.atoms.find((a) => a.atom_id === nodeId)
        if (atom) {
          const typeLabel = TYPE_LABELS[atom.atom_type] ?? atom.atom_type
          const statusLabel = PROOF_STATUS_LABELS[atom.atom_proof_status] ?? atom.atom_proof_status

          const tooltip = createTooltip()

          tooltip.innerHTML = `
            <div style="font-weight: 600; margin-bottom: 4px;">${atom.atom_name}</div>
            <div style="color: #94a3b8; margin-bottom: 2px;">Type: ${typeLabel}</div>
            <div style="color: #94a3b8;">Status: ${statusLabel}</div>
          `

          updateTooltipPosition(tooltip, evt.originalEvent as MouseEvent)

          // 鼠标移动时更新位置
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

    graph.on("node:pointerleave", (evt: any) => {
      destroyTooltip()
    })
  }

  const updateGraph = () => {
    if (!graph || !containerRef) {
      return
    }

    try {
      const data = toGraphData()
      graph.setData(data)

      let graphState = stateManager.loadState()
      if (graphState == null) {
        graph.render().then(() => {
          saveCurrentState()
        })
      } else {
        applySavedPositions(graphState).then(() => {})
      }
    } catch (error) {}
  }

  createEffect(() => {
    const atoms = props.atoms
    const relations = props.relations
    const isContainerReady = containerReady()

    if (isContainerReady && containerRef) {
      if (!graph) {
        initGraph()
      } else {
        updateGraph()
      }
    }
  })

  onCleanup(() => {
    // 保存当前状态
    if (graph) {
      saveCurrentState()
    }

    // 清理tooltip
    const tooltip = document.getElementById("atom-tooltip")
    if (tooltip) {
      if ((tooltip as any).cleanup) {
        ;(tooltip as any).cleanup()
      }
      tooltip.remove()
    }

    // 清理graph实例
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

  return (
    <div ref={setContainerRef} class="w-full h-full min-h-[400px] relative">
      <div class="absolute bottom-4 right-4 z-20 bg-slate-800/90 backdrop-blur-sm rounded-lg px-3 py-2 border border-slate-700">
        <div class="text-[10px] text-slate-400 mb-2 font-medium">ATOM TYPES</div>
        <div class="flex flex-col gap-1.5 mb-3">
          {legendItems.map((item) => (
            <div class="flex items-center gap-2">
              <div class="w-3 h-3 rounded-full" style={{ background: item.color }} />
              <span class="text-xs text-slate-300">{item.label}</span>
            </div>
          ))}
        </div>
        <div class="border-t border-slate-700 pt-2">
          <div class="text-[10px] text-slate-400 mb-2 font-medium">RELATIONS</div>
          <div class="flex flex-col gap-1.5">
            {relationLegendItems.map((item) => (
              <div class="flex items-center gap-2">
                <div class="w-3 h-0.5 rounded-full" style={{ background: item.color }} />
                <span class="text-xs text-slate-300">{item.label}</span>
              </div>
            ))}
          </div>
        </div>
        <button
          onClick={() => triggerAutoLayout()}
          class="mt-3 w-full px-2 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors flex items-center justify-center gap-1"
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
        <div class="absolute inset-0 flex items-center justify-center bg-slate-900/80 z-10">
          <div class="text-gray-500">Loading graph...</div>
        </div>
      </Show>
      <Show when={props.error}>
        <div class="absolute inset-0 flex items-center justify-center bg-slate-900/80 z-10">
          <div class="text-red-500">Error loading graph</div>
        </div>
      </Show>
      <Show when={!props.loading && !props.error && props.atoms.length === 0}>
        <div class="absolute inset-0 flex items-center justify-center bg-slate-900/80 z-10">
          <div class="text-gray-500">No atoms to display</div>
        </div>
      </Show>
    </div>
  )
}
