/**
 * Web-only entrypoint for the embedded web build.
 * Starts the HTTP server with embedded frontend assets and opens the browser.
 * Built by script/build-web.ts
 */

import { Log } from "./util/log"
import { Installation } from "./installation"
import { Server } from "./server/server"
import { UI } from "./cli/ui"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { Filesystem } from "./util/filesystem"
import { JsonMigration } from "./storage/json-migration"
import { Database } from "./storage/db"
import { Config } from "./config/config"
import { which } from "./util/which"
import open from "open"
import { EOL } from "os"
import path from "path"
import { networkInterfaces } from "os"

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("SIGHUP", () => process.exit())

// Initialize logging
await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: Installation.isLocal() ? "DEBUG" : "INFO",
})

process.env.AGENT = "1"
process.env.OPENCODE = "1"
process.env.OPENCODE_PID = String(process.pid)

Log.Default.info("opencode-web", {
  version: Installation.VERSION,
})

// Database migration
const marker = path.join(Global.Path.data, "openresearch.db")
if (!(await Filesystem.exists(marker))) {
  const tty = process.stderr.isTTY
  process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
  const width = 36
  const orange = "\x1b[38;5;214m"
  const muted = "\x1b[0;2m"
  const reset = "\x1b[0m"
  let last = -1
  if (tty) process.stderr.write("\x1b[?25l")
  try {
    await JsonMigration.run(Database.Client().$client, {
      progress: (event) => {
        const percent = Math.floor((event.current / event.total) * 100)
        if (percent === last && event.current !== event.total) return
        last = percent
        if (tty) {
          const fill = Math.round((percent / 100) * width)
          const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
          process.stderr.write(
            `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
          )
          if (event.current === event.total) process.stderr.write("\n")
        } else {
          process.stderr.write(`sqlite-migration:${percent}${EOL}`)
        }
      },
    })
  } finally {
    if (tty) process.stderr.write("\x1b[?25h")
    else {
      process.stderr.write(`sqlite-migration:done${EOL}`)
    }
  }
  process.stderr.write("Database migration complete." + EOL)
}

// Health check: verify required system tools
function healthCheck() {
  const tools: { name: string; commands: string[] }[] = [
    { name: "Python", commands: ["python3", "python"] },
    { name: "Git", commands: ["git"] },
    { name: "SSH", commands: ["ssh"] },
    { name: "sshpass", commands: ["sshpass"] },
    { name: "rsync", commands: ["rsync"] },
    { name: "conda", commands: ["conda"] },
  ]

  const missing: string[] = []
  const found: string[] = []

  for (const tool of tools) {
    const resolved = tool.commands.some((cmd) => which(cmd) !== null)
    if (resolved) {
      found.push(tool.name)
    } else {
      missing.push(tool.name)
    }
  }

  UI.empty()
  UI.println(UI.Style.TEXT_INFO_BOLD + "  Health Check")

  for (const name of found) {
    UI.println(UI.Style.TEXT_SUCCESS + "    [OK]    " + UI.Style.TEXT_NORMAL + name)
  }
  for (const name of missing) {
    UI.println(UI.Style.TEXT_DANGER + "    [MISS]  " + UI.Style.TEXT_NORMAL + name)
  }

  if (missing.length > 0) {
    UI.empty()
    UI.println(
      UI.Style.TEXT_WARNING_BOLD +
        "  Warning: " +
        UI.Style.TEXT_NORMAL +
        `Missing tools: ${missing.join(", ")}. Some features may not work properly.`,
    )
  }

  UI.empty()
}

// Start server
if (!Flag.OPENCODE_SERVER_PASSWORD) {
  UI.println(UI.Style.TEXT_WARNING_BOLD + "!  " + "OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
}

const config = await Config.global()
const port = config?.server?.port ?? 0
const hostname = config?.server?.hostname ?? "127.0.0.1"

const server = Server.listen({ hostname, port })

UI.empty()
UI.println(UI.logo("  "))

healthCheck()

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []
  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue
    for (const netInfo of net) {
      if (netInfo.internal || netInfo.family !== "IPv4") continue
      if (netInfo.address.startsWith("172.")) continue
      results.push(netInfo.address)
    }
  }
  return results
}

if (hostname === "0.0.0.0") {
  const localhostUrl = `http://localhost:${server.port}`
  UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)
  const networkIPs = getNetworkIPs()
  for (const ip of networkIPs) {
    UI.println(UI.Style.TEXT_INFO_BOLD + "  Network access:    ", UI.Style.TEXT_NORMAL, `http://${ip}:${server.port}`)
  }
  open(localhostUrl).catch(() => {})
} else {
  const displayUrl = server.url.toString()
  UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
  open(displayUrl).catch(() => {})
}

// Keep process alive
await new Promise(() => {})
await server.stop()
