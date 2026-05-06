import { spawn, type ChildProcess } from "node:child_process"
import { createConnection } from "node:net"
import { Log } from "@/util/log"
import { resolveSshConfigPath, type RemoteServerConfig } from "./remote-server"

const log = Log.create({ service: "ssh-tunnel" })
const live = new Map<string, ChildProcess>()
const wait = new Map<string, Promise<void>>()

function sh(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function key(server: RemoteServerConfig) {
  if (server.mode === "ssh_config") return JSON.stringify([server.mode, server.host_alias, server.user, server.network])
  return JSON.stringify([server.mode, server.address, server.port, server.user, server.network])
}

function host(server: RemoteServerConfig) {
  if (server.mode === "ssh_config") return server.host_alias
  return `${server.user}@${server.address}`
}

function parseProxy(input: string) {
  const value = input.includes("://") ? new URL(input) : new URL(`http://${input}`)
  const port = Number.parseInt(value.port || "80", 10)
  if (!value.hostname || !Number.isFinite(port) || port <= 0) {
    throw new Error(`invalid local proxy: ${input}`)
  }
  return { host: value.hostname, port }
}

function env(server: RemoteServerConfig) {
  const net = server.network
  if (!net || net.mode !== "tunnel") return
  const proxy = `http://127.0.0.1:${net.remote_port}`
  return {
    http_proxy: proxy,
    https_proxy: proxy,
    no_proxy: net.no_proxy ?? "localhost,127.0.0.1",
  }
}

async function probe(input: string, timeout = 1500) {
  const dst = parseProxy(input)
  await new Promise<void>((resolve, reject) => {
    const sock = createConnection(dst.port, dst.host)
    const done = (err?: Error) => {
      sock.removeAllListeners()
      sock.destroy()
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => done(new Error(`local proxy is unreachable: ${input}`)), timeout)
    sock.once("connect", () => {
      clearTimeout(timer)
      done()
    })
    sock.once("error", (err) => {
      clearTimeout(timer)
      done(err)
    })
  })
}

export function buildTunnelArgs(server: RemoteServerConfig) {
  const net = server.network
  if (!net || net.mode !== "tunnel") return
  const dst = parseProxy(net.local_proxy)
  const ssh =
    server.mode === "ssh_config"
      ? [
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
          "ExitOnForwardFailure=yes",
          "-o",
          "ServerAliveInterval=30",
          "-o",
          "ServerAliveCountMax=3",
          "-N",
          "-T",
          "-R",
          `127.0.0.1:${net.remote_port}:${dst.host}:${dst.port}`,
          server.host_alias,
        ]
      : [
          "-p",
          String(server.port),
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          "-o",
          "LogLevel=ERROR",
          "-o",
          "ExitOnForwardFailure=yes",
          "-o",
          "ServerAliveInterval=30",
          "-o",
          "ServerAliveCountMax=3",
          "-N",
          "-T",
          "-R",
          `127.0.0.1:${net.remote_port}:${dst.host}:${dst.port}`,
          `${server.user}@${server.address}`,
        ]
  return server.password ? { cmd: "sshpass", args: ["-p", server.password, "ssh", ...ssh] } : { cmd: "ssh", args: ssh }
}

async function launch(server: RemoteServerConfig) {
  const spec = buildTunnelArgs(server)
  const net = server.network
  if (!spec || !net || net.mode !== "tunnel") return
  await probe(net.local_proxy)
  const proc = spawn(spec.cmd, spec.args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
    },
  })
  let err = ""
  proc.stderr?.on("data", (buf) => {
    err += buf.toString()
  })
  const id = key(server)
  proc.once("exit", () => {
    if (live.get(id) === proc) live.delete(id)
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, 500)
    const fail = (cause?: Error) => {
      cleanup()
      reject(cause ?? new Error(err.trim() || `failed to start ssh tunnel for ${host(server)}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      proc.removeListener("error", fail)
      proc.removeListener("exit", onExit)
    }
    const onExit = () => fail(new Error(err.trim() || `ssh tunnel exited before startup for ${host(server)}`))
    proc.once("error", fail)
    proc.once("exit", onExit)
  })
  proc.stderr?.destroy()
  proc.unref()
  live.set(id, proc)
  log.info("ssh tunnel ready", { server: host(server), pid: proc.pid, remotePort: net.remote_port })
  return proc
}

export function tunnelEnv(server: RemoteServerConfig) {
  return env(server)
}

export async function ensureTunnel(server: RemoteServerConfig) {
  const vars = env(server)
  if (!vars) return { enabled: false as const }
  const id = key(server)
  const proc = live.get(id)
  if (!proc || proc.exitCode !== null || proc.killed) {
    const job = wait.get(id) ?? launch(server).then(() => {})
    wait.set(id, job)
    try {
      await job
    } finally {
      if (wait.get(id) === job) wait.delete(id)
    }
  }
  return {
    enabled: true as const,
    pid: live.get(id)?.pid ?? null,
    env: vars,
  }
}

export function quote(value: string) {
  return sh(value)
}
