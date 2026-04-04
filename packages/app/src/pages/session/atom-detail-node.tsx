import { Handle, Position, type NodeProps } from "@dschz/solid-flow"

const TYPE_COLORS: Record<string, string> = {
  fact: "#60a5fa",
  method: "#34d399",
  theorem: "#f87171",
  verification: "#fbbf24",
}

const TYPE_LABELS: Record<string, string> = {
  fact: "Fact",
  method: "Method",
  theorem: "Theorem",
  verification: "Verification",
}

const STATUS_COLORS: Record<string, string> = {
  pending: "#64748b",
  in_progress: "#f59e0b",
  proven: "#22c55e",
  disproven: "#f87171",
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  proven: "Proven",
  disproven: "Disproven",
}

export type AtomNodeData = {
  label: string
  atomType: string
  evidenceStatus: string
  evidenceType: string
}

export function AtomNode(props: NodeProps<AtomNodeData, "atom">) {
  const borderColor = () => TYPE_COLORS[props.data.atomType] ?? "#64748b"
  const statusColor = () => STATUS_COLORS[props.data.evidenceStatus] ?? "#64748b"

  return (
    <div
      class="atom-detail-node"
      style={{
        background: "#1e293b",
        border: `2px solid ${borderColor()}`,
        "border-radius": "8px",
        padding: "10px 14px",
        width: "180px",
        "box-shadow": props.selected
          ? `0 0 0 2px ${borderColor()}, 0 4px 12px rgba(0,0,0,0.3)`
          : "0 2px 8px rgba(0,0,0,0.25)",
        cursor: "pointer",
        transition: "box-shadow 0.2s, border-color 0.2s",
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: "8px",
          height: "8px",
          background: "#334155",
          border: "2px solid #475569",
        }}
      />

      <div style={{ "font-size": "12px", "font-weight": "600", color: "#f1f5f9", "margin-bottom": "6px", "line-height": "1.3", "word-break": "break-word" }}>
        {props.data.label}
      </div>

      <div style={{ display: "flex", "align-items": "center", gap: "6px", "flex-wrap": "wrap" }}>
        <span
          style={{
            "font-size": "10px",
            "font-weight": "500",
            padding: "1px 6px",
            "border-radius": "4px",
            background: `${borderColor()}22`,
            color: borderColor(),
          }}
        >
          {TYPE_LABELS[props.data.atomType] ?? props.data.atomType}
        </span>

        <span
          style={{
            "font-size": "10px",
            "font-weight": "500",
            padding: "1px 6px",
            "border-radius": "4px",
            background: `${statusColor()}22`,
            color: statusColor(),
          }}
        >
          {STATUS_LABELS[props.data.evidenceStatus] ?? props.data.evidenceStatus}
        </span>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        style={{
          width: "8px",
          height: "8px",
          background: "#334155",
          border: "2px solid #475569",
        }}
      />
    </div>
  )
}
