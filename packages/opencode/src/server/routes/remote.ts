import { randomUUID } from "node:crypto"

import { Hono, type Context, type Next } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { addresses } from "@/cli/network"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { lazy } from "@/util/lazy"
import { Process } from "@/util/process"
import { errors } from "../error"
import { Server } from "../server"

type Exposed = {
  directory?: string
  port: number
  token: string
  server: ReturnType<typeof Bun.serve>
}

type Tunnel = {
  directory?: string
  message?: string
  port?: number
  proc?: Process.Child
  provider: "cloudflare"
  status: "idle" | "starting" | "ready" | "error"
  timer?: ReturnType<typeof setTimeout>
  token?: string
  url?: string
}

const MessageInput = z.object({
  sessionIDs: z.array(Identifier.schema("session")).min(1),
  text: z.string().trim().min(1),
})

const Result = z.object({
  sessionID: z.string(),
  ok: z.boolean(),
  message: z.string().optional(),
})

const RemoteSession = Session.Info.extend({
  project: Session.ProjectInfo.nullable(),
  status: SessionStatus.Info,
}).meta({
  ref: "RemoteSession",
})

const SessionParam = z.object({
  sessionID: Identifier.schema("session"),
})

const TunnelInfo = z.object({
  provider: z.literal("cloudflare"),
  status: z.enum(["idle", "starting", "ready", "error"]),
  url: z.string().optional(),
  message: z.string().optional(),
})

const Info = z.object({
  urls: z.array(z.string()),
  local: z.string(),
  exposed: z.boolean(),
  reason: z.string().optional(),
  tunnel: TunnelInfo.optional(),
})
type InfoOutput = z.infer<typeof Info>

let exposed: Exposed | undefined
let tunnel: Tunnel = {
  provider: "cloudflare",
  status: "idle",
}
const COOKIE = "opencode_remote_token"
const TUNNEL_TIMEOUT = 20_000
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

function loopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
}

function host(hostname: string) {
  if (hostname.includes(":") && !hostname.startsWith("[")) return `[${hostname}]`
  return hostname
}

function auth(token: string) {
  return async (c: Context, next: Next) => {
    const url = new URL(c.req.url)
    const header = c.req.header("x-opencode-remote-token")
    const query = url.searchParams.get("token")
    const cookie = parseCookie(c.req.header("cookie"))[COOKIE]
    const value = header || query || cookie
    if (value !== token) return c.text("Unauthorized", 401)
    c.req.raw.headers.set("x-opencode-remote-authenticated", "true")
    if (query === token) c.header("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`)
    await next()
  }
}

function share(base: string, item: Exposed) {
  const url = new URL("/remote", base)
  url.searchParams.set("token", item.token)
  if (item.directory) url.searchParams.set("directory", item.directory)
  return url.toString()
}

function expose(input: { directory?: string; protocol: string }): Exposed {
  if (exposed && exposed.directory === input.directory) return exposed
  stopTunnel()
  void exposed?.server.stop(true)
  const token = randomUUID()
  const app: Hono = new Hono().use("*", auth(token)).route("/", Server.App())
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    idleTimeout: 0,
    fetch: app.fetch,
  })
  if (!server.port) throw new Error("Failed to start remote listener")
  const next = {
    directory: input.directory,
    port: server.port,
    server,
    token,
  }
  exposed = next
  return next
}

function tunnelInfo(): InfoOutput["tunnel"] {
  return {
    provider: "cloudflare",
    status: tunnel.status,
    url: tunnel.url,
    message: tunnel.message,
  }
}

function cloudflared(err: unknown) {
  const text = message(err)
  if (text.includes("ENOENT")) return "cloudflared is not installed or not available on PATH"
  return text
}

function fail(proc: Process.Child, text: string) {
  if (tunnel.proc !== proc) return
  if (tunnel.timer) clearTimeout(tunnel.timer)
  tunnel = {
    provider: "cloudflare",
    status: "error",
    message: text,
  }
}

function ready(proc: Process.Child, item: Exposed, base: string) {
  if (tunnel.proc !== proc) return
  if (tunnel.timer) clearTimeout(tunnel.timer)
  tunnel = {
    directory: item.directory,
    port: item.port,
    proc,
    provider: "cloudflare",
    status: "ready",
    token: item.token,
    url: share(base, item),
  }
}

function stopTunnel() {
  const proc = tunnel.proc
  if (tunnel.timer) clearTimeout(tunnel.timer)
  tunnel = {
    provider: "cloudflare",
    status: "idle",
  }
  proc?.kill("SIGTERM")
}

