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

export function control(root: string, taskId: string, screenName: string) {
  const dir = `${root.replace(/\/$/, "")}/.openresearch/tasks/${taskId}`
  return {
    dir,
    logPath: `${dir}/task.log`,
    exitPath: `${dir}/exit-${screenName}`,
    pendingPath: `${dir}/exit-${screenName}.pending`,
  }
}

export function session(_taskId: string) {
  return `openresearch-${Date.now()}-${randomBytes(3).toString("hex")}`
}

export function remoteTaskScript(input: {
  server: RemoteServerConfig
  command: string
  exitPath: string
  pendingPath: string
}) {
  return [
    `screen -S "$STY" -X logfile flush 1 >/dev/null 2>&1 || true`,
    `printf 'START %s\n' "$(date)"`,
    ...taskEnv(input.server),
    "set +e",
    `bash -lc ${sh(input.command)}`,
    "code=$?",
    `tmp=${sh(input.exitPath)}.tmp.$$`,
    `if printf '%s\n' "$code" > "$tmp" && mv -f -- "$tmp" ${sh(input.exitPath)}; then rm -f ${sh(input.pendingPath)}; else printf 'STATUS_WRITE_FAILED:%s\n' ${sh(input.exitPath)} >&2; fi`,
    `printf 'EXIT_CODE:%s\n' "$code"`,
    `exit "$code"`,
  ].join("\n")
}

export function startRemoteTaskScript(input: {
  server: RemoteServerConfig
  taskId: string
  remoteRoot: string
  screenName: string
  command: string
}) {
  const paths = control(input.remoteRoot, input.taskId, input.screenName)
  const screenName = sh(input.screenName)
  const task = remoteTaskScript({
    server: input.server,
    command: input.command,
    exitPath: paths.exitPath,
    pendingPath: paths.pendingPath,
  })
  return [
    "set -euo pipefail",
    `mkdir -p ${sh(paths.dir)}`,
    `touch ${sh(paths.logPath)}`,
    `rm -f ${sh(paths.exitPath)}`,
    `touch ${sh(paths.pendingPath)}`,
    `screen -S ${screenName} -X quit >/dev/null 2>&1 || true`,
    `screen -L -Logfile ${sh(paths.logPath.replaceAll("%", "%%"))} -dmS ${screenName} bash -lc ${sh(task)}`,
  ].join("\n")
}

export async function startRemoteTask(input: {
  server: RemoteServerConfig
  taskId: string
  remoteRoot: string
  screenName: string
  command: string
}) {
  await ensureTunnel(input.server)
  const paths = control(input.remoteRoot, input.taskId, input.screenName)
  const result = await exec(input.server, startRemoteTaskScript(input))
  return { ...result, ...paths }
}

export async function inspectRemoteTask(input: {
  server: RemoteServerConfig
  logPath: string
  screenName: string
  exitPath?: string
  pendingPath?: string
  targetPath?: string | null
}) {
  return exec(input.server, inspectRemoteTaskScript(input))
}

export function inspectRemoteTaskScript(input: {
  logPath: string
  screenName: string
  exitPath?: string
  pendingPath?: string
  targetPath?: string | null
}) {
  return [
    "set -euo pipefail",
    `printf '__SCREEN__\n'`,
    `out=$(LC_ALL=C screen -ls 2>/dev/null || true)`,
    `line=$(printf '%s\n' "$out" | awk -v name=${sh(input.screenName)} '$1 ~ /^[0-9]+\\./ { value=$1; sub(/^[^.]*\\./, "", value); if (value == name) { print; exit } }')`,
    `if [ -n "$line" ]; then printf '%s' "$line"; else printf 'stopped'; fi`,
    `printf '\n__TARGET__\n'`,
    input.targetPath
      ? `if [ -e ${sh(input.targetPath)} ]; then printf 'present'; else printf 'missing'; fi`
      : `printf 'unknown'`,
    `printf '\n__EXIT__\n'`,
    input.exitPath && input.pendingPath
      ? `if [ -f ${sh(input.exitPath)} ]; then cat ${sh(input.exitPath)}; elif [ -f ${sh(input.pendingPath)} ]; then printf 'pending'; else printf 'legacy'; fi`
      : `printf 'legacy'`,
    `printf '\n__TAIL__\n'`,
    `if [ -f ${sh(input.logPath)} ]; then tail -n 40 ${sh(input.logPath)}; fi`,
  ].join("\n")
}

export function screenState(value: string) {
  const state = value.trim()
  if (["attached", "detached", "dead", "running", "stopped", "unknown"].includes(state)) return state
  if (/\((?:multi,\s*)?detached\)/i.test(state)) return "detached"
  if (/\((?:multi,\s*)?attached\)/i.test(state)) return "attached"
  if (/\((?:dead(?:\s[^)]*)?|removed)\)/i.test(state)) return "dead"
  if (/\((?:remote or dead|private)\)/i.test(state)) return "unknown"
  if (state) return "running"
  return ""
}

export function parseInspectOutput(output: string) {
  const screenAt = output.indexOf("__SCREEN__\n")
  const targetAt = output.indexOf("\n__TARGET__\n", screenAt)
  const exitAt = output.indexOf("\n__EXIT__\n", targetAt)
  const tailAt = output.indexOf("\n__TAIL__\n", targetAt)

  if (screenAt === -1 || targetAt === -1 || tailAt === -1 || screenAt > targetAt || targetAt > tailAt) {
    return {
      screen: "",
      screenLine: "",
      target: "",
      code: undefined,
      managed: false,
      tail: output.trim(),
    }
  }

  const status =
    exitAt === -1 || exitAt > tailAt ? "legacy" : output.slice(exitAt + "\n__EXIT__\n".length, tailAt).trim()
  const code = /^\d+$/.test(status) ? Number(status) : undefined
  const line = output.slice(screenAt + "__SCREEN__\n".length, targetAt).trim()

  return {
    screen: screenState(line),
    screenLine: line,
    target: output
      .slice(targetAt + "\n__TARGET__\n".length, exitAt === -1 || exitAt > tailAt ? tailAt : exitAt)
      .trim(),
    code,
    managed: status !== "legacy",
    tail: output.slice(tailAt + "\n__TAIL__\n".length).trim(),
  }
}

export function exitCodeFromTail(tail: string) {
  const lines = tail.split("\n")
  const start = lines.findLastIndex((line) => /^START(?:\s|$)/.test(line.trimStart()))
  const text = (start === -1 ? lines : lines.slice(start)).join("\n")
  const match = [...text.matchAll(/EXIT_CODE:(\d+)/g)].at(-1)
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
