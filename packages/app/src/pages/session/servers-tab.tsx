import { createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogPathPicker } from "@/components/dialog-new-research-project"

type DirectServerConfig = {
  mode: "direct"
  address: string
  port: number
  user: string
  password?: string
  resource_root?: string
  wandb_api_key?: string
  wandb_project_name?: string
}

type SshConfigServerConfig = {
  mode: "ssh_config"
  host_alias: string
  ssh_config_path?: string
  user?: string
  password?: string
  resource_root?: string
  wandb_api_key?: string
  wandb_project_name?: string
}

type LegacyDirectServerConfig = Omit<DirectServerConfig, "mode">

type ServerConfig = DirectServerConfig | SshConfigServerConfig | LegacyDirectServerConfig

interface ServerRow {
  id: string
  config: ServerConfig
  time_created: number
  time_updated: number
}

export function ServersTab() {
  const sdk = useSDK()
  const dialog = useDialog()
  const [servers, setServers] = createSignal<ServerRow[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal(false)
  const [adding, setAdding] = createSignal(false)

  // Form fields
  const [formAddress, setFormAddress] = createSignal("")
  const [formPort, setFormPort] = createSignal("22")
  const [formUser, setFormUser] = createSignal("root")
  const [formPassword, setFormPassword] = createSignal("")
  const [formResourceRoot, setFormResourceRoot] = createSignal("")
  const [formWandbApiKey, setFormWandbApiKey] = createSignal("")
  const [formWandbProject, setFormWandbProject] = createSignal("")

  const fetchServers = async () => {
    try {
      setLoading(true)
      setError(false)
      const res = await sdk.client.research.server.list()
      if (res.data) {
        setServers(res.data as ServerRow[])
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    fetchServers()
  })

  const handleDelete = async (serverId: string) => {
    await sdk.client.research.server.delete({ serverId })
    setServers((prev) => prev.filter((s) => s.id !== serverId))
  }

  const handleAdd = async () => {
    const port = parseInt(formPort(), 10)
    if (!formAddress() || isNaN(port) || !formUser()) return

    try {
      const res = await sdk.client.research.server.create({
        config: {
          mode: "direct",
          address: formAddress(),
          port,
          user: formUser(),
          ...(formPassword() ? { password: formPassword() } : {}),
          ...(formResourceRoot() ? { resource_root: formResourceRoot() } : {}),
          ...(formWandbApiKey() ? { wandb_api_key: formWandbApiKey() } : {}),
          ...(formWandbProject() ? { wandb_project_name: formWandbProject() } : {}),
        } as any,
      })
      if (res.data) {
        await fetchServers()
      }
      resetForm()
      setAdding(false)
    } catch (e) {
      console.error("Failed to create server", e)
    }
  }

  const resetForm = () => {
    setFormAddress("")
    setFormPort("22")
    setFormUser("root")
    setFormPassword("")
    setFormResourceRoot("")
    setFormWandbApiKey("")
    setFormWandbProject("")
  }

  const describe = (config: ServerConfig) => {
    if ("mode" in config && config.mode === "ssh_config") {
      const user = config.user ? `${config.user}@` : ""
      return `${user}${config.host_alias}`
    }
    return `${config.user}@${config.address}:${config.port}`
  }

  const handleImport = () => {
    dialog.show(() => (
      <DialogPathPicker
        title="Select SSH Config"
        mode="files"
        multiple={false}
        startDir={() => "/Users/hg/.ssh"}
        onClose={() => dialog.close()}
        onSelect={async (value) => {
          const file = Array.isArray(value) ? value[0] : value
          if (!file) return
          dialog.close()
          try {
            const res = await fetch(`${sdk.url}/research/server/import-ssh-config`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-opencode-directory": sdk.directory,
              },
              body: JSON.stringify({ path: file }),
            })
            if (!res.ok) {
              const text = await res.text()
              throw new Error(text || `Import failed: ${res.status}`)
            }
            await fetchServers()
          } catch (error) {
            console.error("Failed to import SSH config", error)
          }
        }}
      />
    ))
  }

  return (
    <div class="relative flex-1 min-h-0 overflow-hidden h-full flex flex-col">
      <div class="px-3 pt-3 pb-1 flex items-center justify-between">
        <div class="text-12-semibold text-text-weak uppercase tracking-wider">Remote Servers</div>
        <div class="flex items-center gap-2">
          <button
            class="px-2 py-1 rounded text-11-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors"
            onClick={handleImport}
          >
            Import SSH Config
          </button>
          <button
            class="px-2 py-1 rounded text-11-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors"
            onClick={() => setAdding(!adding())}
          >
            {adding() ? "Cancel" : "+ Add"}
          </button>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-auto px-3 pb-3">
        {/* Add form */}
        <Show when={adding()}>
          <div class="rounded-md border border-border-weak-base bg-background-base p-3 mb-2 flex flex-col gap-2">
            <div class="flex gap-2">
              <input
                type="text"
                placeholder="Address"
                value={formAddress()}
                onInput={(e) => setFormAddress(e.currentTarget.value)}
                class="flex-1 rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
              />
              <input
                type="text"
                placeholder="Port"
                value={formPort()}
                onInput={(e) => setFormPort(e.currentTarget.value)}
                class="w-16 rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
              />
            </div>
            <div class="flex gap-2">
              <input
                type="text"
                placeholder="User"
                value={formUser()}
                onInput={(e) => setFormUser(e.currentTarget.value)}
                class="flex-1 rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
              />
              <input
                type="password"
                placeholder="Password"
                value={formPassword()}
                onInput={(e) => setFormPassword(e.currentTarget.value)}
                class="flex-1 rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
              />
            </div>
            <div class="flex gap-2">
              <input
                type="text"
                placeholder="Resource Root (/data/opencode)"
                value={formResourceRoot()}
                onInput={(e) => setFormResourceRoot(e.currentTarget.value)}
                class="flex-1 rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
              />
            </div>
            <div class="flex gap-2">
              <input
                type="text"
                placeholder="W&B Project Name"
                value={formWandbProject()}
                onInput={(e) => setFormWandbProject(e.currentTarget.value)}
                class="flex-1 rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
              />
              <input
                type="password"
                placeholder="W&B API Key"
                value={formWandbApiKey()}
                onInput={(e) => setFormWandbApiKey(e.currentTarget.value)}
                class="flex-1 rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
              />
            </div>
            <button
              class="self-end px-3 py-1 rounded text-12-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors"
              onClick={handleAdd}
            >
              Save
            </button>
          </div>
        </Show>

        {/* Server list */}
        <Switch>
          <Match when={loading() && servers().length === 0}>
            <div class="flex items-center justify-center py-10 text-12-regular text-text-weak">Loading...</div>
          </Match>
          <Match when={error()}>
            <div class="flex items-center justify-center py-10 text-12-regular text-text-weak">
              Failed to load servers
            </div>
          </Match>
          <Match when={servers().length === 0}>
            <div class="flex items-center justify-center py-10 text-12-regular text-text-weak">
              No remote servers configured
            </div>
          </Match>
          <Match when={true}>
            <div class="flex flex-col gap-2">
              {/* Table header */}
              <div class="grid grid-cols-[1fr_80px_80px_minmax(120px,1fr)_40px] gap-2 px-2 py-1 text-11-regular text-text-weak uppercase tracking-wider">
                <div>Target</div>
                <div>Mode</div>
                <div>User</div>
                <div>Resource Root</div>
                <div />
              </div>
              <For each={servers()}>
                {(server) => (
                  <div class="grid grid-cols-[1fr_80px_80px_minmax(120px,1fr)_40px] gap-2 items-center rounded-md border border-border-weak-base bg-background-base px-2 py-2 text-12-regular text-text-base">
                    <div class="truncate" title={describe(server.config)}>
                      {describe(server.config)}
                    </div>
                    <div>{"mode" in server.config && server.config.mode === "ssh_config" ? "config" : "direct"}</div>
                    <div class="truncate">{server.config.user ?? "-"}</div>
                    <div class="truncate" title={server.config.resource_root ?? ""}>
                      {server.config.resource_root ?? "-"}
                    </div>
                    <button
                      class="text-text-weak hover:text-text-strong transition-colors text-11-regular"
                      onClick={() => handleDelete(server.id)}
                      title="Delete server"
                    >
                      Del
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
