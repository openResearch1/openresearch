import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"

function token(url?: string) {
  if (!url) return
  try {
    return new URL(url).searchParams.get("token") ?? undefined
  } catch {
    return
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const remote = token(globalThis.location?.href) ?? token(server.url)
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${btoa(`${server.username ?? "opencode"}:${server.password}`)}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    headers: {
      ...config.headers,
      ...auth,
      ...(remote ? { "x-opencode-remote-token": remote } : {}),
    },
    baseUrl: server.url.split("?")[0],
  })
}
