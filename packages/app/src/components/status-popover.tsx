import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { Switch } from "@opencode-ai/ui/switch"
import { Tabs } from "@opencode-ai/ui/tabs"
import { showToast } from "@opencode-ai/ui/toast"
import { useNavigate, useParams } from "@solidjs/router"
import {
  type Accessor,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSXElement,
  onCleanup,
  Show,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { normalizeServerUrl, ServerConnection, useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { decode64 } from "@/utils/base64"
import { checkServerHealth, type ServerHealth } from "@/utils/server-health"
import { DialogSelectServer } from "./dialog-select-server"

const pollMs = 10_000

type RemoteInfo = {
  urls: string[]
  local: string
  exposed: boolean
  reason?: string
  tunnel?: {
    provider: "cloudflare"
    status: "idle" | "starting" | "ready" | "error"
    url?: string
    message?: string
  }
}

function remoteLink(url: string, server: ServerConnection.HttpBase) {
  if (!server.password) return url
  try {
    const next = new URL(url)
    next.username = server.username ?? "opencode"
    next.password = server.password
    return next.toString()
  } catch {
    return url
  }
}

const pluginEmptyMessage = (value: string, file: string): JSXElement => {
  const parts = value.split(file)
  if (parts.length === 1) return value
  return (
    <>
      {parts[0]}
      <code class="bg-surface-raised-base px-1.5 py-0.5 rounded-sm text-text-base">{file}</code>
      {parts.slice(1).join(file)}
    </>
  )
}

const listServersByHealth = (
  list: ServerConnection.Any[],
  active: ServerConnection.Key | undefined,
  status: Record<ServerConnection.Key, ServerHealth | undefined>,
) => {
  if (!list.length) return list
  const order = new Map(list.map((url, index) => [url, index] as const))
  const rank = (value?: ServerHealth) => {
    if (value?.healthy === true) return 0
    if (value?.healthy === false) return 2
    return 1
  }

  return list.slice().sort((a, b) => {
    if (ServerConnection.key(a) === active) return -1
    if (ServerConnection.key(b) === active) return 1
    const diff = rank(status[ServerConnection.key(a)]) - rank(status[ServerConnection.key(b)])
    if (diff !== 0) return diff
    return (order.get(a) ?? 0) - (order.get(b) ?? 0)
  })
}

const useServerHealth = (servers: Accessor<ServerConnection.Any[]>, fetcher: typeof fetch) => {
  const [status, setStatus] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)

  createEffect(() => {
    const list = servers()
    let dead = false

    const refresh = async () => {
      const results: Record<string, ServerHealth> = {}
      await Promise.all(
        list.map(async (conn) => {
          results[ServerConnection.key(conn)] = await checkServerHealth(conn.http, fetcher)
        }),
      )
      if (dead) return
      setStatus(reconcile(results))
    }

    void refresh()
    const id = setInterval(() => void refresh(), pollMs)
    onCleanup(() => {
      dead = true
      clearInterval(id)
    })
  })

  return status
}

const useDefaultServerKey = (
  get: (() => string | Promise<string | null | undefined> | null | undefined) | undefined,
) => {
  const [url, setUrl] = createSignal<string | undefined>()
  const [tick, setTick] = createSignal(0)

  createEffect(() => {
    tick()
    let dead = false
    const result = get?.()
    if (!result) {
      setUrl(undefined)
      onCleanup(() => {
        dead = true
      })
      return
    }

    if (result instanceof Promise) {
      void result.then((next) => {
        if (dead) return
        setUrl(next ? normalizeServerUrl(next) : undefined)
      })
      onCleanup(() => {
        dead = true
      })
      return
    }

    setUrl(normalizeServerUrl(result))
    onCleanup(() => {
      dead = true
    })
  })

  return {
    key: () => {
      const u = url()
      if (!u) return
      return ServerConnection.key({ type: "http", http: { url: u } })
    },
    refresh: () => setTick((value) => value + 1),
  }
}

const useMcpToggle = (input: {
  sync: ReturnType<typeof useSync>
  sdk: ReturnType<typeof useSDK>
  language: ReturnType<typeof useLanguage>
}) => {
  const [loading, setLoading] = createSignal<string | null>(null)

  const toggle = async (name: string) => {
    if (loading()) return
    setLoading(name)

    try {
      const status = input.sync.data.mcp[name]
      await (status?.status === "connected"
        ? input.sdk.client.mcp.disconnect({ name })
        : input.sdk.client.mcp.connect({ name }))
      const result = await input.sdk.client.mcp.status()
      if (result.data) input.sync.set("mcp", result.data)
    } catch (err) {
      showToast({
        variant: "error",
        title: input.language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setLoading(null)
    }
  }

  return { loading, toggle }
}

export function StatusPopover() {
  const sync = useSync()
  const sdk = useSDK()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const params = useParams()

  const fetcher = platform.fetch ?? globalThis.fetch
  const servers = createMemo(() => {
    const current = server.current
    const list = server.list
    if (!current) return list
    if (list.every((item) => ServerConnection.key(item) !== ServerConnection.key(current))) return [current, ...list]
    return [current, ...list.filter((item) => ServerConnection.key(item) !== ServerConnection.key(current))]
  })
  const health = useServerHealth(servers, fetcher)
  const sortedServers = createMemo(() => listServersByHealth(servers(), server.key, health))
  const mcp = useMcpToggle({ sync, sdk, language })
  const defaultServer = useDefaultServerKey(platform.getDefaultServerUrl)
  const mcpNames = createMemo(() => Object.keys(sync.data.mcp ?? {}).sort((a, b) => a.localeCompare(b)))
  const mcpStatus = (name: string) => sync.data.mcp?.[name]?.status
  const mcpConnected = createMemo(() => mcpNames().filter((name) => mcpStatus(name) === "connected").length)
  const lspItems = createMemo(() => sync.data.lsp ?? [])
  const lspCount = createMemo(() => lspItems().length)
  const plugins = createMemo(() => sync.data.config.plugin ?? [])
  const pluginCount = createMemo(() => plugins().length)
  const pluginEmpty = createMemo(() => pluginEmptyMessage(language.t("dialog.plugins.empty"), "opencode.json"))
  const overallHealthy = createMemo(() => {
    const serverHealthy = server.healthy() === true
    const anyMcpIssue = mcpNames().some((name) => {
      const status = mcpStatus(name)
      return status !== "connected" && status !== "disabled"
    })
    return serverHealthy && !anyMcpIssue
  })
  const [remote, remoteActions] = createResource(
    () => server.current?.http,
    async (http) => {
      const headers = new Headers()
      if (http.password) {
        headers.set("Authorization", `Basic ${btoa(`${http.username ?? "opencode"}:${http.password}`)}`)
      }
      const res = await fetcher(`${http.url}/remote/api/info`, { headers })
      if (!res.ok) throw new Error(await res.text())
      const info = (await res.json()) as RemoteInfo
      if (info.reason !== "loopback") return info
      const url = new URL(`${http.url}/remote/api/expose`)
      const dir = decode64(params.dir)
      if (dir) url.searchParams.set("directory", dir)
      const exposed = await fetcher(url, {
        method: "POST",
        headers,
      })
      if (!exposed.ok) return info
      return (await exposed.json()) as RemoteInfo
    },
  )
  const [busy, setBusy] = createSignal(false)
  const headers = (http: ServerConnection.HttpBase) => {
    const next = new Headers()
    if (http.password) {
      next.set("Authorization", `Basic ${btoa(`${http.username ?? "opencode"}:${http.password}`)}`)
    }
    return next
  }
  const remoteUrl = createMemo(() => {
    const info = remote()
    const current = server.current
    if (!info?.urls[0] || !current) return ""
    return remoteLink(info.urls[0], current.http)
  })
  const tunnelUrl = createMemo(() => {
    const info = remote()
    if (info?.tunnel?.status !== "ready") return ""
    return info.tunnel.url ?? ""
  })
  const tunnelMessage = createMemo(() => {
    const state = remote()?.tunnel
    if (state?.status === "error") return state.message ?? "External remote failed"
    if (state?.status === "starting") return "Starting Cloudflare tunnel..."
    return "Cloudflare tunnel is off"
  })
  const remoteUnavailable = createMemo(() => {
    const info = remote()
    if (!info || info.exposed) return ""
    if (info.reason === "loopback") return "Server is listening on localhost only"
    if (info.reason === "no_network_address") return "No network address was found"
    return "Phone remote is not exposed"
  })
  createEffect(() => {
    if (remote()?.tunnel?.status !== "starting") return
    const id = setInterval(() => void remoteActions.refetch(), 1_500)
    onCleanup(() => clearInterval(id))
  })
  const copyRemote = () => {
    const url = remoteUrl()
    if (!url) return
    navigator.clipboard
      .writeText(url)
      .then(() =>
        showToast({
          variant: "success",
          icon: "circle-check",
          title: "Remote URL copied",
          description: url,
        }),
      )
      .catch((err: unknown) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        }),
      )
  }
  const copyTunnel = () => {
    const url = tunnelUrl()
    if (!url) return
    navigator.clipboard
      .writeText(url)
      .then(() =>
        showToast({
          variant: "success",
          icon: "circle-check",
          title: "External URL copied",
          description: url,
        }),
      )
      .catch((err: unknown) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        }),
      )
  }
  const startTunnel = async () => {
    const http = server.current?.http
    if (!http || busy()) return
    setBusy(true)
    try {
      const url = new URL(`${http.url}/remote/api/tunnel/start`)
      const dir = decode64(params.dir)
      if (dir) url.searchParams.set("directory", dir)
      const res = await fetcher(url, {
        method: "POST",
        headers: headers(http),
      })
      if (!res.ok) throw new Error(await res.text())
      const info = (await res.json()) as RemoteInfo
      remoteActions.mutate(info)
      if (info.tunnel?.status === "error") {
        showToast({
          variant: "error",
          title: "External remote failed",
          description: info.tunnel.message ?? "Cloudflare tunnel failed",
        })
      }
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
      setTimeout(() => void remoteActions.refetch(), 800)
    }
  }
  const stopTunnel = async () => {
    const http = server.current?.http
    if (!http || busy()) return
    setBusy(true)
    try {
      const res = await fetcher(`${http.url}/remote/api/tunnel`, {
        method: "DELETE",
        headers: headers(http),
      })
      if (!res.ok) throw new Error(await res.text())
      remoteActions.mutate((await res.json()) as RemoteInfo)
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover
      triggerAs={Button}
      triggerProps={{
        variant: "ghost",
        class: "titlebar-icon w-6 h-6 p-0 box-border",
        "aria-label": language.t("status.popover.trigger"),
        style: { scale: 1 },
      }}
      trigger={
        <div class="flex size-4 items-center justify-center">
          <div
            classList={{
              "size-1.5 rounded-full": true,
              "bg-icon-success-base": overallHealthy(),
              "bg-icon-critical-base": !overallHealthy() && server.healthy() !== undefined,
              "bg-border-weak-base": server.healthy() === undefined,
            }}
          />
        </div>
      }
      class="[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-xl"
      gutter={4}
      placement="bottom-end"
      shift={-168}
    >
      <div class="flex items-center gap-1 w-[360px] rounded-xl shadow-[var(--shadow-lg-border-base)]">
        <Tabs
          aria-label={language.t("status.popover.ariaLabel")}
          class="tabs bg-background-strong rounded-xl overflow-hidden"
          data-component="tabs"
          data-active="servers"
          defaultValue="servers"
          variant="alt"
        >
          <Tabs.List data-slot="tablist" class="bg-transparent border-b-0 px-4 pt-2 pb-0 gap-4 h-10">
            <Tabs.Trigger value="servers" data-slot="tab" class="text-12-regular">
              {sortedServers().length > 0 ? `${sortedServers().length} ` : ""}
              {language.t("status.popover.tab.servers")}
            </Tabs.Trigger>
            <Tabs.Trigger value="mcp" data-slot="tab" class="text-12-regular">
              {mcpConnected() > 0 ? `${mcpConnected()} ` : ""}
              {language.t("status.popover.tab.mcp")}
            </Tabs.Trigger>
            <Tabs.Trigger value="lsp" data-slot="tab" class="text-12-regular">
              {lspCount() > 0 ? `${lspCount()} ` : ""}
              {language.t("status.popover.tab.lsp")}
            </Tabs.Trigger>
            <Tabs.Trigger value="plugins" data-slot="tab" class="text-12-regular">
              {pluginCount() > 0 ? `${pluginCount()} ` : ""}
              {language.t("status.popover.tab.plugins")}
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="servers">
            <div class="flex flex-col px-2 pb-2">
              <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                {remoteUrl() || remoteUnavailable() ? (
                  <div class="flex items-center gap-2 mb-2 px-3 py-2 rounded-md bg-surface-base">
                    <div class="flex flex-col min-w-0 flex-1">
                      <div class="text-12-medium text-text-base">Phone remote</div>
                      <Show
                        when={remoteUrl()}
                        fallback={<div class="text-12-regular text-text-weak truncate">{remoteUnavailable()}</div>}
                      >
                        {(url) => (
                          <button
                            type="button"
                            class="text-12-regular text-text-weak truncate text-left hover:text-text-base"
                            onClick={() => platform.openLink(url())}
                          >
                            {url()}
                          </button>
                        )}
                      </Show>
                    </div>
                    <Show when={remoteUrl()}>
                      <Button variant="ghost" size="small" class="px-2" onClick={copyRemote}>
                        <Icon name="copy" size="small" class="text-icon-base" />
                      </Button>
                    </Show>
                  </div>
                ) : null}
                <Show when={remote()}>
                  <div class="flex items-center gap-2 mb-3 px-3 py-2 rounded-md bg-surface-base">
                    <div class="flex flex-col min-w-0 flex-1">
                      <div class="text-12-medium text-text-base">External remote</div>
                      <Show
                        when={tunnelUrl()}
                        fallback={<div class="text-12-regular text-text-weak truncate">{tunnelMessage()}</div>}
                      >
                        {(url) => (
                          <button
                            type="button"
                            class="text-12-regular text-text-weak truncate text-left hover:text-text-base"
                            onClick={() => platform.openLink(url())}
                          >
                            {url()}
                          </button>
                        )}
                      </Show>
                    </div>
                    <Show
                      when={remote()?.tunnel?.status === "ready"}
                      fallback={
                        <Button
                          variant="ghost"
                          size="small"
                          class="px-2"
                          disabled={busy() || remote()?.tunnel?.status === "starting"}
                          onClick={startTunnel}
                        >
                          <Icon name="share" size="small" class="text-icon-base" />
                        </Button>
                      }
                    >
                      <div class="flex items-center gap-1">
                        <Button variant="ghost" size="small" class="px-2" onClick={copyTunnel}>
                          <Icon name="copy" size="small" class="text-icon-base" />
                        </Button>
                        <Button variant="ghost" size="small" class="px-2" disabled={busy()} onClick={stopTunnel}>
                          <Icon name="stop" size="small" class="text-icon-base" />
                        </Button>
                      </div>
                    </Show>
                  </div>
                </Show>
                <For each={sortedServers()}>
                  {(s) => {
                    const key = ServerConnection.key(s)
                    const isBlocked = () => health[key]?.healthy === false
                    return (
                      <button
                        type="button"
                        class="flex items-center gap-2 w-full h-8 pl-3 pr-1.5 py-1.5 rounded-md transition-colors text-left"
                        classList={{
                          "hover:bg-surface-raised-base-hover": !isBlocked(),
                          "cursor-not-allowed": isBlocked(),
                        }}
                        aria-disabled={isBlocked()}
                        onClick={() => {
                          if (isBlocked()) return
                          server.setActive(key)
                          navigate("/")
                        }}
                      >
                        <ServerHealthIndicator health={health[key]} />
                        <ServerRow
                          conn={s}
                          dimmed={isBlocked()}
                          status={health[key]}
                          class="flex items-center gap-2 w-full min-w-0"
                          nameClass="text-14-regular text-text-base truncate"
                          versionClass="text-12-regular text-text-weak truncate"
                          badge={
                            <Show when={key === defaultServer.key()}>
                              <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md">
                                {language.t("common.default")}
                              </span>
                            </Show>
                          }
                        >
                          <div class="flex-1" />
                          <Show when={server.current && key === ServerConnection.key(server.current)}>
                            <Icon name="check" size="small" class="text-icon-weak shrink-0" />
                          </Show>
                        </ServerRow>
                      </button>
                    )
                  }}
                </For>

                <Button
                  variant="secondary"
                  class="mt-3 self-start h-8 px-3 py-1.5"
                  onClick={() => dialog.show(() => <DialogSelectServer />, defaultServer.refresh)}
                >
                  {language.t("status.popover.action.manageServers")}
                </Button>
              </div>
            </div>
          </Tabs.Content>

          <Tabs.Content value="mcp">
            <div class="flex flex-col px-2 pb-2">
              <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                <Show
                  when={mcpNames().length > 0}
                  fallback={
                    <div class="text-14-regular text-text-base text-center my-auto">
                      {language.t("dialog.mcp.empty")}
                    </div>
                  }
                >
                  <For each={mcpNames()}>
                    {(name) => {
                      const status = () => mcpStatus(name)
                      const enabled = () => status() === "connected"
                      return (
                        <button
                          type="button"
                          class="flex items-center gap-2 w-full h-8 pl-3 pr-2 py-1 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                          onClick={() => mcp.toggle(name)}
                          disabled={mcp.loading() === name}
                        >
                          <div
                            classList={{
                              "size-1.5 rounded-full shrink-0": true,
                              "bg-icon-success-base": status() === "connected",
                              "bg-icon-critical-base": status() === "failed",
                              "bg-border-weak-base": status() === "disabled",
                              "bg-icon-warning-base":
                                status() === "needs_auth" || status() === "needs_client_registration",
                            }}
                          />
                          <span class="text-14-regular text-text-base truncate flex-1">{name}</span>
                          <div onClick={(event) => event.stopPropagation()}>
                            <Switch
                              checked={enabled()}
                              disabled={mcp.loading() === name}
                              onChange={() => mcp.toggle(name)}
                            />
                          </div>
                        </button>
                      )
                    }}
                  </For>
                </Show>
              </div>
            </div>
          </Tabs.Content>

          <Tabs.Content value="lsp">
            <div class="flex flex-col px-2 pb-2">
              <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                <Show
                  when={lspItems().length > 0}
                  fallback={
                    <div class="text-14-regular text-text-base text-center my-auto">
                      {language.t("dialog.lsp.empty")}
                    </div>
                  }
                >
                  <For each={lspItems()}>
                    {(item) => (
                      <div class="flex items-center gap-2 w-full px-2 py-1">
                        <div
                          classList={{
                            "size-1.5 rounded-full shrink-0": true,
                            "bg-icon-success-base": item.status === "connected",
                            "bg-icon-critical-base": item.status === "error",
                          }}
                        />
                        <span class="text-14-regular text-text-base truncate">{item.name || item.id}</span>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </Tabs.Content>

          <Tabs.Content value="plugins">
            <div class="flex flex-col px-2 pb-2">
              <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                <Show
                  when={plugins().length > 0}
                  fallback={<div class="text-14-regular text-text-base text-center my-auto">{pluginEmpty()}</div>}
                >
                  <For each={plugins()}>
                    {(plugin) => (
                      <div class="flex items-center gap-2 w-full px-2 py-1">
                        <div class="size-1.5 rounded-full shrink-0 bg-icon-success-base" />
                        <span class="text-14-regular text-text-base truncate">{plugin}</span>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </Tabs.Content>
        </Tabs>
      </div>
    </Popover>
  )
}
