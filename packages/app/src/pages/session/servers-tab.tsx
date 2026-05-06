import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogPathPicker } from "@/components/dialog-new-research-project"

type DirectNetwork = {
  mode: "direct"
}

type TunnelNetwork = {
  mode: "tunnel"
  local_proxy: string
  remote_port: number
  no_proxy?: string
}

type ServerNetwork = DirectNetwork | TunnelNetwork

type SharedServerConfig = {
  resource_root?: string
  wandb_api_key?: string
  wandb_project_name?: string
  network?: ServerNetwork
}

type DirectServerConfig = SharedServerConfig & {
  mode: "direct"
  address: string
  port: number
  user: string
  password?: string
}

type SshConfigServerConfig = SharedServerConfig & {
  mode: "ssh_config"
  host_alias: string
  ssh_config_path?: string
  user?: string
  password?: string
}

type LegacyDirectServerConfig = Omit<DirectServerConfig, "mode">

type ServerConfig = DirectServerConfig | SshConfigServerConfig | LegacyDirectServerConfig

interface ServerRow {
  id: string
  config: ServerConfig
  time_created: number
  time_updated: number
}

type Draft = {
  mode: "direct" | "ssh_config"
  address: string
  port: string
  user: string
  password: string
  host_alias: string
  ssh_config_path: string
  resource_root: string
  wandb_api_key: string
  wandb_project_name: string
  network_mode: "direct" | "tunnel"
  local_proxy: string
  remote_port: string
  no_proxy: string
}

function blank(): Draft {
  return {
    mode: "direct",
    address: "",
    port: "22",
    user: "root",
    password: "",
    host_alias: "",
    ssh_config_path: "~/.ssh/config",
    resource_root: "",
    wandb_api_key: "",
    wandb_project_name: "",
    network_mode: "direct",
    local_proxy: "127.0.0.1:7890",
    remote_port: "8890",
    no_proxy: "localhost,127.0.0.1",
  }
}

function normalize(config: ServerConfig): DirectServerConfig | SshConfigServerConfig {
  if ("mode" in config && config.mode === "ssh_config") {
    return {
      ...config,
      network: config.network ?? { mode: "direct" },
    }
  }
  return {
    mode: "direct",
    address: config.address,
    port: config.port,
    user: config.user,
    password: config.password,
    resource_root: config.resource_root,
    wandb_api_key: config.wandb_api_key,
    wandb_project_name: config.wandb_project_name,
    network: config.network ?? { mode: "direct" },
  }
}

function draftFromConfig(config: ServerConfig): Draft {
  const value = normalize(config)
  const net = value.network?.mode === "tunnel" ? value.network : undefined
  if (value.mode === "ssh_config") {
    return {
      mode: "ssh_config",
      address: "",
      port: "22",
      user: value.user ?? "",
      password: value.password ?? "",
      host_alias: value.host_alias,
      ssh_config_path: value.ssh_config_path ?? "~/.ssh/config",
      resource_root: value.resource_root ?? "",
      wandb_api_key: value.wandb_api_key ?? "",
      wandb_project_name: value.wandb_project_name ?? "",
      network_mode: net ? "tunnel" : "direct",
      local_proxy: net?.local_proxy ?? "127.0.0.1:7890",
      remote_port: String(net?.remote_port ?? 8890),
      no_proxy: net?.no_proxy ?? "localhost,127.0.0.1",
    }
  }
  return {
    mode: "direct",
    address: value.address,
    port: String(value.port),
    user: value.user,
    password: value.password ?? "",
    host_alias: "",
    ssh_config_path: "~/.ssh/config",
    resource_root: value.resource_root ?? "",
    wandb_api_key: value.wandb_api_key ?? "",
    wandb_project_name: value.wandb_project_name ?? "",
    network_mode: net ? "tunnel" : "direct",
    local_proxy: net?.local_proxy ?? "127.0.0.1:7890",
    remote_port: String(net?.remote_port ?? 8890),
    no_proxy: net?.no_proxy ?? "localhost,127.0.0.1",
  }
}

