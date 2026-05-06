import { chmod } from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import z from "zod"

import { SshTool } from "../../src/tool/ssh"
import { tmpdir } from "../fixture/fixture"

describe("tool.ssh", () => {
  test("allows server string in JSON schema", async () => {
    const tool = await SshTool.init()
    const schema = z.toJSONSchema(tool.parameters) as any

    expect(schema.properties.server.anyOf.some((item: any) => item.type === "string")).toBe(true)
  })

  test("accepts server as JSON string", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const bin = path.join(dir, "ssh")
        await Bun.write(bin, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n')
        await chmod(bin, 0o755)
        return bin
      },
    })

    const prev = process.env.PATH
    process.env.PATH = `${tmp.path}:${prev ?? ""}`
    try {
      const tool = await SshTool.init()
      const result = await tool.execute(
        {
          server: JSON.stringify({
            mode: "direct",
            address: "example.com",
            port: 2222,
            user: "root",
          }),
          command: "pwd",
        },
        {
          sessionID: "session",
          messageID: "message",
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          async ask() {},
        },
      )

      expect(result.output).toContain("2222")
      expect(result.output).toContain("root@example.com")
      expect(result.output).toContain("pwd")
    } finally {
      process.env.PATH = prev
    }
  })
})
