import { createResource, For, Show, createEffect, onCleanup } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import type { CollabAgent } from "@opencode-ai/sdk/v2/client"

type Props = {
  directory: string
  rootAgentId: string
  onSelect?: (agentId: string) => void
  selectedAgentId?: string
}

const STATUS_COLOR: Record<string, string> = {
  pending: "var(--sl-color-text-secondary, #888)",
  running: "var(--sl-color-green, #2ea043)",
  blocked_on_children: "var(--sl-color-yellow, #d4a017)",
  completed: "var(--sl-color-blue, #3b82f6)",
  failed: "var(--sl-color-red, #da3633)",
  canceled: "var(--sl-color-gray, #6b7280)",
}

export function CollabAgentTree(props: Props) {
  const sdk = useGlobalSDK()

  const fetchTree = async () => {
    const res = await sdk.client.collab.tree.get({
      rootAgentId: props.rootAgentId,
      directory: props.directory,
    })
    return res.data ?? null
  }

  const [tree, { refetch }] = createResource(() => props.rootAgentId, fetchTree)

  createEffect(() => {
    const off = sdk.event.on(props.directory, (e) => {
      if (
        e.type === "collab.agent.status" ||
        e.type === "collab.agent.completed" ||
        e.type === "collab.agent.failed" ||
        e.type === "collab.agent.created"
      ) {
        void refetch()
      }
    })
    onCleanup(() => off())
  })

  const childrenOf = (nodes: CollabAgent[], parentId: string | null) =>
    nodes.filter((n) => n.parent_agent_id === parentId)

  return (
    <div class="collab-agent-tree" style={{ "font-size": "13px", "font-family": "var(--sl-font-mono, monospace)" }}>
      <Show when={tree()} fallback={<div>Loading tree…</div>}>
        {(t) => (
          <TreeNode
            node={t().root}
            nodes={t().nodes}
            childrenOf={childrenOf}
            depth={0}
            onSelect={props.onSelect}
            selectedAgentId={props.selectedAgentId}
          />
        )}
      </Show>
    </div>
  )
}

type NodeProps = {
  node: CollabAgent
  nodes: CollabAgent[]
  childrenOf: (nodes: CollabAgent[], parentId: string | null) => CollabAgent[]
  depth: number
  onSelect?: (id: string) => void
  selectedAgentId?: string
}

function TreeNode(props: NodeProps) {
  const children = () => props.childrenOf(props.nodes, props.node.id)
  const color = () => STATUS_COLOR[props.node.status] ?? "inherit"
  const selected = () => props.node.id === props.selectedAgentId
  return (
    <div>
      <div
        style={{
          "padding-left": `${props.depth * 16}px`,
          cursor: "pointer",
          padding: "2px 4px",
          background: selected() ? "rgba(100,100,255,0.1)" : "transparent",
          "border-left": `3px solid ${color()}`,
        }}
        onClick={() => props.onSelect?.(props.node.id)}
      >
        <span style={{ color: color(), "font-weight": 600 }}>{props.node.status}</span>
        {" · "}
        <span>{props.node.name}</span> <span style={{ opacity: 0.6 }}>[{props.node.subagent_type}]</span>
        {props.node.active_children > 0 && (
          <span style={{ opacity: 0.7 }}> · children: {props.node.active_children}</span>
        )}
      </div>
      <For each={children()}>
        {(child) => (
          <TreeNode
            node={child}
            nodes={props.nodes}
            childrenOf={props.childrenOf}
            depth={props.depth + 1}
            onSelect={props.onSelect}
            selectedAgentId={props.selectedAgentId}
          />
        )}
      </For>
    </div>
  )
}
