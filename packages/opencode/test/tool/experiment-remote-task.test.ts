import { describe, expect, test } from "bun:test"
import { buildRemoteTaskTerminalPart } from "../../src/collab/return-parts"
import { assertRawRemoteCommand } from "../../src/tool/experiment-remote-task"

describe("tool.experiment-remote-task", () => {
  test("accepts raw business command", () => {
    const cmd = assertRawRemoteCommand(
      "/root/miniconda3/bin/conda run -n openresearch_hubdl --no-capture-output modelscope download --dataset OpenDataLab/CUB-200-2011 --local_dir /mnt/zhouzih/CUB-200-2011",
    )
    expect(cmd).toContain("modelscope download")
  })

  test("preserves multiline scripts with business heredocs and tee", () => {
    const cmd = "  set -euo pipefail\ncat <<'DATA' | tee result.txt\nvalue\nDATA\n  "

    expect(assertRawRemoteCommand(cmd)).toBe(cmd)
  })

  test("rejects wrapped command", () => {
    expect(() =>
      assertRawRemoteCommand(
        "mkdir -p /mnt/zhouzih && screen -dmS cub_download bash -lc 'echo START $(date) >> /mnt/zhouzih/cub_download.log'",
      ),
    ).toThrow("unwrapped remote business command or multiline shell script")
  })

  test("includes the originating server ID in terminal callbacks", () => {
    const part = buildRemoteTaskTerminalPart({
      taskId: "task-1",
      expId: "exp-1",
      remoteServerId: "server-1",
      kind: "experiment_run",
      title: "Train model",
      status: "finished",
      logPath: "/tmp/task.log",
      errorMessage: null,
    })

    expect(part.body).toContain("Remote Server ID: server-1")
    expect(part.payload).toMatchObject({ remoteServerId: "server-1" })
  })
})