function startTunnel(item: Exposed) {
  const same = tunnel.port === item.port && tunnel.token === item.token && tunnel.directory === item.directory
  if ((tunnel.status === "starting" || tunnel.status === "ready") && same) return
  stopTunnel()

  const proc = (() => {
    try {
      return Process.spawn(["cloudflared", "tunnel", "--url", `http://127.0.0.1:${item.port}`], {
        stdout: "pipe",
        stderr: "pipe",
      })
    } catch (err) {
      tunnel = {
        provider: "cloudflare",
        status: "error",
        message: cloudflared(err),
      }
      return
    }
  })()
  if (!proc) return
  const timer = setTimeout(() => {
    fail(proc, "Timed out waiting for cloudflared public URL")
    proc.kill("SIGTERM")
  }, TUNNEL_TIMEOUT)
  let text = ""
  const scan = (chunk: Buffer | string) => {
    text = (text + chunk.toString()).slice(-4096)
    const match = text.match(TUNNEL_URL)
    if (!match) return
    ready(proc, item, match[0])
  }

  tunnel = {
    directory: item.directory,
    port: item.port,
    proc,
    provider: "cloudflare",
    status: "starting",
    timer,
    token: item.token,
  }
  proc.stdout?.on("data", scan)
  proc.stderr?.on("data", scan)
  void proc.exited.then(
    (code) => {
      if (tunnel.proc !== proc) return
      fail(
        proc,
        tunnel.status === "starting"
          ? `cloudflared exited before publishing a URL${code ? ` with code ${code}` : ""}`
          : `cloudflared exited${code ? ` with code ${code}` : ""}`,
      )
    },
    (err) => fail(proc, cloudflared(err)),
  )
}

function parseCookie(header: string | undefined) {
  return Object.fromEntries(
    (header ?? "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const idx = item.indexOf("=")
        if (idx < 0) return [item, ""]
        return [item.slice(0, idx), decodeURIComponent(item.slice(idx + 1))]
      }),
  )
}

function exposedInfo(input: { directory?: string; local: string; protocol: string }): InfoOutput {
  const item = expose(input)
  const urls = addresses().map((ip) => {
    return share(`${input.protocol}//${ip}:${item.port}`, item)
  })
  return {
    urls,
    local: input.local,
    exposed: urls.length > 0,
    reason: urls.length > 0 ? undefined : "no_network_address",
    tunnel: tunnelInfo(),
  }
}

export async function stopRemote() {
  const server = exposed?.server
  exposed = undefined
  stopTunnel()
  await server?.stop(true)
}

