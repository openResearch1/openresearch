import { EventEmitter } from "node:events"

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { stopRemote } from "../../src/server/routes/remote"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { Log } from "../../src/util/log"
import { Process } from "../../src/util/process"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function child() {
  let exit: (code: number) => void = () => {}
  const proc = new EventEmitter() as Process.Child
  proc.stdout = new EventEmitter() as Process.Child["stdout"]
  proc.stderr = new EventEmitter() as Process.Child["stderr"]
  proc.kill = mock(() => true) as Process.Child["kill"]
  proc.exited = new Promise<number>((resolve) => {
    exit = resolve
  })
  return {
    exit,
    proc,
  }
}

afterEach(async () => {
  await stopRemote()
  await resetDatabase()
})

describe("remote routes", () => {
  test("serves the remote page", async () => {
    const app = Server.App()
    const res = await app.request("/remote")

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toContain("opencode remote")
  }, 10000)

  test("returns remote info", async () => {
    const app = Server.App()
    const res = await app.request("http://192.168.1.10:4096/remote/api/info")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      urls: ["http://192.168.1.10:4096/remote"],
      local: "http://192.168.1.10:4096/remote",
      exposed: true,
      tunnel: {
        provider: "cloudflare",
        status: "idle",
      },
    })
  })

  test("does not expose phone urls when server is loopback-only", async () => {
    const server = Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/remote/api/info`)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        urls: [],
        local: `http://127.0.0.1:${server.port}/remote`,
        exposed: false,
        reason: "loopback",
        tunnel: {
          provider: "cloudflare",
          status: "idle",
        },
      })
    } finally {
      await server.stop(true)
    }
  })

  test("starts a token-protected remote listener", async () => {
    await using tmp = await tmpdir({ git: true })
    const server = Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const dir = tmp.path
      const res = await fetch(`http://127.0.0.1:${server.port}/remote/api/expose?directory=${encodeURIComponent(dir)}`, {
        method: "POST",
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { urls: string[]; exposed: boolean }
      expect(body.exposed).toBe(body.urls.length > 0)
      if (!body.urls[0]) return

      const url = new URL(body.urls[0])
      expect(url.searchParams.get("directory")).toBe(dir)
      url.hostname = "127.0.0.1"
      const denied = await fetch(`${url.protocol}//${url.host}/remote`)
      expect(denied.status).toBe(401)

      const allowed = await fetch(url)
      expect(allowed.status).toBe(200)
      const cookie = allowed.headers.get("set-cookie")
      expect(cookie).toContain("opencode_remote_token=")
      const html = await allowed.text()
      expect(html).toContain("opencode remote")
      expect(html).toContain('url.searchParams.set("token", token)')
      expect(html).toContain('url.searchParams.set("directory", directory)')
      expect(html).toContain('/remote/project/')
      expect(html).toContain('/remote/session/')
      expect(html).toContain('status === "idle" ? ""')
      expect(html).not.toContain("Select all")
      expect(html).not.toContain('type="checkbox"')
      expect(html).not.toContain("href(session)")
      expect(html).not.toContain('id="message"')
      expect(html).not.toContain('id="send"')
      expect(html).not.toContain("Send to project sessions")

      const api = new URL("/remote/api/session", url)
      const deniedApi = await fetch(`${api.protocol}//${api.host}/remote/api/session`)
      expect(deniedApi.status).toBe(401)

      const cookieApi = new URL("/path", url)
      const allowedPath = await fetch(cookieApi, {
        headers: {
          cookie: cookie?.split(";")[0] ?? "",
        },
      })
      expect(allowedPath.status).toBe(200)

      api.search = url.search
      const sessions = await fetch(api)
      expect(sessions.status).toBe(200)
      expect(await sessions.json()).toEqual([])
    } finally {
      await server.stop(true)
    }
  })

  test("starts a cloudflare tunnel for the exposed remote listener", async () => {
    await using tmp = await tmpdir({ git: true })
    const fake = child()
    const run = Process.spawn
    const spawn = spyOn(Process, "spawn").mockImplementation((cmd, opts) => {
      if (cmd[0] === "cloudflared") return fake.proc
      return run(cmd, opts)
    })

    try {
      const app = Server.App()
      const res = await app.request(
        `http://127.0.0.1:4096/remote/api/tunnel/start?directory=${encodeURIComponent(tmp.path)}`,
        {
          method: "POST",
        },
      )

      expect(res.status).toBe(200)
      const body = (await res.json()) as { tunnel: { status: string }; urls: string[] }
      expect(body.tunnel.status).toBe("starting")
      const call = spawn.mock.calls.find((item) => item[0][0] === "cloudflared")
      expect(call?.[0]).toEqual([
        "cloudflared",
        "tunnel",
        "--url",
        expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      ])

      fake.proc.stderr?.emit("data", Buffer.from("Your quick Tunnel has been created! https://phone-demo.trycloudflare.com"))
      const info = await app.request("http://127.0.0.1:4096/remote/api/info")
      const ready = (await info.json()) as { tunnel: { status: string; url: string } }
      const url = new URL(ready.tunnel.url)

      expect(ready.tunnel.status).toBe("ready")
      expect(`${url.protocol}//${url.host}`).toBe("https://phone-demo.trycloudflare.com")
      expect(url.pathname).toBe("/remote")
      expect(url.searchParams.get("token")).toBeTruthy()
      expect(url.searchParams.get("directory")).toBe(tmp.path)
    } finally {
      spawn.mockRestore()
    }
  })

  test("stops the cloudflare tunnel without stopping the remote listener", async () => {
    const fake = child()
    const run = Process.spawn
    const spawn = spyOn(Process, "spawn").mockImplementation((cmd, opts) => {
      if (cmd[0] === "cloudflared") return fake.proc
      return run(cmd, opts)
    })

    try {
      const app = Server.App()
      const started = await app.request("http://127.0.0.1:4096/remote/api/tunnel/start", {
        method: "POST",
      })
      expect(started.status).toBe(200)
      fake.proc.stderr?.emit("data", Buffer.from("https://phone-stop.trycloudflare.com"))

      const res = await app.request("http://127.0.0.1:4096/remote/api/tunnel", {
        method: "DELETE",
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { tunnel: { status: string }; urls: string[] }
      expect(body.tunnel.status).toBe("idle")
      expect(body.urls.length).toBeGreaterThan(0)
      expect(fake.proc.kill).toHaveBeenCalledWith("SIGTERM")
    } finally {
      spawn.mockRestore()
    }
  })

  test("reports cloudflared launch failures", async () => {
    const fake = child()
    const run = Process.spawn
    const spawn = spyOn(Process, "spawn").mockImplementation((cmd, opts) => {
      if (cmd[0] === "cloudflared") return fake.proc
      return run(cmd, opts)
    })

    try {
      const app = Server.App()
      const res = await app.request("http://127.0.0.1:4096/remote/api/tunnel/start", {
        method: "POST",
      })

      expect(res.status).toBe(200)
      expect(((await res.json()) as { tunnel: { status: string } }).tunnel.status).toBe("starting")
      fake.exit(1)
      await new Promise((resolve) => setTimeout(resolve, 0))

      const info = await app.request("http://127.0.0.1:4096/remote/api/info")
      const body = (await info.json()) as { tunnel: { status: string; message: string } }
      expect(body.tunnel.status).toBe("error")
      expect(body.tunnel.message).toContain("cloudflared exited before publishing a URL")
    } finally {
      spawn.mockRestore()
    }
  })

  test("returns phone urls when server listens on all interfaces", async () => {
    const server = Server.listen({ hostname: "0.0.0.0", port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/remote/api/info`)

      expect(res.status).toBe(200)
      const body = (await res.json()) as { urls: string[]; local: string; exposed: boolean; reason?: string }
      expect(body.local).toBe(`http://127.0.0.1:${server.port}/remote`)
      expect(body.exposed).toBe(body.urls.length > 0)
      expect(body.urls.every((url) => url.endsWith(`:${server.port}/remote`))).toBe(true)
      expect(body.reason).toBe(body.urls.length > 0 ? undefined : "no_network_address")
    } finally {
      await server.stop(true)
    }
  })

  test("serves project and session remote pages", async () => {
    const app = Server.App()

    const project = await app.request("/remote/project/demo")
    expect(project.status).toBe(200)
    const html = await project.text()
    expect(html).toContain("opencode remote")
    expect(html).not.toContain('id="message"')
    expect(html).not.toContain('id="send"')

    const session = await app.request("/remote/session/ZGly/ses_test")
    expect(session.status).toBe(200)
    expect(await session.text()).not.toContain("opencode remote")
  })

  test("lists unarchived root sessions with instance status", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.App()

    const sessions = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const child = await Session.create({ title: "child", parentID: root.id })
        const archived = await Session.create({ title: "archived" })
        await Session.setArchived({ sessionID: archived.id, time: Date.now() })
        SessionStatus.set(root.id, { type: "busy" })
        return { archived, child, root }
      },
    })

    const res = await app.request("/remote/api/session", {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as Array<{ id: string; title: string; status: { type: string } }>
    const ids = body.map((item) => item.id)

    expect(ids).toContain(sessions.root.id)
    expect(ids).not.toContain(sessions.child.id)
    expect(ids).not.toContain(sessions.archived.id)
    expect(body.find((item) => item.id === sessions.root.id)?.status.type).toBe("busy")
  })

  test("returns one session and its messages", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.App()

    const session = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await Session.create({ title: "chat" })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: item.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: item.id,
          messageID,
          type: "text",
          text: "hello from history",
        })
        return item
      },
    })

    const detail = await app.request(`/remote/api/session/${session.id}`)
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      id: session.id,
      title: "chat",
      status: { type: "idle" },
    })

    const res = await app.request(`/remote/api/session/${session.id}/message?limit=10`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as MessageV2.WithParts[]
    expect(body).toHaveLength(1)
    expect(body[0]?.info.id).toBeDefined()
    expect(body[0]?.parts[0]).toMatchObject({
      type: "text",
      text: "hello from history",
    })
  })

  test("accepts messages for multiple sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.App()

    const sessions = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        return [await Session.create({ title: "one" }), await Session.create({ title: "two" })]
      },
    })

    const prompt = spyOn(
      SessionPrompt,
      "prompt",
    ).mockImplementation(
      (async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
        return {
          info: {
            id: input.messageID ?? "msg_test",
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: "test", modelID: "test" },
          },
          parts: [],
        } satisfies MessageV2.WithParts
      }) as unknown as typeof SessionPrompt.prompt,
    )

    try {
      const res = await app.request("/remote/api/message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          sessionIDs: sessions.map((session) => session.id),
          text: "hello from phone",
        }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(
        sessions.map((session) => ({
          sessionID: session.id,
          ok: true,
          message: "accepted",
        })),
      )
      expect(prompt).toHaveBeenCalledTimes(2)
      expect(prompt.mock.calls[0]?.[0].parts).toEqual([{ type: "text", text: "hello from phone" }])
    } finally {
      prompt.mockRestore()
    }
  })

  test("rejects empty message input", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.App()
    const session = await Instance.provide({
      directory: tmp.path,
      fn: async () => Session.create({ title: "one" }),
    })

    const res = await app.request("/remote/api/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({
        sessionIDs: [session.id],
        text: "   ",
      }),
    })

    expect(res.status).toBe(400)
  })

  test("reports archived sessions as errors", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.App()
    const session = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await Session.create({ title: "archived" })
        await Session.setArchived({ sessionID: item.id, time: Date.now() })
        return item
      },
    })

    const res = await app.request("/remote/api/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({
        sessionIDs: [session.id],
        text: "hello",
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ sessionID: session.id, ok: false, message: "Session is archived" }])
  })

  test("reports busy sessions as errors", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.App()
    const session = await Instance.provide({
      directory: tmp.path,
      fn: async () => Session.create({ title: "busy" }),
    })
    const busy = spyOn(SessionPrompt, "assertNotBusy").mockImplementation(() => {
      throw new Session.BusyError(session.id)
    })

    try {
      const res = await app.request("/remote/api/message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          sessionIDs: [session.id],
          text: "hello",
        }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual([{ sessionID: session.id, ok: false, message: `Session ${session.id} is busy` }])
    } finally {
      busy.mockRestore()
    }
  })
})
