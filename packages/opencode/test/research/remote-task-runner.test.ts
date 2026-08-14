import { chmod } from "node:fs/promises"
import path from "path"

import { describe, expect, test } from "bun:test"

import { tmpdir } from "../fixture/fixture"
import {
  control,
  exitCodeFromTail,
  inspectRemoteTaskScript,
  parseInspectOutput,
  remoteTaskScript,
  screenState,
  session,
  startRemoteTaskScript,
  taskEnv,
  wrapRemoteScript,
} from "../../src/research/remote-task-runner"

const server = {
  mode: "ssh_config" as const,
  host_alias: "gpu-box",
}

describe("research.remote-task-runner", () => {
  test("wraps direct ssh script as heredoc command", () => {
    const cmd = wrapRemoteScript(
      {
        mode: "direct",
        address: "connect.cqa1.seetacloud.com",
        port: 38734,
        user: "root",
        password: "HX5a6bU9/hUP",
      },
      [
        "mkdir -p /mnt/zhouzih",
        "screen -dmS cub_download bash -lc 'echo START $(date) >> /mnt/zhouzih/cub_download.log'",
      ].join("\n"),
    )

    expect(cmd)
      .toBe(`sshpass -p 'HX5a6bU9/hUP' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ClearAllForwardings=yes -p 38734 'root@connect.cqa1.seetacloud.com' <<'EOF'
mkdir -p /mnt/zhouzih
screen -dmS cub_download bash -lc 'echo START $(date) >> /mnt/zhouzih/cub_download.log'
EOF`)
  })

  test("adds proxy exports when tunnel networking is configured", () => {
    expect(
      taskEnv({
        mode: "ssh_config",
        host_alias: "gpu-box",
        network: {
          mode: "tunnel",
          local_proxy: "127.0.0.1:7890",
          remote_port: 8890,
        },
      }),
    ).toEqual([
      "export HTTP_PROXY='http://127.0.0.1:8890' HTTPS_PROXY='http://127.0.0.1:8890'",
      "export http_proxy='http://127.0.0.1:8890' https_proxy='http://127.0.0.1:8890'",
      "export NO_PROXY='localhost,127.0.0.1' no_proxy='localhost,127.0.0.1'",
    ])
  })

  test("uses a unique heredoc marker when script contains EOF", () => {
    const cmd = wrapRemoteScript(
      {
        mode: "ssh_config",
        host_alias: "gpu-box",
      },
      "echo EOF\necho done",
    )

    expect(cmd).toContain("<<'EOF_OPENCODE'")
    expect(cmd.endsWith("EOF_OPENCODE")).toBeTrue()
  })

  test("runs a multiline strict script and records its exit code", async () => {
    await using tmp = await tmpdir()
    const exitPath = path.join(tmp.path, "exit-openresearch-test")
    const pendingPath = `${exitPath}.pending`
    await Bun.write(pendingPath, "")
    const output = path.join(tmp.path, "business.log")
    const script = remoteTaskScript({
      server,
      exitPath,
      pendingPath,
      command: [
        "set -euo pipefail",
        "value=multiline",
        `printf '%s\\n' "$value-first" | tee ${JSON.stringify(output)}`,
        "printf '%s\\n' second",
      ].join("\n"),
    })
    const proc = Bun.spawn(["bash", "-lc", script], { stdout: "pipe", stderr: "pipe" })
    const stdout = await new Response(proc.stdout).text()

    expect(await proc.exited).toBe(0)
    expect(stdout).toContain("multiline-first")
    expect(stdout).toContain("second")
    expect(await Bun.file(output).text()).toBe("multiline-first\n")
    expect(await Bun.file(exitPath).text()).toBe("0\n")
    expect(await Bun.file(pendingPath).exists()).toBeFalse()
  })

  test("records failure when a multiline script exits under strict mode", async () => {
    await using tmp = await tmpdir()
    const exitPath = path.join(tmp.path, "exit-openresearch-test")
    const pendingPath = `${exitPath}.pending`
    await Bun.write(pendingPath, "")
    const script = remoteTaskScript({
      server,
      exitPath,
      pendingPath,
      command: "set -euo pipefail\nprintf 'before\\n'\nfalse\nprintf 'after\\n' # trailing comment",
    })
    const proc = Bun.spawn(["bash", "-lc", script], { stdout: "pipe", stderr: "pipe" })
    const stdout = await new Response(proc.stdout).text()

    expect(await proc.exited).toBe(1)
    expect(stdout).toContain("before")
    expect(stdout).not.toContain("after")
    expect(stdout).toContain("EXIT_CODE:1")
    expect(await Bun.file(exitPath).text()).toBe("1\n")
  })

  test("uses screen PTY logging without injecting tee into the business script", () => {
    const script = startRemoteTaskScript({
      server,
      taskId: "task-1",
      remoteRoot: "/mnt/root%name",
      screenName: "openresearch-1",
      command: "printf 'one\\n'\nprintf 'two\\n'",
    })

    expect(script).toContain("screen -L -Logfile '/mnt/root%%name/.openresearch/tasks/task-1/task.log'")
    expect(script).toContain("touch '/mnt/root%name/.openresearch/tasks/task-1/exit-openresearch-1.pending'")
    expect(script).not.toContain("2>&1 | tee -a")
    expect(script).toContain("bash -lc")
  })

  test("parses managed exit status separately from untrusted log output", () => {
    const meta = parseInspectOutput(
      "__SCREEN__\nstopped\n__TARGET__\npresent\n__EXIT__\n7\n__TAIL__\nSTART\nEXIT_CODE:0\n__SCREEN__",
    )

    expect(meta.screen).toBe("stopped")
    expect(meta.target).toBe("present")
    expect(meta.code).toBe(7)
    expect(meta.managed).toBeTrue()
    expect(meta.tail).toContain("EXIT_CODE:0")
  })

  test("derives attempt status paths from the current screen name", () => {
    expect(control("/mnt/root/", "task-1", "openresearch-1")).toEqual({
      dir: "/mnt/root/.openresearch/tasks/task-1",
      logPath: "/mnt/root/.openresearch/tasks/task-1/task.log",
      exitPath: "/mnt/root/.openresearch/tasks/task-1/exit-openresearch-1",
      pendingPath: "/mnt/root/.openresearch/tasks/task-1/exit-openresearch-1.pending",
    })
  })

  test("reads exit code from the latest task log segment", () => {
    expect(exitCodeFromTail("START old\nEXIT_CODE:0\nSTART new")).toBeUndefined()
    expect(exitCodeFromTail("START old\nEXIT_CODE:0\nSTART new\nEXIT_CODE:130")).toBe(130)
    expect(exitCodeFromTail("STARTING business output\nEXIT_CODE:0")).toBe(0)
  })

  test("matches the exact screen session under a stable locale", () => {
    const script = inspectRemoteTaskScript({
      logPath: "/tmp/task.log",
      screenName: "openresearch-abc",
      exitPath: "/tmp/exit-openresearch-abc",
      pendingPath: "/tmp/exit-openresearch-abc.pending",
    })

    expect(script).toContain("LC_ALL=C screen -ls")
    expect(script).toContain("if (value == name) { print; exit }")
    expect(script).not.toContain("grep -F")
    expect(script).toContain("printf 'pending'")
  })

  test("classifies GNU screen listing formats", () => {
    expect(
      screenState(
        "2889695.openresearch-1786669842936-8ab0e2 (08/14/2026 09:10:33 AM) (Detached)",
      ),
    ).toBe("detached")
    expect(screenState("123.openresearch-test (Multi, detached)")).toBe("detached")
    expect(screenState("123.openresearch-test (Multi, attached)")).toBe("attached")
    expect(screenState("123.openresearch-test (Dead ???)")).toBe("dead")
    expect(screenState("123.openresearch-test (Removed)")).toBe("dead")
    expect(screenState("123.openresearch-test (Remote or dead)")).toBe("unknown")
    expect(screenState("123.openresearch-test (Private)")).toBe("unknown")
    expect(screenState("123.openresearch-test (Future state)")).toBe("running")
    expect(screenState("stopped")).toBe("stopped")
  })

  test("selects an exact screen name from the remote listing", async () => {
    await using tmp = await tmpdir()
    const screen = path.join(tmp.path, "screen")
    await Bun.write(
      screen,
      [
        "#!/bin/sh",
        "printf '%s\\n' 'There are screens on:'",
        "printf '%s\\n' '123.openresearch-test-extra (08/14/2026 09:10:33 AM) (Attached)'",
        "printf '%s\\n' '124.openresearch-test (08/14/2026 09:10:33 AM) (Detached)'",
      ].join("\n"),
    )
    await chmod(screen, 0o755)
    const script = inspectRemoteTaskScript({
      logPath: path.join(tmp.path, "task.log"),
      screenName: "openresearch-test",
    })
    const proc = Bun.spawn(["bash", "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${tmp.path}:${process.env.PATH}` },
    })
    const meta = parseInspectOutput(await new Response(proc.stdout).text())

    expect(await proc.exited).toBe(0)
    expect(meta.screen).toBe("detached")
    expect(meta.screenLine).toContain("124.openresearch-test ")
    expect(meta.screenLine).not.toContain("openresearch-test-extra")
  })

  test("generates short unique screen session names", () => {
    const a = session("exp-1")
    const b = session("exp-1")
    expect(a.length).toBeLessThanOrEqual(64)
    expect(b.length).toBeLessThanOrEqual(64)
    expect(a.startsWith("openresearch-")).toBeTrue()
    expect(b.startsWith("openresearch-")).toBeTrue()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^openresearch-\d{13}-[a-f0-9]{6}$/)
    expect(b).toMatch(/^openresearch-\d{13}-[a-f0-9]{6}$/)
  })
})
