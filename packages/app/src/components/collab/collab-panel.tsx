import { createResource, createSignal, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { CollabAgentTree } from "./collab-agent-tree"
import { CollabAgentDetail } from "./collab-agent-detail"
import { CollabInboxTimeline } from "./collab-inbox-timeline"

type Props = {
  directory: string
  sessionID: string
}

export function CollabPanel(props: Props) {
  const sdk = useGlobalSDK()

  const [binding] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      const res = await sdk.client.collab.session.agent.get({
        sessionId: sessionID,
        directory: props.directory,
      })
      return res.data?.agent ?? null
    },
  )

  const [selected, setSelected] = createSignal<string | undefined>(undefined)

  const activeAgent = () => selected() ?? binding()?.id

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%", width: "100%" }}>
      <Show
        when={binding()}
        fallback={
          <div style={{ padding: "16px", opacity: 0.7 }}>
            This session is not a Collab agent. Use the <code>spawn_agent</code> tool to bootstrap one.
          </div>
        }
      >
        {(info) => (
          <div style={{ display: "flex", flex: 1, "min-height": 0, gap: "8px" }}>
            <div
              style={{ width: "40%", "overflow-y": "auto", "border-right": "1px solid var(--sl-color-hairline, #333)" }}
            >
              <div
                style={{
                  padding: "8px",
                  "font-weight": 600,
                  "border-bottom": "1px solid var(--sl-color-hairline, #333)",
                }}
              >
                Agent Tree · root: {info().root_agent_id}
              </div>
              <CollabAgentTree
                directory={props.directory}
                rootAgentId={info().root_agent_id}
                onSelect={setSelected}
                selectedAgentId={activeAgent()}
              />
            </div>
            <div style={{ flex: 1, display: "flex", "flex-direction": "column", "min-width": 0 }}>
              <Show when={activeAgent()} fallback={<div style={{ padding: "16px" }}>Select an agent…</div>}>
                {(id) => (
                  <div style={{ display: "flex", "flex-direction": "column", flex: 1, "min-height": 0 }}>
                    <div style={{ "border-bottom": "1px solid var(--sl-color-hairline, #333)" }}>
                      <CollabAgentDetail directory={props.directory} agentId={id()} />
                    </div>
                    <div style={{ flex: 1, "overflow-y": "auto" }}>
                      <CollabInboxTimeline directory={props.directory} agentId={id()} />
                    </div>
                  </div>
                )}
              </Show>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
