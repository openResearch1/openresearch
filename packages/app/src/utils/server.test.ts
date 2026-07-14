import { describe, expect, test } from "bun:test"
import { createSdkForServer } from "./server"

describe("createSdkForServer", () => {
  test("adds remote token header from the server url", async () => {
    let request: Request | undefined
    const fetch = (async (input: RequestInfo | URL) => {
      request = input instanceof Request ? input : new Request(input)
      return new Response(JSON.stringify({ healthy: true, version: "test" }), {
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch

    const sdk = createSdkForServer({
      server: { url: "https://demo.trycloudflare.com?token=tok_test" },
      fetch,
    })
    await sdk.global.health()

    expect(request?.headers.get("x-opencode-remote-token")).toBe("tok_test")
    expect(request?.url).toBe("https://demo.trycloudflare.com/global/health")
  })

  test("adds remote token header to the event stream", async () => {
    let request: Request | undefined
    const fetch = (async (input: RequestInfo | URL) => {
      request = input instanceof Request ? input : new Request(input)
      return new Response('data: {"type":"storage.write","properties":{"key":"test"}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      })
    }) as typeof globalThis.fetch

    const sdk = createSdkForServer({
      server: { url: "https://demo.trycloudflare.com?token=tok_test" },
      fetch,
    })
    const events = await sdk.global.event()

    for await (const _ of events.stream) break

    expect(request?.headers.get("x-opencode-remote-token")).toBe("tok_test")
    expect(request?.url).toBe("https://demo.trycloudflare.com/global/event")
  })
})