function page() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>opencode remote</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --bg: #f7f7f5;
        --fg: #191817;
        --muted: #69635d;
        --panel: #ffffff;
        --border: #ddd8d1;
        --button: #ffffff;
        --button-fg: #191817;
        --primary: #191817;
        --primary-fg: #ffffff;
        --status: #ece8e1;
        --busy: #ffe3ad;
        --retry: #ffd4d4;
        background: var(--bg);
        color: var(--fg);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #101010;
          --fg: #f4f1ed;
          --muted: #b6afa7;
          --panel: #1d1d1d;
          --border: #3b3936;
          --button: #242424;
          --button-fg: #f4f1ed;
          --primary: #f4f1ed;
          --primary-fg: #111111;
          --status: #34312d;
          --busy: #5a411f;
          --retry: #542829;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100dvh;
        padding: max(18px, env(safe-area-inset-top)) max(14px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left));
      }
      main {
        max-width: 680px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .actions {
        display: flex;
        gap: 8px;
      }
      h1 {
        margin: 0;
        font-size: 20px;
        font-weight: 650;
      }
      button, a.button {
        border: 1px solid var(--border);
        background: var(--button);
        color: var(--button-fg);
        border-radius: 8px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 42px;
        padding: 0 14px;
        font: inherit;
        text-decoration: none;
      }
      button.primary {
        border-color: var(--primary);
        background: var(--primary);
        color: var(--primary-fg);
        width: 100%;
      }
      button:disabled {
        opacity: 0.5;
      }
      .panel, .project, .session, .msg, textarea {
        border: 1px solid var(--border);
        background: var(--panel);
        color: var(--fg);
        border-radius: 8px;
      }
      .panel {
        padding: 12px;
      }
      .muted, .meta {
        color: var(--muted);
        font-size: 13px;
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .project {
        width: 100%;
        min-height: 64px;
        padding: 12px;
        text-align: left;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        text-decoration: none;
      }
      .session {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 10px;
        align-items: center;
        padding: 12px;
        text-decoration: none;
      }
      .title {
        font-weight: 590;
        line-height: 1.35;
        overflow-wrap: anywhere;
        white-space: normal;
        word-break: break-word;
      }
      .summary {
        min-width: 0;
      }
      .status {
        align-self: start;
        border-radius: 999px;
        padding: 3px 8px;
        font-size: 12px;
        background: var(--status);
        white-space: nowrap;
      }
      .status.busy { background: var(--busy); }
      .status.retry { background: var(--retry); }
      .result {
        white-space: pre-wrap;
        font-size: 13px;
        line-height: 1.45;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>opencode remote</h1>
          <div id="count" class="muted">Loading sessions...</div>
        </div>
        <div class="actions">
          <a id="back" class="button" href="/remote" hidden>Back</a>
          <button id="refresh" type="button">Refresh</button>
        </div>
      </header>
      <section id="projects" class="list"></section>
      <section id="sessions" class="list"></section>
      <section id="result" class="panel result" hidden></section>
    </main>
    <script>
      const state = { sessions: [], project: null }
      const params = new URLSearchParams(location.search)
      const token = params.get("token")
      const directory = params.get("directory")
      const els = {
        back: document.getElementById("back"),
        count: document.getElementById("count"),
        projects: document.getElementById("projects"),
        refresh: document.getElementById("refresh"),
        result: document.getElementById("result"),
        sessions: document.getElementById("sessions"),
      }
      const route = () => {
        const parts = location.pathname.slice("/remote".length).split("/").filter(Boolean)
        if (parts[0] === "project" && parts[1]) return { type: "project", project: decodeURIComponent(parts[1]) }
        return { type: "home" }
      }
      const href = (path) => {
        const url = new URL(path, location.origin)
        if (token) url.searchParams.set("token", token)
        if (directory) url.searchParams.set("directory", directory)
        return url.pathname + url.search
      }
      const dir = (value) => {
        const bytes = new TextEncoder().encode(value)
        let binary = ""
        for (const byte of bytes) binary += String.fromCharCode(byte)
        return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=/g, "")
      }
      const rel = (time) => {
        const sec = Math.max(1, Math.round((Date.now() - time) / 1000))
        if (sec < 60) return sec + "s ago"
        const min = Math.round(sec / 60)
        if (min < 60) return min + "m ago"
        const hour = Math.round(min / 60)
        if (hour < 48) return hour + "h ago"
        return Math.round(hour / 24) + "d ago"
      }
      const esc = (text) => String(text).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char])
      const api = (path, init) => {
        const url = new URL(path, location.origin)
        if (token) url.searchParams.set("token", token)
        if (directory) url.searchParams.set("directory", directory)
        return fetch(url, init)
      }
      const key = (session) => session.project && session.project.worktree ? session.project.worktree : session.directory
      const name = (session) => session.project && session.project.name ? session.project.name : key(session)
      const projects = () => {
        const map = new Map()
        for (const session of state.sessions) {
          const id = key(session)
          const current = map.get(id) || { id, name: name(session), count: 0, updated: 0 }
          current.count += 1
          current.updated = Math.max(current.updated, session.time.updated)
          map.set(id, current)
        }
        return Array.from(map.values()).sort((a, b) => b.updated - a.updated)
      }
      const active = () => route().type === "project" ? state.sessions.filter((session) => key(session) === route().project) : []
      const render = () => {
        const page = route()
        const list = active()
        els.projects.hidden = page.type !== "home"
        els.sessions.hidden = page.type === "home"
        els.back.hidden = page.type === "home"
        els.back.href = href("/remote")
        if (page.type === "home") {
          const items = projects()
          els.count.textContent = items.length + " projects"
          els.projects.innerHTML = items.map((project) =>
            '<a class="project" href="' + esc(href("/remote/project/" + encodeURIComponent(project.id))) + '">' +
              '<span class="summary"><span class="title">' + esc(project.name) + '</span><br /><span class="meta">' + project.count + " active sessions · " + esc(rel(project.updated)) + '</span></span>' +
              '<span class="meta">Enter</span>' +
            '</a>'
          ).join("")
          els.sessions.innerHTML = ""
          return
        }
        els.count.textContent = state.project?.name ?? "Project not found"
        els.sessions.innerHTML = list.map((session) => {
          const status = session.status.type
          const link = ' href="' + esc(href("/remote/session/" + encodeURIComponent(dir(session.directory)) + "/" + encodeURIComponent(session.id))) + '"'
          const badge = status === "idle" ? "" : '<span class="status ' + esc(status) + '">' + esc(status) + '</span>'
          return '<a class="session"' + link + '>' +
            '<span class="summary"><span class="title">' + esc(session.title) + '</span><br /><span class="meta">' + esc(rel(session.time.updated)) + '</span></span>' +
            badge +
          '</a>'
        }).join("")
      }
      const load = async () => {
        if (route().type === "home") els.count.textContent = "Loading sessions..."
        const res = await api("/remote/api/session")
        if (!res.ok) throw new Error(await res.text())
        state.sessions = await res.json()
        const page = route()
        state.project = page.type === "project" ? projects().find((project) => project.id === page.project) || null : null
        render()
      }
      const refresh = async () => {
        await load()
      }
      const show = (error) => {
        els.count.textContent = "Failed to load"
        els.result.hidden = false
        els.result.textContent = error instanceof Error ? error.message : String(error)
      }
      els.refresh.addEventListener("click", () => refresh().catch(show))
      setInterval(() => {
        if (document.hidden) return
        refresh().catch(() => undefined)
      }, 2000)
      refresh().catch(show)
    </script>
  </body>
