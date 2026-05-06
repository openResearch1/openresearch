import { createResource, createSignal, For, Show, createEffect, onCleanup } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import type { CollabMessage as CollabMessageInfo } from "@opencode-ai/sdk/v2/client"

const KIND_FILTERS = ["all", "child_progress", "child_done", "child_failed", "cancel", "user_input", "system"] as const
type KindFilter = (typeof KIND_FILTERS)[number]

type Props = {
  directory: string
  agentId: string
}

export function CollabInboxTimeline(props: Props) {
  const sdk = useGlobalSDK()
  const [filter, setFilter] = createSignal<KindFilter>("all")

  const [data, { refetch }] = createResource(
    () => ({ agentId: props.agentId, filter: filter() }),
    async ({ agentId, filter }) => {
      const params: {
        agentId: string
        directory: string
        limit?: number
        kind?: Exclude<KindFilter, "all">
      } = { agentId, directory: props.directory, limit: 200 }
      if (filter !== "all") params.kind = filter
      const res = await sdk.client.collab.agent.messages(params)
      return res.data?.messages ?? []
    },
  )

  createEffect(() => {
    const off = sdk.event.on(props.directory, (e) => {
      if (
        (e.type === "collab.message.posted" || e.type === "collab.message.consumed") &&
        e.properties.recipientAgentId === props.agentId
      ) {
        void refetch()
      }
    })
    onCleanup(() => off())
  })

  return (
    <div class="collab-inbox-timeline" style={{ padding: "8px", "font-size": "13px" }}>
      <div style={{ "margin-bottom": "8px" }}>
        <label>Filter: </label>
        <select value={filter()} onChange={(e) => setFilter(e.currentTarget.value as KindFilter)}>
          <For each={KIND_FILTERS}>{(k) => <option value={k}>{k}</option>}</For>
        </select>
        <span style={{ "margin-left": "8px", opacity: 0.6 }}>({data()?.length ?? 0} msg)</span>
      </div>
      <Show when={data()} fallback={<div>Loading…</div>}>
        {(rows) => (
          <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
            <For each={[...rows()].reverse()}>{(row) => <MessageRow row={row} />}</For>
          </div>
        )}
      </Show>
    </div>
  )
}

function MessageRow(props: { row: CollabMessageInfo }) {
  const [expanded, setExpanded] = createSignal(false)
  const payloadText = () => {
    try {
      return JSON.stringify(props.row.payload, null, 2)
    } catch {
      return String(props.row.payload)
    }
  }
  const kindColor: Record<string, string> = {
    child_done: "#2ea043",
    child_failed: "#da3633",
    child_progress: "#3b82f6",
    cancel: "#d4a017",
    user_input: "#6b7280",
    system: "#999",
  }
  const color = kindColor[props.row.kind] ?? "#666"
  return (
    <div style={{ "border-left": `3px solid ${color}`, padding: "4px 8px" }}>
      <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
        <span style={{ color, "font-weight": 600 }}>{props.row.kind}</span>
        <span style={{ opacity: 0.6, "font-size": "11px" }}>
          {new Date(props.row.time_created).toLocaleTimeString()} · {props.row.status}
        </span>
        <Show when={props.row.sender_agent_id}>
          <span style={{ opacity: 0.6, "font-size": "11px" }}>from {props.row.sender_agent_id}</span>
        </Show>
        <button style={{ "margin-left": "auto", "font-size": "11px" }} onClick={() => setExpanded(!expanded())}>
          {expanded() ? "hide" : "show"}
        </button>
      </div>
      <Show when={expanded()}>
        <pre
          style={{
            "white-space": "pre-wrap",
            "font-size": "11px",
            "margin-top": "4px",
            "max-height": "200px",
            overflow: "auto",
          }}
        >
          {payloadText()}
        </pre>
      </Show>
    </div>
  )
}
