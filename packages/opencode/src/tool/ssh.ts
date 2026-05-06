import z from "zod"
import { spawn } from "child_process"
import { Tool } from "./tool"
import DESCRIPTION from "./ssh.txt"
import { Log } from "../util/log"
import { remoteServerLabel, resolveSshConfigPath, RemoteServerConfigSchema } from "../research/remote-server"

const log = Log.create({ service: "ssh-tool" })

const DEFAULT_TIMEOUT = 2 * 60 * 1000
const ServerSchema = z.union([RemoteServerConfigSchema, z.string()])

function server(input: z.infer<typeof ServerSchema>) {
  if (typeof input !== "string") return input
  try {
    return RemoteServerConfigSchema.parse(JSON.parse(input))
  } catch (err) {
    throw new Error("server must be a remote server object or a JSON string containing one", { cause: err })
  }
}

export const SshTool = Tool.define("ssh", {
  description: DESCRIPTION,
  parameters: z.object({
    server: ServerSchema.describe(
      'Server connection config. Supports direct mode {"mode":"direct","address":"example.com","port":22,"user":"root","password":"xxx"} and ssh config mode {"mode":"ssh_config","host_alias":"target-dev-machine","ssh_config_path":"~/.ssh/config"}',
    ),
    command: z.string().describe("The bash command to execute on the remote server"),
    timeout: z.number().optional().describe("Optional timeout in milliseconds (default: 120000)"),
  }),
  async execute(params, ctx) {
    const cfg = server(params.server)
    const { command } = params
    const timeout = params.timeout ?? DEFAULT_TIMEOUT

    if (timeout < 0) {
      throw new Error(`Invalid timeout value: ${timeout}. Timeout must be a positive number.`)
    }

    log.info("ssh executing", {
      server: remoteServerLabel(cfg),
      command,
    })

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
            `${cfg.user}@${cfg.address}`,
            command,
          ]

    const args = cfg.password ? ["-p", cfg.password, "ssh", ...sshArgs] : ["ssh", ...sshArgs]
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
        description: `SSH ${remoteServerLabel(cfg)}`,
      },
    })

    const MAX_METADATA_LENGTH = 30_000

    const append = (chunk: Buffer) => {
      output += chunk.toString()
      ctx.metadata({
        metadata: {
          output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
          description: `SSH ${remoteServerLabel(cfg)}`,
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
      title: `SSH ${remoteServerLabel(cfg)}`,
      metadata: {
        output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
        exit: proc.exitCode,
        description: `SSH ${remoteServerLabel(cfg)}`,
      },
      output,
    }
  },
})
