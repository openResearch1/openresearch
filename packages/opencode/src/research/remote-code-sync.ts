import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { remoteServerLabel, resolveSshConfigPath, type RemoteServerConfig } from "./remote-server"
import { quote } from "./ssh-tunnel"
import { wrapRemoteScript } from "./remote-task-runner"

const excludes = [".git", ".gitignore", ".gitattributes", ".gitmodules", ".DS_Store", "__pycache__", "*.pyc"]

function target(server: RemoteServerConfig) {
  if (server.mode === "ssh_config") return server.host_alias
  return `${server.user}@${server.address}`
}

function remote(input: string) {
  const value = input.replace(/\/+$/, "")
  if (value === "~") return "~"
  if (value.startsWith("~/")) return `~/${quote(value.slice(2))}`
  return quote(value)
}

function destination(input: string) {
  const value = input.trim().replace(/\/+$/, "")
  if (!value) throw new Error("remote code path must be non-empty")
  return value
}

function ssh(server: RemoteServerConfig) {
  if (server.mode === "ssh_config") {
    return [
      "ssh",
      "-F",
      resolveSshConfigPath(server.ssh_config_path),
      ...(server.user ? ["-l", server.user] : []),
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "-o",
      "ClearAllForwardings=yes",
    ]
  }
  return [
    "ssh",
    "-p",
    String(server.port),
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ClearAllForwardings=yes",
  ]
}

function shell(args: string[]) {
  return args.map(quote).join(" ")
}

async function run(cmd: string, args: string[], timeout: number) {
  const proc = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
    },
  })
  let output = ""
  proc.stdout.on("data", (buf) => {
    output += buf.toString()
  })
  proc.stderr.on("data", (buf) => {
    output += buf.toString()
  })
  const timer = setTimeout(() => proc.kill("SIGTERM"), timeout)
  await new Promise<void>((resolve, reject) => {
    proc.once("error", reject)
    proc.once("exit", () => resolve())
  }).finally(() => clearTimeout(timer))
  return { ok: proc.exitCode === 0, code: proc.exitCode ?? 1, output: output.trim() }
}

export function defaultRemoteCodePath(expId: string) {
  return `experiments/${expId}`
}

export async function syncCodeToRemote(input: {
  server: RemoteServerConfig
  codePath: string
  remoteCodePath: string
  delete?: boolean
  timeout?: number
}) {
  const dir = path.resolve(input.codePath)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`code path is not a directory: ${dir}`)

  const timeout = input.timeout ?? 10 * 60 * 1000
  const dest = destination(input.remoteCodePath)
  const mkdir = await run("bash", ["-lc", wrapRemoteScript(input.server, `set -euo pipefail\nmkdir -p ${remote(dest)}`)], timeout)
  if (!mkdir.ok) return { ...mkdir, remoteCodePath: dest, server: remoteServerLabel(input.server) }

  const probe = await run(
    "bash",
    [
      "-lc",
      wrapRemoteScript(
        input.server,
        [
          "set +e",
          "bin=$(command -v rsync 2>/dev/null)",
          `if [ -z "$bin" ]; then bin=$(bash -lc ${quote("command -v rsync")} 2>/dev/null); fi`,
          `if [ -z "$bin" ]; then bin=$(bash -ic ${quote("command -v rsync")} 2>/dev/null); fi`,
          `printf '%s' "$bin"`,
        ].join("\n"),
      ),
    ],
    timeout,
  )
  const bin = probe.ok ? probe.output.split("\n").findLast((line) => line.startsWith("/")) : undefined

  const base = [
    "-az",
    ...(input.delete ? ["--delete"] : []),
    ...excludes.flatMap((item) => ["--exclude", item]),
    ...(bin ? ["--rsync-path", bin] : []),
    "-e",
    shell(ssh(input.server)),
    `${dir.replace(/\/+$/, "")}/`,
    `${target(input.server)}:${dest}/`,
  ]
  const cmd = input.server.password ? "sshpass" : "rsync"
  const args = input.server.password ? ["-p", input.server.password, "rsync", ...base] : base
  const result = await run(cmd, args, timeout)
  return { ...result, remoteCodePath: dest, server: remoteServerLabel(input.server) }
}
