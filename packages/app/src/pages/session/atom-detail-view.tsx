import { createEffect, createSignal, on, onCleanup, onMount, Show, For } from "solid-js"
import {
  SolidFlow,
  Controls,
  Background,
  MiniMap,
  createNodeStore,
  createEdgeStore,
  Position,
  useViewport,
  useSolidFlow,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeConnection,
  type ConnectionLineComponentProps,
  MarkerType,
} from "@dschz/solid-flow"
import "@dschz/solid-flow/styles"
import { Graph, layout } from "@dagrejs/dagre"
import type { ResearchAtomsListResponse } from "@opencode-ai/sdk/v2"
import { AtomNode, type AtomNodeData } from "./atom-detail-node"

type Atom = ResearchAtomsListResponse["atoms"][number]
type Relation = ResearchAtomsListResponse["relations"][number]
type AtomKind = "fact" | "method" | "theorem" | "verification"

const RELATION_COLORS: Record<string, string> = {
  motivates: "#8b5cf6",
  formalizes: "#06b6d4",
  derives: "#f97316",
  analyzes: "#ec4899",
  validates: "#22c55e",
  contradicts: "#ef4444",
  other: "#94a3b8",
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

const ATOM_TYPE_OPTIONS: AtomKind[] = ["fact", "method", "theorem", "verification"]
const RELATION_TYPE_OPTIONS = Object.keys(RELATION_LABELS)

const NODE_WIDTH = 180
const NODE_HEIGHT = 70

const nodeTypes = {
  atom: AtomNode,
} satisfies NodeTypes

function computeLayout(atoms: Atom[], relations: Relation[]) {
  const g = new Graph()
  g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 160, marginx: 40, marginy: 40, align: "UL" })
  g.setDefaultEdgeLabel(() => ({}))

  for (const atom of atoms) {
    g.setNode(atom.atom_id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  for (const rel of relations) {
    g.setEdge(rel.atom_id_source, rel.atom_id_target)
  }

  layout(g)

  const positions: Record<string, { x: number; y: number }> = {}
  let minY = Infinity
  let maxY = -Infinity
  for (const id of g.nodes()) {
    const node = g.node(id)
    if (node) {
      const y = (node.y ?? 0) - NODE_HEIGHT / 2
      positions[id] = { x: (node.x ?? 0) - NODE_WIDTH / 2, y }
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y + NODE_HEIGHT)
    }
  }
  const graphHeight = maxY === -Infinity ? 0 : maxY - minY
  return { positions, graphHeight }
}

function atomsToNodes(atoms: Atom[], positions: Record<string, { x: number; y: number }>) {
  return atoms.map((atom) => ({
    id: atom.atom_id,
    type: "atom" as const,
    position: positions[atom.atom_id] ?? { x: Math.random() * 400, y: Math.random() * 400 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      label: atom.atom_name,
      atomType: atom.atom_type,
      evidenceStatus: atom.atom_evidence_status,
      evidenceType: atom.atom_evidence_type,
    },
  }))
}

function relationsToEdges(relations: Relation[]) {
  return relations.map((rel) => ({
    id: `${rel.atom_id_source}-${rel.relation_type}-${rel.atom_id_target}`,
    type: "default" as const,
    source: rel.atom_id_source,
    target: rel.atom_id_target,
    style: {
      stroke: RELATION_COLORS[rel.relation_type] ?? "#94a3b8",
      "stroke-width": "2px",
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: RELATION_COLORS[rel.relation_type] ?? "#94a3b8",
    },
    data: { relationType: rel.relation_type },
  }))
}

function ScreenToFlowBridge(props: { onReady: (fn: (pos: { x: number; y: number }) => { x: number; y: number }) => void }) {
  const { screenToFlowPosition } = useSolidFlow()
  props.onReady(screenToFlowPosition)
  return null
}

function FocusHandler(props: { focusAtomId?: string | null; nodes: Node[] }) {
  const { setCenter } = useSolidFlow()
  const [handled, setHandled] = createSignal<string | null>(null)

  createEffect(() => {
    const focusId = props.focusAtomId
    if (!focusId || focusId === handled()) return
    const node = props.nodes.find((n: Node) => n.id === focusId)
    if (!node) return
    setHandled(focusId)
    // Center on the node (offset by half node size to target center)
    const x = node.position.x + NODE_WIDTH / 2
    const y = node.position.y + NODE_HEIGHT / 2
    // Small delay to ensure the flow is mounted
    setTimeout(() => {
      setCenter(x, y, { duration: 400, zoom: 1 })
    }, 100)
  })

  return null
}