function buildConfig(draft: Draft) {
  const network =
    draft.network_mode === "tunnel"
      ? {
          mode: "tunnel" as const,
          local_proxy: draft.local_proxy.trim(),
          remote_port: parseInt(draft.remote_port, 10),
          ...(draft.no_proxy.trim() ? { no_proxy: draft.no_proxy.trim() } : {}),
        }
      : {
          mode: "direct" as const,
        }

  if (draft.mode === "ssh_config") {
    return {
      mode: "ssh_config" as const,
      host_alias: draft.host_alias.trim(),
      ...(draft.ssh_config_path.trim() ? { ssh_config_path: draft.ssh_config_path.trim() } : {}),
      ...(draft.user.trim() ? { user: draft.user.trim() } : {}),
      ...(draft.password.trim() ? { password: draft.password.trim() } : {}),
      ...(draft.resource_root.trim() ? { resource_root: draft.resource_root.trim() } : {}),
      ...(draft.wandb_api_key.trim() ? { wandb_api_key: draft.wandb_api_key.trim() } : {}),
      ...(draft.wandb_project_name.trim() ? { wandb_project_name: draft.wandb_project_name.trim() } : {}),
      network,
    }
  }

  return {
    mode: "direct" as const,
    address: draft.address.trim(),
    port: parseInt(draft.port, 10),
    user: draft.user.trim(),
    ...(draft.password.trim() ? { password: draft.password.trim() } : {}),
    ...(draft.resource_root.trim() ? { resource_root: draft.resource_root.trim() } : {}),
    ...(draft.wandb_api_key.trim() ? { wandb_api_key: draft.wandb_api_key.trim() } : {}),
    ...(draft.wandb_project_name.trim() ? { wandb_project_name: draft.wandb_project_name.trim() } : {}),
    network,
  }
}

function valid(draft: Draft) {
  if (draft.mode === "direct") {
    const port = parseInt(draft.port, 10)
    if (!draft.address.trim() || !draft.user.trim() || !Number.isFinite(port) || port <= 0) return false
  }
  if (draft.mode === "ssh_config") {
    if (!draft.host_alias.trim()) return false
  }
  if (draft.network_mode === "tunnel") {
    const port = parseInt(draft.remote_port, 10)
    if (!draft.local_proxy.trim() || !Number.isFinite(port) || port <= 0) return false
  }
  return true
}

