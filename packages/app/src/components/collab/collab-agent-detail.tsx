import { createResource, Show, createEffect, onCleanup } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"

type Props = {
  directory: string
  agentId: string
}

export function CollabAgentDetail(props: Props) {
  const sdk = useGlobalSDK()
  const [info, { refetch }] = createResource(
    () => props.agentId,
    async (agentId) => {
      const res = await sdk.client.collab.agent.get({ agentId, directory: props.directory })
      return res.data ?? null
    },
  )

  createEffect(() => {
    const off = sdk.event.on(props.directory, (e) => {
      if (
        (e.type === "collab.agent.status" && e.properties.agentId === props.agentId) ||
        (e.type === "collab.agent.completed" && e.properties.agentId === props.agentId) ||
        (e.type === "collab.agent.failed" && e.properties.agentId === props.agentId)
      ) {
        void refetch()
      }
    })
    onCleanup(() => off())
  })

  const cancel = async () => {
    await sdk.client.collab.agent.cancel({
      agentId: props.agentId,
      directory: props.directory,
      reason: "Canceled from UI",
    })
    void refetch()
  }

  return (
    <div class="collab-agent-detail" style={{ padding: "8px", "font-size": "13px" }}>
      <Show when={info()} fallback={<div>Loading…</div>}>
        {(i) => (
          <div>
            <div style={{ "font-weight": 600, "margin-bottom": "4px" }}>{i().name}</div>
            <div>
              agent_id: <code>{i().id}</code>
            </div>
            <div>
              session_id: <code>{i().session_id}</code>
            </div>
            <div>subagent_type: {i().subagent_type}</div>
            <div>
              status: <strong>{i().status}</strong> (phase {i().phase})
            </div>
            <div>active_children: {i().active_children}</div>
            <div>spawned_total: {i().spawned_total}</div>
            <div>created: {new Date(i().time_created).toLocaleString()}</div>
            <Show when={i().time_started}>
              <div>started: {new Date(i().time_started!).toLocaleString()}</div>
            </Show>
            <Show when={i().time_ended}>
              <div>ended: {new Date(i().time_ended!).toLocaleString()}</div>
            </Show>
            <Show when={i().result?.summary}>
              <div style={{ "margin-top": "8px" }}>
                <strong>Summary</strong>
                <pre style={{ "white-space": "pre-wrap", "max-height": "240px", overflow: "auto" }}>
                  {i().result!.summary}
                </pre>
              </div>
            </Show>
            <Show when={i().error}>
              <div style={{ "margin-top": "8px", color: "#da3633" }}>
                <strong>Error</strong>
                <div>
                  {i().error!.code}: {i().error!.message}
                </div>
              </div>
            </Show>
            <Show when={["pending", "running", "blocked_on_children"].includes(i().status)}>
              <button style={{ "margin-top": "8px" }} onClick={() => void cancel()}>
                Cancel
              </button>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}