</html>`
}

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function sessions() {
  return [...Session.listGlobal({ roots: true, limit: 500 })].filter((session) => !session.time.archived)
}

function find(sessionID: string) {
  return sessions().find((session) => session.id === sessionID)
}

function status(session: Session.GlobalInfo) {
  return Instance.provide({
    directory: session.directory,
    fn: () => SessionStatus.get(session.id),
  })
}

async function remote(session: Session.GlobalInfo) {
  return {
    ...session,
    status: await status(session),
  }
}

function createRemoteRoutes(opts: { expose: boolean }): Hono {
  const app = new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Remote mobile page",
        description: "Serve a lightweight page for sending a message to active sessions from a phone.",
        operationId: "remote.page",
        responses: {
          200: {
            description: "Remote page",
            content: {
              "text/html": {
                schema: resolver(z.string()),
              },
            },
          },
        },
      }),
      (c) => c.html(page()),
    )
    .get("/project/:project", (c) => c.html(page()))
    .get(
      "/api/info",
      describeRoute({
        summary: "Get remote page info",
        description: "Return candidate phone-accessible remote page URLs for this server.",
        operationId: "remote.info",
        responses: {
          200: {
            description: "Remote info",
            content: {
              "application/json": {
                schema: resolver(Info),
              },
            },
          },
        },
      }),
      (c) => {
        const url = new URL(c.req.url)
        const info = Server.info()
        const port = info?.port ?? Number(url.port || "80")
        const local = `${url.protocol}//${url.host}/remote`
        if (!info) {
          return c.json({
            urls: [local],
            local,
            exposed: !loopback(url.hostname),
            tunnel: tunnelInfo(),
          })
        }
        if (loopback(info.hostname)) {
          return c.json({
            urls: [],
            local,
            exposed: false,
            reason: "loopback",
            tunnel: tunnelInfo(),
          })
        }
        const urls =
          info.hostname === "0.0.0.0" || info.hostname === "::"
            ? addresses().map((ip) => `${url.protocol}//${ip}:${port}/remote`)
            : [`${url.protocol}//${host(info.hostname)}:${port}/remote`]
        if (info.mdns) urls.push(`${url.protocol}//${info.mdnsDomain ?? "opencode.local"}:${port}/remote`)
        return c.json({
          urls,
          local,
          exposed: urls.length > 0,
          reason: urls.length > 0 ? undefined : "no_network_address",
          tunnel: tunnelInfo(),
        })
      },
    )

  if (opts.expose) {
    app.post(
      "/api/expose",
      describeRoute({
        summary: "Expose remote page",
        description: "Start a token-protected network listener for the lightweight remote page.",
        operationId: "remote.expose",
        responses: {
          200: {
            description: "Remote info",
            content: {
              "application/json": {
                schema: resolver(Info),
              },
            },
          },
        },
      }),
      (c) => {
        const url = new URL(c.req.url)
        return c.json(
          exposedInfo({
            directory: c.req.query("directory") || c.req.header("x-opencode-directory"),
            local: `${url.protocol}//${url.host}/remote`,
            protocol: url.protocol,
          }),
        )
      },
    )
    app.post(
      "/api/tunnel/start",
      describeRoute({
        summary: "Start remote tunnel",
        description: "Start a Cloudflare quick tunnel for the token-protected remote page.",
        operationId: "remote.tunnel.start",
        responses: {
          200: {
            description: "Remote info",
            content: {
              "application/json": {
                schema: resolver(Info),
              },
            },
          },
        },
      }),
      (c) => {
        const url = new URL(c.req.url)
        const info = exposedInfo({
          directory: c.req.query("directory") || c.req.header("x-opencode-directory"),
          local: `${url.protocol}//${url.host}/remote`,
          protocol: url.protocol,
        })
        if (exposed) startTunnel(exposed)
        return c.json({
          ...info,
          tunnel: tunnelInfo(),
        })
      },
    )
    app.delete(
      "/api/tunnel",
      describeRoute({
        summary: "Stop remote tunnel",
        description: "Stop the active Cloudflare quick tunnel for the remote page.",
        operationId: "remote.tunnel.stop",
        responses: {
          200: {
            description: "Remote info",
            content: {
              "application/json": {
                schema: resolver(Info),
              },
            },
          },
        },
      }),
      (c) => {
        stopTunnel()
        const url = new URL(c.req.url)
        if (exposed) {
          return c.json(
            exposedInfo({
              directory: exposed.directory,
              local: `${url.protocol}//${url.host}/remote`,
              protocol: url.protocol,
            }),
          )
        }
        return c.json({
          urls: [],
          local: `${url.protocol}//${url.host}/remote`,
          exposed: false,
          reason: "loopback",
          tunnel: tunnelInfo(),
        })
      },
    )
  }

  return app
    .get(
      "/api/session",
      describeRoute({
        summary: "List remote sessions",
        description: "List current project root sessions available to the remote page.",
        operationId: "remote.sessions",
        responses: {
          200: {
            description: "Remote sessions",
            content: {
              "application/json": {
                schema: resolver(RemoteSession.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Promise.all(sessions().map(remote)))
      },
    )
    .get(
      "/api/session/:sessionID",
      describeRoute({
        summary: "Get remote session",
        description: "Get one remote session with status.",
        operationId: "remote.session",
        responses: {
          200: {
            description: "Remote session",
            content: {
              "application/json": {
                schema: resolver(RemoteSession),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", SessionParam),
      async (c) => {
        const session = find(c.req.valid("param").sessionID)
        if (!session) return c.text("Session not found", 404)
        return c.json(await remote(session))
      },
    )
    .get(
      "/api/session/:sessionID/message",
      describeRoute({
        summary: "List remote session messages",
        description: "List recent messages for one remote session.",
        operationId: "remote.session.messages",
        responses: {
          200: {
            description: "Remote session messages",
            content: {
              "application/json": {
                schema: resolver(MessageV2.WithParts.array()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", SessionParam),
      validator(
        "query",
        z.object({
          limit: z.coerce.number().optional(),
        }),
      ),
      async (c) => {
        const session = find(c.req.valid("param").sessionID)
        if (!session) return c.text("Session not found", 404)
        return c.json(
          await Instance.provide({
            directory: session.directory,
            fn: () =>
              Session.messages({
                sessionID: session.id,
                limit: c.req.valid("query").limit,
              }),
          }),
        )
      },
    )
    .post(
      "/api/message",
      describeRoute({
        summary: "Send remote message",
        description: "Send one text message to multiple active sessions.",
        operationId: "remote.message",
        responses: {
          200: {
            description: "Send results",
            content: {
              "application/json": {
                schema: resolver(Result.array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", MessageInput),
      async (c) => {
        const body = c.req.valid("json")
        const results = await Promise.all(
          body.sessionIDs.map(async (sessionID) => {
            const session = await Session.get(sessionID).catch((err) => err)
            if (session instanceof Error) {
              return { sessionID, ok: false, message: message(session) }
            }
            if (session.time.archived) {
              return { sessionID, ok: false, message: "Session is archived" }
            }
            return Instance.provide({
              directory: session.directory,
              async fn() {
                try {
                  SessionPrompt.assertNotBusy(sessionID)
                } catch (err) {
                  return { sessionID, ok: false, message: message(err) }
                }
                void SessionPrompt.prompt({
                  sessionID,
                  parts: [{ type: "text", text: body.text }],
                }).catch(() => undefined)
                return { sessionID, ok: true, message: "accepted" }
              },
            })
          }),
        )
        return c.json(results)
      },
    )
}

export const RemoteRoutes = lazy(() => createRemoteRoutes({ expose: true }))