export function ServersTab() {
  const sdk = useSDK()
  const dialog = useDialog()
  const [servers, setServers] = createSignal<ServerRow[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal(false)
  const [adding, setAdding] = createSignal(false)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)
  const [draft, setDraft] = createStore<Draft>(blank())

  const editing = createMemo(() => editingId() !== null)

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
    if (editingId() === serverId) {
      setEditingId(null)
      setDraft(blank())
    }
  }

  const handleCreate = async () => {
    if (!valid(draft)) return
    try {
      setSaving(true)
      await sdk.client.research.server.create({
        config: buildConfig(draft) as any,
      })
      await fetchServers()
      setDraft(blank())
      setAdding(false)
    } catch (e) {
      console.error("Failed to create server", e)
    } finally {
      setSaving(false)
    }
  }

  const handleUpdate = async () => {
    const id = editingId()
    if (!id || !valid(draft)) return
    try {
      setSaving(true)
      const res = await fetch(`${sdk.url}/research/server/${id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": sdk.directory,
        },
        body: JSON.stringify({ config: buildConfig(draft) }),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `Update failed: ${res.status}`)
      }
      await fetchServers()
      setEditingId(null)
      setDraft(blank())
    } catch (e) {
      console.error("Failed to update server", e)
    } finally {
      setSaving(false)
    }
  }

  const startAdd = () => {
    setEditingId(null)
    setDraft(blank())
    setAdding(true)
  }

  const startEdit = (server: ServerRow) => {
    setAdding(false)
    setEditingId(server.id)
    setDraft(draftFromConfig(server.config))
  }

  const cancelEdit = () => {
    setAdding(false)
    setEditingId(null)
    setDraft(blank())
  }

  const describe = (config: ServerConfig) => {
    const value = normalize(config)
    if (value.mode === "ssh_config") {
      const user = value.user ? `${value.user}@` : ""
      return `${user}${value.host_alias}`
    }
    return `${value.user}@${value.address}:${value.port}`
  }

  const networkLabel = (config: ServerConfig) => {
    const value = normalize(config)
    if (value.network?.mode === "tunnel") return `Tunnel:${value.network.remote_port}`
    return "Direct"
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

  const Form = (props: { saveLabel: string; onSave: () => void; onCancel: () => void }) => (
    <div class="rounded-md border border-border-weak-base bg-background-base p-3 mb-2 flex flex-col gap-2">
      <div class="grid grid-cols-2 gap-2">
        <label class="flex flex-col gap-1 text-11-regular text-text-weak">
          <span>Connection</span>
          <select
            value={draft.mode}
            onChange={(e) => setDraft("mode", e.currentTarget.value as Draft["mode"])}
            class="rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
          >
            <option value="direct">Direct SSH</option>
            <option value="ssh_config">SSH Config</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-11-regular text-text-weak">
          <span>Network</span>
          <select
            value={draft.network_mode}
            onChange={(e) => setDraft("network_mode", e.currentTarget.value as Draft["network_mode"])}
            class="rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
          >
            <option value="direct">Direct</option>
            <option value="tunnel">Tunnel</option>
          </select>
        </label>
      </div>

      <Show
        when={draft.mode === "direct"}
        fallback={
          <div class="grid grid-cols-2 gap-2">
            <label class="flex flex-col gap-1 text-11-regular text-text-weak">
              <span>Host Alias</span>
              <input
                type="text"
                placeholder="target-dev-machine-roce"
                value={draft.host_alias}
                onInput={(e) => setDraft("host_alias", e.currentTarget.value)}
                class="rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
              />
            </label>
            <label class="flex flex-col gap-1 text-11-regular text-text-weak">
              <span>SSH Config Path</span>
              <input
                type="text"
                placeholder="~/.ssh/config"
                value={draft.ssh_config_path}
                onInput={(e) => setDraft("ssh_config_path", e.currentTarget.value)}
                class="rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
              />
            </label>
          </div>
        }
      >
        <div class="grid grid-cols-[1fr_80px] gap-2">
          <label class="flex flex-col gap-1 text-11-regular text-text-weak">
            <span>Address</span>
            <input
              type="text"
              placeholder="172.27.251.30"
              value={draft.address}
              onInput={(e) => setDraft("address", e.currentTarget.value)}
              class="rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
            />
          </label>
          <label class="flex flex-col gap-1 text-11-regular text-text-weak">
            <span>Port</span>
            <input
              type="text"
              placeholder="22"
              value={draft.port}
              onInput={(e) => setDraft("port", e.currentTarget.value)}
              class="rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
            />
          </label>
        </div>
      </Show>

      <div class="grid grid-cols-2 gap-2">
        <label class="flex flex-col gap-1 text-11-regular text-text-weak">
          <span>User</span>
          <input
            type="text"
            placeholder="root"
            value={draft.user}
            onInput={(e) => setDraft("user", e.currentTarget.value)}
            class="rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
          />
        </label>
        <label class="flex flex-col gap-1 text-11-regular text-text-weak">
          <span>Password</span>
          <input
            type="password"
            placeholder="Optional"
            value={draft.password}
            onInput={(e) => setDraft("password", e.currentTarget.value)}
            class="rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
          />
        </label>
      </div>

      <Show when={draft.network_mode === "tunnel"}>
        <div class="grid grid-cols-[1fr_110px] gap-2">
          <label class="flex flex-col gap-1 text-11-regular text-text-weak">
            <span>Local Proxy</span>
            <input
              type="text"
              placeholder="127.0.0.1:7890"
              value={draft.local_proxy}
              onInput={(e) => setDraft("local_proxy", e.currentTarget.value)}
              class="rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
            />
          </label>
          <label class="flex flex-col gap-1 text-11-regular text-text-weak">
            <span>Remote Port</span>
            <input
              type="text"
              placeholder="8890"
              value={draft.remote_port}
              onInput={(e) => setDraft("remote_port", e.currentTarget.value)}
              class="rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
            />
          </label>
        </div>
      </Show>

      <Show when={draft.network_mode === "tunnel"}>
        <label class="flex flex-col gap-1 text-11-regular text-text-weak">
          <span>No Proxy</span>
          <input
            type="text"
            placeholder="localhost,127.0.0.1"
            value={draft.no_proxy}
            onInput={(e) => setDraft("no_proxy", e.currentTarget.value)}
            class="rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
          />
        </label>
      </Show>

      <label class="flex flex-col gap-1 text-11-regular text-text-weak">
        <span>Resource Root</span>
        <input
          type="text"
          placeholder="/data/opencode"
          value={draft.resource_root}
          onInput={(e) => setDraft("resource_root", e.currentTarget.value)}
          class="rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
        />
      </label>

      <div class="grid grid-cols-2 gap-2">
        <label class="flex flex-col gap-1 text-11-regular text-text-weak">
          <span>W&amp;B Project</span>
          <input
            type="text"
            placeholder="project-name"
            value={draft.wandb_project_name}
            onInput={(e) => setDraft("wandb_project_name", e.currentTarget.value)}
            class="rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
          />
        </label>
        <label class="flex flex-col gap-1 text-11-regular text-text-weak">
          <span>W&amp;B API Key</span>
          <input
            type="password"
            placeholder="Optional"
            value={draft.wandb_api_key}
            onInput={(e) => setDraft("wandb_api_key", e.currentTarget.value)}
            class="rounded border border-border-weak-base bg-background-stronger px-2 py-1 text-12-regular text-text-base outline-none focus:border-border-base"
          />
        </label>
      </div>

      <div class="self-end flex items-center gap-2">
        <button
          class="px-3 py-1 rounded text-12-regular bg-background-stronger text-text-base hover:text-text-strong transition-colors disabled:opacity-50"
          disabled={saving() || !valid(draft)}
          onClick={props.onSave}
        >
          {saving() ? "Saving..." : props.saveLabel}
        </button>
        <button
          class="px-3 py-1 rounded text-12-regular text-text-weak hover:text-text-base transition-colors"
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  )

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
            onClick={() => (adding() ? cancelEdit() : startAdd())}
          >
            {adding() ? "Cancel" : "+ Add"}
          </button>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-auto px-3 pb-3">
        <Show when={adding()}>
          <Form saveLabel="Create" onSave={handleCreate} onCancel={cancelEdit} />
        </Show>

        <Show when={editing()}>
          <Form saveLabel="Save" onSave={handleUpdate} onCancel={cancelEdit} />
        </Show>

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
              <div class="grid grid-cols-[minmax(140px,1fr)_80px_110px_minmax(120px,1fr)_80px] gap-2 px-2 py-1 text-11-regular text-text-weak uppercase tracking-wider">
                <div>Target</div>
                <div>Conn</div>
                <div>Network</div>
                <div>Resource Root</div>
                <div />
              </div>
              <For each={servers()}>
                {(server) => {
                  const config = createMemo(() => normalize(server.config))
                  return (
                    <div class="grid grid-cols-[minmax(140px,1fr)_80px_110px_minmax(120px,1fr)_80px] gap-2 items-center rounded-md border border-border-weak-base bg-background-base px-2 py-2 text-12-regular text-text-base">
                      <div class="truncate" title={describe(server.config)}>
                        {describe(server.config)}
                      </div>
                      <div>{config().mode === "ssh_config" ? "config" : "direct"}</div>
                      <div class="truncate" title={networkLabel(server.config)}>
                        {networkLabel(server.config)}
                      </div>
                      <div class="truncate" title={config().resource_root ?? ""}>
                        {config().resource_root ?? "-"}
                      </div>
                      <div class="flex items-center justify-end gap-2">
                        <button
                          class="text-text-weak hover:text-text-strong transition-colors text-11-regular"
                          onClick={() => startEdit(server)}
                          title="Edit server"
                        >
                          Edit
                        </button>
                        <button
                          class="text-text-weak hover:text-text-strong transition-colors text-11-regular"
                          onClick={() => handleDelete(server.id)}
                          title="Delete server"
                        >
                          Del
                        </button>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
