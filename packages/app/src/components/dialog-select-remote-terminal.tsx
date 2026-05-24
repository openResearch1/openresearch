import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { List } from "@opencode-ai/ui/list"
import { createResource } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

type Direct = {
  mode: "direct"
  address: string
  port: number
  user: string
}

type Config =
  | Direct
  | {
      mode: "ssh_config"
      host_alias: string
      user?: string
    }
  | Omit<Direct, "mode">

type Server = {
  id: string
  config: Config
}

const label = (config: Config) => {
  if ("mode" in config && config.mode === "ssh_config") {
    const user = config.user ? `${config.user}@` : ""
    return `${user}${config.host_alias}`
  }
  return `${config.user}@${config.address}:${config.port}`
}

export function DialogSelectRemoteTerminal(props: { onSelect: (serverId: string, label: string) => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const language = useLanguage()
  const [servers] = createResource(async () => {
    const res = await sdk.client.research.server.list()
    return (res.data ?? []) as Server[]
  })

  const handleSelect = (server: Server | undefined) => {
    if (!server) return
    dialog.close()
    props.onSelect(server.id, label(server.config))
  }

  return (
    <Dialog class="pt-3 pb-0 !max-h-[420px]" transition>
      <List
        search={{
          placeholder: language.t("terminal.remote.search"),
          autofocus: true,
          hideIcon: true,
        }}
        emptyMessage={language.t("terminal.remote.empty")}
        loadingMessage={language.t("common.loading")}
        items={(text) => {
          const query = text.trim().toLowerCase()
          const list = servers() ?? []
          if (!query) return list
          return list.filter((server) => label(server.config).toLowerCase().includes(query))
        }}
        key={(server) => server.id}
        filterKeys={["id"]}
        onSelect={handleSelect}
      >
        {(server) => (
          <div class="w-full flex items-center justify-between gap-4 rounded-md pl-1">
            <div class="flex items-center gap-x-3 min-w-0">
              <Icon name="server" size="small" class="shrink-0 text-icon-weak" />
              <div class="flex flex-col min-w-0">
                <span class="text-14-regular text-text-strong truncate">{label(server.config)}</span>
                <span class="text-12-regular text-text-weak truncate">
                  {"mode" in server.config && server.config.mode === "ssh_config" ? "SSH config" : "Direct SSH"}
                </span>
              </div>
            </div>
          </div>
        )}
      </List>
    </Dialog>
  )
}
