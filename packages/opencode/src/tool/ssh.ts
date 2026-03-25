import z from "zod"
import { spawn } from "child_process"
import { Tool } from "./tool"
import DESCRIPTION from "./ssh.txt"
import { Log } from "../util/log"

const log = Log.create({ service: "ssh-tool" })

const DEFAULT_TIMEOUT = 2 * 60 * 1000

const ServerConfigSchema = z.object({
  address: z.string().describe("The server hostname or IP address"),
  port: z.number().describe("The SSH port number"),
  user: z.string().describe("The SSH username"),
  password: z.string().describe("The SSH password"),
})

export const SshTool = Tool.define("ssh", {
  description: DESCRIPTION,
  parameters: z.object({
    server: ServerConfigSchema.describe(
      'Server connection config as JSON, e.g. {"address":"example.com","port":22,"user":"root","password":"xxx"}',
    ),
    command: z.string().describe("The bash command to execute on the remote server"),
    timeout: z.number().optional().describe("Optional timeout in milliseconds (default: 120000)"),
  }),
  async execute(params, ctx) {
    const { server, command } = params
    const timeout = params.timeout ?? DEFAULT_TIMEOUT

    if (timeout < 0) {
      throw new Error(`Invalid timeout value: ${timeout}. Timeout must be a positive number.`)
    }

    log.info("ssh executing", {
      address: server.address,
      port: server.port,
      user: server.user,
      command,
    })

    const sshArgs = [
      "-p",
      String(server.port),
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      `${server.user}@${server.address}`,
      command,
    ]

    const proc = spawn("sshpass", ["-p", server.password, "ssh", ...sshArgs], {
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
        description: `SSH ${server.user}@${server.address}:${server.port}`,
      },
    })

    const MAX_METADATA_LENGTH = 30_000

    const append = (chunk: Buffer) => {
      output += chunk.toString()
      ctx.metadata({
        metadata: {
          output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
          description: `SSH ${server.user}@${server.address}:${server.port}`,
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
      title: `SSH ${server.user}@${server.address}:${server.port}`,
      metadata: {
        output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
        exit: proc.exitCode,
        description: `SSH ${server.user}@${server.address}:${server.port}`,
      },
      output,
    }
  },
})