export function AtomDetailView(props: {
  atoms: Atom[]
  relations: Relation[]
  loading: boolean
  error: boolean
  focusAtomId?: string | null
  onAtomClick: (atomId: string) => void
  onAtomCreate: (input: { name: string; type: AtomKind }) => Promise<Atom>
  onAtomDelete: (atomId: string) => Promise<void>
  onRelationCreate: (input: { sourceAtomId: string; targetAtomId: string; relationType: string }) => Promise<void>
  onRelationUpdate: (input: { sourceAtomId: string; targetAtomId: string; relationType: string; nextRelationType: string }) => Promise<void>
  onRelationDelete: (input: { sourceAtomId: string; targetAtomId: string; relationType: string }) => Promise<void>
  researchProjectId: string
}) {
  const layoutResult = () => computeLayout(props.atoms, props.relations)
  const initialNodes = () => atomsToNodes(props.atoms, layoutResult().positions)
  const initialEdges = () => relationsToEdges(props.relations)

  const [nodes, setNodes] = createNodeStore<typeof nodeTypes>(initialNodes())
  const [edges, setEdges] = createEdgeStore(initialEdges())

  // Sync when atoms/relations change from outside
  createEffect(
    on(
      () => [props.atoms, props.relations] as const,
      ([atoms, relations]) => {
        const { positions: pos } = computeLayout(atoms, relations)
        // Preserve existing positions for nodes that already exist
        const existingPositions: Record<string, { x: number; y: number }> = {}
        for (const node of nodes) {
          existingPositions[node.id] = node.position
        }
        const mergedPositions = { ...pos }
        for (const id of Object.keys(mergedPositions)) {
          if (pendingPositions[id]) {
            mergedPositions[id] = pendingPositions[id]
            delete pendingPositions[id]
          } else if (existingPositions[id]) {
            mergedPositions[id] = existingPositions[id]
          }
        }
        const newNodes = atomsToNodes(atoms, mergedPositions)
        const newEdges = relationsToEdges(relations)
        setNodes(newNodes as any)
        setEdges(newEdges as any)
      },
      { defer: true },
    ),
  )

  // Relation type picker state
  const [pendingConnection, setPendingConnection] = createSignal<{ source: string; target: string; edgeId: string } | null>(null)
  const [pickerPos, setPickerPos] = createSignal<{ x: number; y: number }>({ x: 0, y: 0 })

  // Edge click for editing/deleting relations
  const [selectedEdge, setSelectedEdge] = createSignal<{ id: string; source: string; target: string; relationType: string } | null>(null)
  const [edgeMenuPos, setEdgeMenuPos] = createSignal<{ x: number; y: number }>({ x: 0, y: 0 })

  // Create atom form
  const [showCreateForm, setShowCreateForm] = createSignal(false)
  const [createFormPos, setCreateFormPos] = createSignal<{ x: number; y: number }>({ x: 0, y: 0 })
  const [createFlowPos, setCreateFlowPos] = createSignal<{ x: number; y: number }>({ x: 0, y: 0 })
  const [newAtomName, setNewAtomName] = createSignal("")
  const [newAtomType, setNewAtomType] = createSignal<AtomKind>("fact")

  // Store pending positions for newly created atoms (before sync effect picks them up)
  const pendingPositions: Record<string, { x: number; y: number }> = {}
  // Ref for screenToFlowPosition from inside SolidFlow
  let screenToFlowRef: ((pos: { x: number; y: number }) => { x: number; y: number }) | undefined

  const onConnect = (connection: EdgeConnection) => {
    if (connection.source && connection.target && connection.source !== connection.target) {
      // solid-flow auto-adds the edge; store its id so we can remove it if user cancels
      setPendingConnection({ source: connection.source, target: connection.target, edgeId: connection.id })
      setPickerPos({ x: window.innerWidth / 2 - 100, y: window.innerHeight / 2 - 100 })
    }
  }

  const cancelPendingConnection = () => {
    const conn = pendingConnection()
    if (conn) {
      // Remove the auto-added edge
      setEdges((prev: any[]) => prev.filter((e: any) => e.id !== conn.edgeId))
    }
    setPendingConnection(null)
  }

  const handleRelationTypeSelect = async (relationType: string) => {
    const conn = pendingConnection()
    if (!conn) return
    // Remove the auto-added temp edge; server data will re-add it properly
    setEdges((prev: any[]) => prev.filter((e: any) => e.id !== conn.edgeId))
    setPendingConnection(null)
    await props.onRelationCreate({
      sourceAtomId: conn.source,
      targetAtomId: conn.target,
      relationType,
    })
  }

  const handleEdgeClick = ({ edge, event }: { edge: Edge; event: MouseEvent }) => {
    const data = edge.data as { relationType?: string } | undefined
    if (!data?.relationType) return
    setSelectedEdge({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      relationType: data.relationType,
    })
    setEdgeMenuPos({ x: event.clientX, y: event.clientY })
  }

  const handleEdgeDelete = async () => {
    const edge = selectedEdge()
    if (!edge) return
    setSelectedEdge(null)
    await props.onRelationDelete({
      sourceAtomId: edge.source,
      targetAtomId: edge.target,
      relationType: edge.relationType,
    })
  }

  const handleEdgeTypeChange = async (nextType: string) => {
    const edge = selectedEdge()
    if (!edge) return
    setSelectedEdge(null)
    await props.onRelationUpdate({
      sourceAtomId: edge.source,
      targetAtomId: edge.target,
      relationType: edge.relationType,
      nextRelationType: nextType,
    })
  }

  const handleNodeClick = ({ node }: { node: Node; event: MouseEvent | TouchEvent }) => {
    props.onAtomClick(node.id)
  }

  const handlePaneContextMenu = ({ event }: { event: MouseEvent | PointerEvent }) => {
    event.preventDefault()
    event.stopPropagation()
    setCreateFormPos({ x: event.clientX, y: event.clientY })
    if (screenToFlowRef) {
      setCreateFlowPos(screenToFlowRef({ x: event.clientX, y: event.clientY }))
    }
    setShowCreateForm(true)
    setNewAtomName("")
    setNewAtomType("fact")
  }

  const handleCreateAtom = async () => {
    const name = newAtomName().trim()
    if (!name) return
    setShowCreateForm(false)
    const flowPos = createFlowPos()
    const atom = await props.onAtomCreate({ name, type: newAtomType() })
    if (atom?.atom_id) {
      pendingPositions[atom.atom_id] = flowPos
    }
  }

  // Close popups on click outside
  const handlePaneClick = (_args: { event: MouseEvent }) => {
    cancelPendingConnection()
    setSelectedEdge(null)
    setShowCreateForm(false)
  }

  // Delete selected nodes via keyboard
  const handleKeyDown = async (event: KeyboardEvent) => {
    if (event.key !== "Delete" && event.key !== "Backspace") return
    const target = event.target as HTMLElement | null
    const tag = target?.tagName
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return
    const selected = nodes.filter((n: any) => n.selected)
    for (const node of selected) {
      await props.onAtomDelete(node.id)
    }
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown)
  })
  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown)
  })

  let containerRef!: HTMLDivElement
  const defaultViewport = () => {
    const gh = layoutResult().graphHeight
    const containerH = containerRef?.clientHeight ?? window.innerHeight
    const yOffset = Math.max(0, (containerH - gh) / 2)
    return { x: 40, y: yOffset, zoom: 1 }
  }

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%", position: "relative" }}>
      <Show when={props.loading && props.atoms.length === 0}>
        <div style={{ position: "absolute", inset: "0", display: "flex", "align-items": "center", "justify-content": "center", "z-index": "10", color: "#94a3b8", "font-size": "13px" }}>
          Loading...
        </div>
      </Show>

      <Show when={props.error}>
        <div style={{ position: "absolute", inset: "0", display: "flex", "align-items": "center", "justify-content": "center", "z-index": "10", color: "#f87171", "font-size": "13px" }}>
          Failed to load atoms
        </div>
      </Show>

      <SolidFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        onPaneContextMenu={handlePaneContextMenu}
        initialViewport={defaultViewport()}
        proOptions={{ hideAttribution: true }}
        style={{ width: "100%", height: "100%" }}
        colorMode="dark"
      >
        <Controls />
        <MiniMap />
        <Background variant={"dots" as any} />
        <FocusHandler focusAtomId={props.focusAtomId} nodes={nodes} />
        <ScreenToFlowBridge onReady={(fn) => { screenToFlowRef = fn }} />
      </SolidFlow>

      {/* Relation Type Picker (on connect) */}
      <Show when={pendingConnection()}>
        <div
          style={{
            position: "fixed",
            left: `${pickerPos().x}px`,
            top: `${pickerPos().y}px`,
            "z-index": "60",
            background: "#1e293b",
            border: "1px solid #334155",
            "border-radius": "8px",
            padding: "8px",
            "box-shadow": "0 8px 24px rgba(0,0,0,0.4)",
            "min-width": "160px",
          }}
        >
          <div style={{ "font-size": "11px", color: "#94a3b8", "margin-bottom": "6px", padding: "0 4px" }}>Select relation type</div>
          <For each={RELATION_TYPE_OPTIONS}>
            {(type) => (
              <button
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "8px",
                  width: "100%",
                  padding: "6px 8px",
                  border: "none",
                  background: "transparent",
                  color: "#e2e8f0",
                  "font-size": "12px",
                  cursor: "pointer",
                  "border-radius": "4px",
                  "text-align": "left",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#334155")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                onClick={() => handleRelationTypeSelect(type)}
              >
                <span style={{ width: "8px", height: "8px", "border-radius": "50%", background: RELATION_COLORS[type], "flex-shrink": "0" }} />
                {RELATION_LABELS[type]}
              </button>
            )}
          </For>
        </div>
      </Show>

      {/* Edge Context Menu (on edge click) */}
      <Show when={selectedEdge()}>
        {(edge) => (
          <div
            style={{
              position: "fixed",
              left: `${edgeMenuPos().x}px`,
              top: `${edgeMenuPos().y}px`,
              "z-index": "60",
              background: "#1e293b",
              border: "1px solid #334155",
              "border-radius": "8px",
              padding: "8px",
              "box-shadow": "0 8px 24px rgba(0,0,0,0.4)",
              "min-width": "160px",
            }}
          >
            <div style={{ "font-size": "11px", color: "#94a3b8", "margin-bottom": "6px", padding: "0 4px" }}>Change type or delete</div>
            <For each={RELATION_TYPE_OPTIONS}>
              {(type) => (
                <button
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "8px",
                    width: "100%",
                    padding: "6px 8px",
                    border: "none",
                    background: type === edge().relationType ? "#334155" : "transparent",
                    color: "#e2e8f0",
                    "font-size": "12px",
                    cursor: "pointer",
                    "border-radius": "4px",
                    "text-align": "left",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#334155")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = type === edge().relationType ? "#334155" : "transparent")}
                  onClick={() => handleEdgeTypeChange(type)}
                >
                  <span style={{ width: "8px", height: "8px", "border-radius": "50%", background: RELATION_COLORS[type], "flex-shrink": "0" }} />
                  {RELATION_LABELS[type]}
                  <Show when={type === edge().relationType}>
                    <span style={{ "margin-left": "auto", color: "#60a5fa", "font-size": "11px" }}>current</span>
                  </Show>
                </button>
              )}
            </For>
            <div style={{ "border-top": "1px solid #334155", "margin-top": "4px", "padding-top": "4px" }}>
              <button
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "8px",
                  width: "100%",
                  padding: "6px 8px",
                  border: "none",
                  background: "transparent",
                  color: "#f87171",
                  "font-size": "12px",
                  cursor: "pointer",
                  "border-radius": "4px",
                  "text-align": "left",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#334155")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                onClick={handleEdgeDelete}
              >
                Delete relation
              </button>
            </div>
          </div>
        )}
      </Show>

      {/* Create Atom Form (on right-click) */}
      <Show when={showCreateForm()}>
        <div
          style={{
            position: "fixed",
            left: `${createFormPos().x}px`,
            top: `${createFormPos().y}px`,
            "z-index": "60",
            background: "#1e293b",
            border: "1px solid #334155",
            "border-radius": "8px",
            padding: "12px",
            "box-shadow": "0 8px 24px rgba(0,0,0,0.4)",
            "min-width": "220px",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ "font-size": "12px", "font-weight": "600", color: "#f1f5f9", "margin-bottom": "8px" }}>Create Atom</div>
          <input
            type="text"
            placeholder="Atom name"
            value={newAtomName()}
            onInput={(e) => setNewAtomName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateAtom()
              if (e.key === "Escape") setShowCreateForm(false)
              e.stopPropagation()
            }}
            style={{
              width: "100%",
              padding: "6px 8px",
              border: "1px solid #334155",
              "border-radius": "4px",
              background: "#0f172a",
              color: "#e2e8f0",
              "font-size": "12px",
              outline: "none",
              "margin-bottom": "8px",
              "box-sizing": "border-box",
            }}
            autofocus
          />
          <div style={{ display: "flex", gap: "4px", "flex-wrap": "wrap", "margin-bottom": "8px" }}>
            <For each={ATOM_TYPE_OPTIONS}>
              {(type) => (
                <button
                  style={{
                    padding: "3px 8px",
                    border: newAtomType() === type ? "1px solid #60a5fa" : "1px solid #334155",
                    "border-radius": "4px",
                    background: newAtomType() === type ? "#1e3a5f" : "transparent",
                    color: "#e2e8f0",
                    "font-size": "11px",
                    cursor: "pointer",
                  }}
                  onClick={() => setNewAtomType(type)}
                >
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </button>
              )}
            </For>
          </div>
          <div style={{ display: "flex", gap: "6px", "justify-content": "flex-end" }}>
            <button
              style={{
                padding: "4px 10px",
                border: "1px solid #334155",
                "border-radius": "4px",
                background: "transparent",
                color: "#94a3b8",
                "font-size": "11px",
                cursor: "pointer",
              }}
              onClick={() => setShowCreateForm(false)}
            >
              Cancel
            </button>
            <button
              style={{
                padding: "4px 10px",
                border: "none",
                "border-radius": "4px",
                background: "#3b82f6",
                color: "#fff",
                "font-size": "11px",
                cursor: "pointer",
              }}
              onClick={handleCreateAtom}
            >
              Create
            </button>
          </div>
        </div>
      </Show>

    </div>
  )
}
