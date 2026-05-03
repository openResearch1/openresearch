import { createResource, createMemo, For, Show, createEffect, onCleanup } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import type { CollabAgent } from "@opencode-ai/sdk/v2/client"

type Props = {
  directory: string
  sessionID: string
  onSelectChild?: (agentId: string) => void
}

const STATUS_COLOR: Record<string, string> = {
  pending: "#888",
  running: "#3b82f6",
  blocked_on_children: "#d4a017",
  completed: "#2ea043",
  failed: "#da3633",
  canceled: "#6b7280",
}

export function CollabWaitingBanner(props: Props) {
  const sdk = useGlobalSDK()

  const [rootAgent, { refetch: refetchRoot }] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      const res = await sdk.client.collab.session.agent.get({ sessionId: sessionID, directory: props.directory })
      return res.data?.agent ?? null
    },
  )

  const [tree, { refetch: refetchTree }] = createResource(
    () => rootAgent()?.root_agent_id,
    async (rootAgentId) => {
      if (!rootAgentId) return null
      const res = await sdk.client.collab.tree.get({ rootAgentId, directory: props.directory })
      return res.data ?? null
    },
  )

  createEffect(() => {
    const off = sdk.event.on(props.directory, (e) => {
      if (
        e.type === "collab.agent.status" ||
        e.type === "collab.agent.completed" ||
        e.type === "collab.agent.failed" ||
        e.type === "collab.agent.created"
      ) {
        void refetchRoot()
        void refetchTree()
      }
    })
    onCleanup(() => off())
  })

  const activeChildren = createMemo((): CollabAgent[] => {
    const t = tree()
    const root = rootAgent()
    if (!t || !root) return []
    return t.nodes.filter(
      (n) =>
        n.id !== root.id && (n.status === "pending" || n.status === "running" || n.status === "blocked_on_children"),
    )
  })

  const show = createMemo(() => {
    const root = rootAgent()
    if (!root) return false
    return root.status === "blocked_on_children" || (root.active_children > 0 && activeChildren().length > 0)
  })

  return (
    <Show when={show()}>
      <div
        class="collab-waiting-banner"
        style={{
          display: "flex",
          "flex-direction": "column",
          gap: "4px",
          padding: "8px 12px",
          margin: "4px 0",
          "border-left": "3px solid #d4a017",
          background: "rgba(212, 160, 23, 0.08)",
          "font-size": "13px",
        }}
      >
        <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
          <Spinner />
          <strong>
            Waiting on {activeChildren().length} child agent{activeChildren().length === 1 ? "" : "s"}…
          </strong>
        </div>
        <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
          <For each={activeChildren()}>
            {(c) => (
              <div
                style={{
                  display: "flex",
                  gap: "8px",
                  "align-items": "center",
                  padding: "2px 4px",
                  cursor: props.onSelectChild ? "pointer" : "default",
                }}
                onClick={() => props.onSelectChild?.(c.id)}
              >
                <span style={{ color: STATUS_COLOR[c.status] ?? "#888", "font-weight": 600, "font-size": "11px" }}>
                  {c.status}
                </span>
                <span>{c.name}</span>
                <span style={{ opacity: 0.6, "font-size": "11px" }}>[{c.subagent_type}]</span>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

function Spinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: "12px",
        height: "12px",
        border: "2px solid rgba(212, 160, 23, 0.3)",
        "border-top-color": "#d4a017",
        "border-radius": "50%",
        animation: "collab-waiting-spin 0.8s linear infinite",
      }}
    />
  )
}

// Inject keyframes once (SolidJS does not have its own CSS-in-JS).
if (typeof document !== "undefined" && !document.getElementById("collab-waiting-spin-style")) {
  const style = document.createElement("style")
  style.id = "collab-waiting-spin-style"
  style.textContent = "@keyframes collab-waiting-spin { to { transform: rotate(360deg); } }"
  document.head.appendChild(style)
}
