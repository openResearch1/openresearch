import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { Log } from "@/util/log"
import { remoteServerLabel, resolveSshConfigPath, type RemoteServerConfig } from "./remote-server"
import { ensureTunnel, quote, tunnelEnv } from "./ssh-tunnel"

const log = Log.create({ service: "remote-task-runner" })

const sh = quote

function marker(script: string) {
  let value = "EOF"
  while (script.includes(value)) value = `${value}_OPENCODE`
  return value
}

function remoteTarget(server: RemoteServerConfig) {
  if (server.mode === "ssh_config") return sh(server.host_alias)
  return sh(`${server.user}@${server.address}`)
}

export function taskEnv(server: RemoteServerConfig) {
  const vars = tunnelEnv(server)
  if (!vars) return []
  return [
    `export HTTP_PROXY=${sh(vars.http_proxy)} HTTPS_PROXY=${sh(vars.https_proxy)}`,
    `export http_proxy=${sh(vars.http_proxy)} https_proxy=${sh(vars.https_proxy)}`,
    `export NO_PROXY=${sh(vars.no_proxy)} no_proxy=${sh(vars.no_proxy)}`,
  ]
}

export function wrapRemoteScript(server: RemoteServerConfig, script: string) {
  const tag = marker(script)
  if (server.mode === "ssh_config") {
    return `${[
      server.password ? `sshpass -p ${sh(server.password)}` : null,
      "ssh",
      "-F",
      sh(resolveSshConfigPath(server.ssh_config_path)),
      server.user ? `-l ${sh(server.user)}` : null,
      "-o StrictHostKeyChecking=no",
      "-o UserKnownHostsFile=/dev/null",
      "-o LogLevel=ERROR",
      "-o ClearAllForwardings=yes",
      remoteTarget(server),
      `<<'${tag}'`,
    ]
      .filter(Boolean)
      .join(" ")}
${script}
${tag}`
  }
  return `${[
    server.password ? `sshpass -p ${sh(server.password)}` : null,
    "ssh",
    "-o StrictHostKeyChecking=no",
    "-o UserKnownHostsFile=/dev/null",
    "-o LogLevel=ERROR",
    "-o ClearAllForwardings=yes",
    "-p",
    String(server.port),
    remoteTarget(server),
    `<<'${tag}'`,
  ]
    .filter(Boolean)
    .join(" ")}
${script}
${tag}`
}

async function exec(server: RemoteServerConfig, script: string, timeout = 120000) {
  const command = wrapRemoteScript(server, script)
  log.info("remote exec", { server: remoteServerLabel(server), command })
  const proc = spawn("bash", ["-lc", command], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
    },
  })

  let out = ""
  proc.stdout.on("data", (buf) => {
    out += buf.toString()
  })
  proc.stderr.on("data", (buf) => {
    out += buf.toString()
  })

  let timed = false
  const timer = setTimeout(() => {
    timed = true
    proc.kill("SIGTERM")
  }, timeout)

  await new Promise<void>((resolve, reject) => {
    proc.once("error", reject)
    proc.once("exit", () => resolve())
  }).finally(() => clearTimeout(timer))

  if (timed) return { ok: false, output: `${out}\ncommand timed out`, code: proc.exitCode ?? 1 }
  return { ok: proc.exitCode === 0, output: out.trim(), code: proc.exitCode ?? 1 }
}

export function control(root: string, taskId: string) {
  const dir = `${root.replace(/\/$/, "")}/.openresearch/tasks/${taskId}`
  return {
    dir,
    logPath: `${dir}/task.log`,
  }
}

export function session(_taskId: string) {
  return `openresearch-${Date.now()}-${randomBytes(3).toString("hex")}`
}

export async function startRemoteTask(input: {
  server: RemoteServerConfig
  taskId: string
  remoteRoot: string
  screenName: string
  command: string
}) {
  await ensureTunnel(input.server)
  const paths = control(input.remoteRoot, input.taskId)
  const screenName = sh(input.screenName)
  const task = [
    `echo START $(date) >> ${sh(paths.logPath)}`,
    ...taskEnv(input.server),
    `${input.command} >> ${sh(paths.logPath)} 2>&1`,
    `echo EXIT_CODE:$? >> ${sh(paths.logPath)}`,
  ].join("\n")
  const remote = [
    "set -euo pipefail",
    `mkdir -p ${sh(paths.dir)}`,
    `screen -S ${screenName} -X quit >/dev/null 2>&1 || true`,
    `screen -dmS ${screenName} bash -lc ${sh(task)}`,
  ].join("\n")
  const result = await exec(input.server, remote)
  return { ...result, ...paths }
}

export async function inspectRemoteTask(input: {
  server: RemoteServerConfig
  logPath: string
  screenName: string
  targetPath?: string | null
}) {
  const match = `.${input.screenName}`
  const remote = [
    "set -euo pipefail",
    `printf '__SCREEN__\n'`,
    `out=$(screen -ls 2>/dev/null || true)`,
    `line=$(printf '%s\n' "$out" | grep -F -- ${sh(match)} || true)`,
    `if printf '%s\n' "$line" | grep -F -- '(Detached)' >/dev/null 2>&1; then printf 'detached'; elif printf '%s\n' "$line" | grep -F -- '(Attached)' >/dev/null 2>&1; then printf 'attached'; elif [ -n "$line" ]; then printf 'running'; else printf 'stopped'; fi`,
    `printf '\n__TARGET__\n'`,
    input.targetPath
      ? `if [ -e ${sh(input.targetPath)} ]; then printf 'present'; else printf 'missing'; fi`
      : `printf 'unknown'`,
    `printf '\n__TAIL__\n'`,
    `if [ -f ${sh(input.logPath)} ]; then tail -n 40 ${sh(input.logPath)}; fi`,
  ].join("\n")
  return exec(input.server, remote)
}

export function parseInspectOutput(output: string) {
  const screenAt = output.lastIndexOf("__SCREEN__\n")
  const targetAt = output.lastIndexOf("\n__TARGET__\n")
  const tailAt = output.lastIndexOf("\n__TAIL__\n")

  if (screenAt === -1 || targetAt === -1 || tailAt === -1 || screenAt > targetAt || targetAt > tailAt) {
    return {
      screen: "",
      target: "",
      tail: output.trim(),
    }
  }

  return {
    screen: output.slice(screenAt + "__SCREEN__\n".length, targetAt).trim(),
    target: output.slice(targetAt + "\n__TARGET__\n".length, tailAt).trim(),
    tail: output.slice(tailAt + "\n__TAIL__\n".length).trim(),
  }
}

export function exitCodeFromTail(tail: string) {
  const match = /EXIT_CODE:(\d+)/.exec(tail)
  if (!match) return
  return Number(match[1])
}

export async function readRemoteTaskLog(input: { server: RemoteServerConfig; logPath: string; lines?: number }) {
  const remote = [
    "set -euo pipefail",
    `if [ -f ${sh(input.logPath)} ]; then tail -n ${input.lines ?? 400} ${sh(input.logPath)}; else exit 1; fi`,
  ].join("\n")
  return exec(input.server, remote)
}
