import { chmod } from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import z from "zod"

import { Instance } from "../../src/project/instance"
import { RemoteServerTable } from "../../src/research/research.sql"
import { Database } from "../../src/storage/db"
import { SshTool } from "../../src/tool/ssh"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

beforeEach(async () => resetDatabase())
afterEach(async () => resetDatabase())

describe("tool.ssh", () => {
  test("requires a scalar server target and description in JSON schema", async () => {
    const tool = await SshTool.init()
    const schema = z.toJSONSchema(tool.parameters) as any

    expect(schema.properties.server.type).toBe("string")
    expect(schema.properties.remoteServerId).toBeUndefined()
    expect(schema.required).toContain("server")
    expect(schema.required).toContain("description")
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
      const updates: { metadata?: Record<string, unknown> }[] = []
      const result = await tool.execute(
        {
          server: JSON.stringify({
            mode: "direct",
            address: "example.com",
            port: 2222,
            user: "root",
          }),
          command: "pwd",
          description: "Checks remote directory",
        },
        {
          sessionID: "session",
          messageID: "message",
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata(input) {
            updates.push(input)
          },
          async ask() {},
        },
      )

      expect(result.output).toContain("2222")
      expect(result.output).toContain("root@example.com")
      expect(result.output).toContain("pwd")
      expect(result.output).toContain("BatchMode=yes")
      expect(result.output).toContain("NumberOfPasswordPrompts=0")
      expect(result.metadata.description).toBe("Checks remote directory")
      expect(result.metadata.server).toBe("root@example.com:2222")
      expect(
        updates.some(
          (item) =>
            item.metadata?.description === "Checks remote directory" && item.metadata.server === "root@example.com:2222",
        ),
      ).toBe(true)
      await expect(
        tool.execute(
          {
            server: "{}",
            command: "pwd",
            description: "Checks remote directory",
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
        ),
      ).rejects.toThrow("server must be a JSON string containing a remote server config")
    } finally {
      process.env.PATH = prev
    }
  })

  test("hydrates a missing direct password from a unique stored server", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const bin = path.join(dir, "sshpass")
        const log = path.join(dir, "sshpass-args")
        await Bun.write(bin, `#!/usr/bin/env bash\nprintf "%s\\n" "$@" > ${JSON.stringify(log)}\nprintf "ok\\n"\n`)
        await chmod(bin, 0o755)
        return log
      },
    })
    Database.use((db) =>
      db
        .insert(RemoteServerTable)
        .values({
          id: "server-1",
          config: JSON.stringify({
            mode: "direct",
            address: "example.com",
            port: 2222,
            user: "root",
            password: "stored-secret",
          }),
        })
        .run(),
    )

    const prev = process.env.PATH
    process.env.PATH = `${tmp.path}:${prev ?? ""}`
    try {
      const tool = await SshTool.init()
      const ctx = {
        sessionID: "session",
        messageID: "message",
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata() {},
        async ask() {},
      }
      const result = await tool.execute(
        {
          server: JSON.stringify({
            mode: "direct",
            address: "example.com",
            port: 2222,
            user: "root",
            has_password: true,
          }),
          command: "pwd",
          description: "Checks remote directory",
        },
        ctx,
      )

      expect(await Bun.file(tmp.extra).text()).toContain("stored-secret")
      expect(result.metadata.remoteServerId).toBe("server-1")
      expect(JSON.stringify(result.metadata)).not.toContain("stored-secret")

      const explicit = await tool.execute(
        {
          server: JSON.stringify({
            mode: "direct",
            address: "example.com",
            port: 2222,
            user: "root",
            password: "explicit-secret",
          }),
          command: "pwd",
          description: "Checks remote directory",
        },
        ctx,
      )
      expect(await Bun.file(tmp.extra).text()).toContain("explicit-secret")
      expect(await Bun.file(tmp.extra).text()).not.toContain("stored-secret")

      Database.use((db) =>
        db
          .insert(RemoteServerTable)
          .values({
            id: "server-2",
            config: JSON.stringify({
              mode: "direct",
              address: "example.com",
              port: 2222,
              user: "root",
              password: "other-secret",
            }),
          })
          .run(),
      )
      await expect(
        tool.execute(
          {
            server: JSON.stringify({ mode: "direct", address: "example.com", port: 2222, user: "root" }),
            command: "pwd",
            description: "Checks remote directory",
          },
          ctx,
        ),
      ).rejects.toThrow("multiple stored remote servers match root@example.com:2222; pass a stored server ID")
    } finally {
      process.env.PATH = prev
    }
  })

  test("accepts a stored remote server ID", async () => {
    await using tmp = await tmpdir({
      git: true,
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
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Database.use((db) =>
            db
              .insert(RemoteServerTable)
              .values({
                id: "server-1",
                config: JSON.stringify({ mode: "direct", address: "example.com", port: 2222, user: "root" }),
              })
              .run(),
          )

          const tool = await SshTool.init()
          const result = await tool.execute(
            {
              server: "server-1",
              command: "pwd",
              description: "Checks remote directory",
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

          expect(result.output).toContain("root@example.com")
          expect(result.metadata.server).toBe("root@example.com:2222")
          expect(result.metadata.remoteServerId).toBe("server-1")
          await expect(
            tool.execute(
              {
                server: "missing",
                command: "pwd",
                description: "Checks remote directory",
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
            ),
          ).rejects.toThrow("remote server not found: missing")
        },
      })
    } finally {
      process.env.PATH = prev
    }
  })

  test("uses OpenSSH config without matching a stored password", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const bin = path.join(dir, "ssh")
        await Bun.write(bin, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n')
        await chmod(bin, 0o755)
        return bin
      },
    })
    Database.use((db) =>
      db
        .insert(RemoteServerTable)
        .values({
          id: "server-ssh-config",
          config: JSON.stringify({
            mode: "ssh_config",
            host_alias: "target-dev-machine-roce",
            ssh_config_path: "/home/zzh/.ssh/config",
            password: "stored-secret",
          }),
        })
        .run(),
    )

    const prev = process.env.PATH
    process.env.PATH = `${tmp.path}:${prev ?? ""}`
    try {
      const tool = await SshTool.init()
      const result = await tool.execute(
        {
          server: JSON.stringify({
            mode: "ssh_config",
            host_alias: "target-dev-machine-roce",
            ssh_config_path: "/home/zzh/.ssh/config",
          }),
          command: "nvidia-smi",
          description: "Checks remote GPU status",
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

      expect(result.output.split("\n").slice(0, 2)).toEqual(["-F", "/home/zzh/.ssh/config"])
      expect(result.output).toContain("target-dev-machine-roce")
      expect(result.output).toContain("BatchMode=yes")
      expect(result.output).not.toContain("stored-secret")
      expect(result.output).not.toStartWith("ssh\n")
    } finally {
      process.env.PATH = prev
    }
  })
})
