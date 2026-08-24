import z from "zod"
import { spawn } from "child_process"
import { Tool } from "./tool"
import DESCRIPTION from "./ssh.txt"
import { Log } from "../util/log"
import { RemoteServerTable } from "../research/research.sql"
import {
  normalizeRemoteServerConfig,
  remoteServerLabel,
  resolveSshConfigPath,
  RemoteServerConfigSchema,
  type RemoteServerConfig,
} from "../research/remote-server"
import { Database, eq } from "../storage/db"

const log = Log.create({ service: "ssh-tool" })

const DEFAULT_TIMEOUT = 2 * 60 * 1000
const Parameters = z.object({
  server: z
    .string()
    .min(1)
    .describe(
      "Stored remote server ID or JSON-encoded connection config. Prefer a stored ID when available so saved credentials are used.",
    ),
  command: z.string().describe("The bash command to execute on the remote server"),
  description: z.string().describe("Clear, concise description of what this command does in 5-10 words"),
  timeout: z.number().optional().describe("Optional timeout in milliseconds (default: 120000)"),
})

function stored(cfg: RemoteServerConfig) {
  if (cfg.mode !== "direct") return { cfg }
  const matches = Database.use((db) => db.select().from(RemoteServerTable).all()).flatMap((row) => {
    const saved = normalizeRemoteServerConfig(JSON.parse(row.config))
    if (saved.mode !== "direct") return []
    if (saved.address !== cfg.address || saved.port !== cfg.port || saved.user !== cfg.user) return []
    return [{ cfg: saved, id: row.id }]
  })
  if (matches.length === 0) return { cfg }
  if (matches.length > 1) {
    if (cfg.password) return { cfg }
    throw new Error(`multiple stored remote servers match ${remoteServerLabel(cfg)}; pass a stored server ID`)
  }
  const match = matches[0]!
  if (cfg.password || !match.cfg.password) return { cfg, id: match.id }
  return { cfg: { ...cfg, password: match.cfg.password }, id: match.id }
}

function server(input: string) {
  const value = input.trim()
  if (!value.startsWith("{")) {
    const row = Database.use((db) => db.select().from(RemoteServerTable).where(eq(RemoteServerTable.id, value)).get())
    if (!row) throw new Error(`remote server not found: ${value}`)
    return { cfg: normalizeRemoteServerConfig(JSON.parse(row.config)), id: value }
  }

  const parsed = (() => {
    try {
      return RemoteServerConfigSchema.parse(JSON.parse(value))
    } catch (err) {
      throw new Error("server must be a JSON string containing a remote server config", { cause: err })
    }
  })()
  return stored(parsed)
}

export const SshTool = Tool.define("ssh", {
  description: DESCRIPTION,
  parameters: Parameters,
  async execute(params, ctx) {
    const target = server(params.server)
    const cfg = target.cfg
    const label = remoteServerLabel(cfg)
    const trace = target.id ? { remoteServerId: target.id } : {}
    const { command } = params
    const timeout = params.timeout ?? DEFAULT_TIMEOUT

    if (timeout < 0) {
      throw new Error(`Invalid timeout value: ${timeout}. Timeout must be a positive number.`)
    }

    log.info("ssh executing", {
      server: label,
      command,
    })

    const batch = cfg.password ? [] : ["-o", "BatchMode=yes", "-o", "NumberOfPasswordPrompts=0"]
    const sshArgs =
      cfg.mode === "ssh_config"
        ? [
            "-F",
            resolveSshConfigPath(cfg.ssh_config_path),
            ...(cfg.user ? ["-l", cfg.user] : []),
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "LogLevel=ERROR",
            "-o",
            "ClearAllForwardings=yes",
            ...batch,
            cfg.host_alias,
            command,
          ]
        : [
            "-p",
            String(cfg.port),
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "LogLevel=ERROR",
            "-o",
            "ClearAllForwardings=yes",
            ...batch,
            `${cfg.user}@${cfg.address}`,
            command,
          ]

    const args = cfg.password ? ["-p", cfg.password, "ssh", ...sshArgs] : sshArgs
    const cmd = cfg.password ? "sshpass" : "ssh"
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SSH_ASKPASS: "",
        SSH_ASKPASS_REQUIRE: "never",
      },
    })

    let output = ""

    ctx.metadata({
      metadata: {
        output: "",
        description: params.description,
        server: label,
        ...trace,
      },
    })

    const MAX_METADATA_LENGTH = 30_000

    const append = (chunk: Buffer) => {
      output += chunk.toString()
      ctx.metadata({
        metadata: {
          output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
          description: params.description,
          server: label,
          ...trace,
        },
      })
    }

    proc.stdout?.on("data", append)
    proc.stderr?.on("data", append)

    let timedOut = false
    let aborted = false
    let exited = false

    const kill = () => {
      if (exited) return
      try {
        proc.kill("SIGTERM")
      } catch {}
    }

    if (ctx.abort.aborted) {
      aborted = true
      kill()
    }

    const abortHandler = () => {
      aborted = true
      kill()
    }

    ctx.abort.addEventListener("abort", abortHandler, { once: true })

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeout + 100)

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeoutTimer)
        ctx.abort.removeEventListener("abort", abortHandler)
      }

      proc.once("exit", () => {
        exited = true
        cleanup()
        resolve()
      })

      proc.once("error", (error) => {
        exited = true
        cleanup()
        reject(error)
      })
    })

    const resultMetadata: string[] = []

    if (timedOut) {
      resultMetadata.push(`SSH command terminated after exceeding timeout ${timeout} ms`)
    }

    if (aborted) {
      resultMetadata.push("User aborted the command")
    }

    if (resultMetadata.length > 0) {
      output += "\n\n<ssh_metadata>\n" + resultMetadata.join("\n") + "\n</ssh_metadata>"
    }

    return {
      title: `SSH ${label}`,
      metadata: {
        output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
        exit: proc.exitCode,
        description: params.description,
        server: label,
        ...trace,
      },
      output,
    }
  },
})
