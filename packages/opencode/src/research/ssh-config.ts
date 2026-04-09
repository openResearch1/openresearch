type Host = {
  alias: string
  hostname?: string
  user?: string
  port?: number
  proxy_jump?: string
  remote_forward: string[]
}

function clean(input: string) {
  const hash = input.indexOf("#")
  return (hash >= 0 ? input.slice(0, hash) : input).trim()
}

function split(line: string) {
  const idx = line.search(/\s/)
  if (idx < 0) return [line.toLowerCase(), ""]
  return [line.slice(0, idx).toLowerCase(), line.slice(idx).trim()]
}

function pattern(input: string) {
  return input.includes("*") || input.includes("?") || input.includes("!")
}

export function parseSshConfig(input: string) {
  const list: Host[] = []
  const global: Record<string, string> = {}
  const lines = input.split(/\r?\n/)
  let current: Host[] = []

  const apply = (host: Host, key: string, value: string) => {
    if (key === "hostname") host.hostname = value
    if (key === "user") host.user = value
    if (key === "port") host.port = Number.parseInt(value, 10)
    if (key === "proxyjump") host.proxy_jump = value
    if (key === "remoteforward") host.remote_forward.push(value)
  }

  for (const raw of lines) {
    const line = clean(raw)
    if (!line) continue

    const [key, value] = split(line)
    if (!key) continue

    if (key === "host") {
      current = value
        .split(/\s+/)
        .filter(Boolean)
        .filter((item) => !pattern(item))
        .map((alias) => {
          const host = { alias, remote_forward: [] as string[] }
          for (const [k, v] of Object.entries(global)) apply(host, k, v)
          list.push(host)
          return host
        })
      continue
    }

    if (current.length === 0) {
      global[key] = value
      continue
    }

    current.forEach((host) => apply(host, key, value))
  }

  return list
}
