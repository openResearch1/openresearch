// @refresh reload

import { iife } from "@opencode-ai/util/iife"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { type Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { handleNotificationClick } from "@/utils/notification-click"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => getStorage(DEFAULT_SERVER_URL_KEY)
const writeDefaultServerUrl = (url: string | null) => setStorage(DEFAULT_SERVER_URL_KEY, url)

const notify: Platform["notify"] = async (title, description, href) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: "https://opencode.ai/favicon-96x96-v3.png",
  })

  notification.onclick = () => {
    handleNotificationClick(href)
    notification.close()
  }
}

const openLink: Platform["openLink"] = (url) => {
  window.open(url, "_blank")
}

const back: Platform["back"] = () => {
  window.history.back()
}

const forward: Platform["forward"] = () => {
  window.history.forward()
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  openLink,
  back,
  forward,
  restart,
  notify,
  getDefaultServerUrl: async () => readDefaultServerUrl(),
  setDefaultServerUrl: writeDefaultServerUrl,
}

const defaultUrl = iife(() => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  return location.origin
})

if (root instanceof HTMLElement) {
  const server: ServerConnection.Http = { type: "http", http: { url: defaultUrl } }

  // Global error reporter — sends uncaught errors to backend log (best-effort)
  const reportToServer = (level: "error" | "warn", message: string, stack?: string, extra?: Record<string, unknown>) => {
    const authHeader = server.http.password
      ? { Authorization: `Basic ${btoa(`${server.http.username ?? "opencode"}:${server.http.password}`)}` }
      : undefined
    fetch(`${defaultUrl}/global/log-client`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authHeader ?? {}) } as HeadersInit,
      body: JSON.stringify({ level, message, stack, url: location.href, extra }),
    }).catch(() => {})
  }

  window.addEventListener("error", (e) => {
    reportToServer("error", e.message || "Unknown error", e.error?.stack, {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
    })
  })

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason
    const message = reason instanceof Error ? reason.message : String(reason ?? "Unhandled rejection")
    const stack = reason instanceof Error ? reason.stack : undefined
    reportToServer("error", message, stack)
  })

  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface defaultServer={ServerConnection.key(server)} servers={[server]} />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}
