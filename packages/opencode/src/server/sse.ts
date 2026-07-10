import type { SSEStreamingApi } from "hono/streaming"

const padding = ":" + " ".repeat(2048) + "\n\n"

export async function open(stream: SSEStreamingApi) {
  await stream.write(padding)
}

export function heartbeat(stream: SSEStreamingApi, data: unknown) {
  return setInterval(() => {
    void stream.writeSSE({
      data: JSON.stringify(data),
    })
  }, 10_000)
}
