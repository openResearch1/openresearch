import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { Instance } from "../../src/project/instance"
import { Database, eq } from "../../src/storage/db"
import {
  ExperimentExecutionWatchTable,
  ExperimentTable,
  RemoteTaskTable,
  RemoteServerTable,
  ResearchProjectTable,
} from "../../src/research/research.sql"
import { ProjectTable } from "../../src/project/project.sql"

const startRemoteTaskMock = mock(async (input: { taskId: string; remoteRoot: string; server?: unknown }) => ({
  ok: true,
  output: "",
  code: 0,
  logPath: `${input.remoteRoot}/.openresearch/tasks/${input.taskId}/task.log`,
}))

const inspectRemoteTaskMock = mock(async () => ({
  ok: true,
  output: "__SCREEN__\nrunning\n__TARGET__\nmissing\n__TAIL__\nSTART",
  code: 0,
}))

mock.module("../../src/research/remote-task-runner", () => ({
  session: (taskId: string) => `openresearch${taskId.slice(0, 8)}`,
  startRemoteTask: startRemoteTaskMock,
  inspectRemoteTask: inspectRemoteTaskMock,
  readRemoteTaskLog: mock(async () => ({ ok: true, output: "", code: 0 })),
  parseInspectOutput(output: string) {
    const screenAt = output.lastIndexOf("__SCREEN__\n")
    const targetAt = output.lastIndexOf("\n__TARGET__\n")
    const tailAt = output.lastIndexOf("\n__TAIL__\n")
    if (screenAt === -1 || targetAt === -1 || tailAt === -1 || screenAt > targetAt || targetAt > tailAt) {
      return {
        screen: "",
        target: "",
        tail: output.trim(),
      }
    }
    return {
      screen: output.slice(screenAt + "__SCREEN__\n".length, targetAt).trim(),
      target: output.slice(targetAt + "\n__TARGET__\n".length, tailAt).trim(),
      tail: output.slice(tailAt + "\n__TAIL__\n".length).trim(),
    }
  },
  exitCodeFromTail(tail: string) {
    const match = /EXIT_CODE:(\d+)/.exec(tail)
    if (!match) return
    return Number(match[1])
  },
}))

const ctx = {
  sessionID: "test-session",
  messageID: "test-message",
  callID: "test-call",
  agent: "experiment_remote_download",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

async function seed(dir: string) {
  const now = Date.now()
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({
        id: "proj-1",
        worktree: dir,
        vcs: "git",
        name: "proj",
        icon_url: null,
        icon_color: null,
        time_initialized: now,
        sandboxes: [],
        commands: null,
      })
      .run(),
  )
  Database.use((db) =>
    db
      .insert(ResearchProjectTable)
      .values({
        research_project_id: "rp-1",
        project_id: "proj-1",
        background_path: null,
        goal_path: null,
        macro_table_path: null,
      })
      .run(),
  )
  Database.use((db) =>
    db
      .insert(RemoteServerTable)
      .values({
        id: "server-1",
        config: JSON.stringify({ mode: "direct", address: "10.0.0.1", port: 22, user: "zhouzih", password: "secret" }),
      })
      .run(),
  )
  Database.use((db) =>
    db
      .insert(ExperimentTable)
      .values({
        exp_id: "exp-1",
        research_project_id: "rp-1",
        exp_name: "exp",
        exp_session_id: null,
        baseline_branch_name: null,
        exp_branch_name: null,
        exp_result_path: null,
        atom_id: null,
        exp_result_summary_path: null,
        exp_plan_path: null,
        remote_server_id: "server-1",
        code_path: dir,
        status: "pending",
        started_at: null,
        finished_at: null,
      })
      .run(),
  )
}

describe("tool.experiment-remote-task lifecycle", () => {
  beforeEach(async () => {
    startRemoteTaskMock.mockClear()
    inspectRemoteTaskMock.mockClear()
    inspectRemoteTaskMock.mockImplementation(async () => ({
      ok: true,
      output: "__SCREEN__\nrunning\n__TARGET__\nmissing\n__TAIL__\nSTART",
      code: 0,
    }))
    await resetDatabase()
  })

  afterEach(async () => {
    await resetDatabase()
  })

  test("starts a remote task and refreshes it to finished", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        const { ExperimentRemoteTaskStartTool } = await import("../../src/tool/experiment-remote-task")
        const { forceRefreshRemoteTask } = await import("../../src/research/experiment-remote-task-watcher")

        const tool = await ExperimentRemoteTaskStartTool.init()
        const result = await tool.execute(
          {
            expId: "exp-1",
            kind: "resource_download",
            title: "CUB download",
            remoteRoot: "/mnt/zhouzih",
            command:
              "/mnt/zhouzih/miniconda3/bin/conda run --no-capture-output -n openresearch_hubdl modelscope download --dataset OpenDataLab/CUB-200-2011 --local_dir /mnt/zhouzih/pico_resources/cub200/source",
            resourceKey: "cub200",
            targetPath: "/mnt/zhouzih/pico_resources/cub200/source",
            sourceSelection: "modelscope",
            method: "modelscope download",
          },
          ctx,
        )

        expect(startRemoteTaskMock).toHaveBeenCalledTimes(1)
        expect(startRemoteTaskMock.mock.calls[0]?.[0]?.server).toEqual({
          mode: "direct",
          address: "10.0.0.1",
          port: 22,
          user: "zhouzih",
          password: "secret",
          network: {
            mode: "direct",
          },
        })
        expect(result.output).toContain("Screen: openresearch")

        const task = Database.use((db) =>
          db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, "exp-1")).get(),
        )
        expect(task?.status).toBe("running")
        expect(task?.target_path).toBe("/mnt/zhouzih/pico_resources/cub200/source")
        expect(task?.log_path).toContain("/mnt/zhouzih/.openresearch/tasks/")

        const watch = Database.use((db) =>
          db
            .select()
            .from(ExperimentExecutionWatchTable)
            .where(eq(ExperimentExecutionWatchTable.exp_id, "exp-1"))
            .get(),
        )
        expect(watch?.stage).toBe("planning")
        expect(watch?.status).toBe("pending")

        inspectRemoteTaskMock.mockImplementation(async () => ({
          ok: true,
          output: "__SCREEN__\nstopped\n__TARGET__\npresent\n__TAIL__\nSTART\nEXIT_CODE:0",
          code: 0,
        }))

        const refresh = await forceRefreshRemoteTask("exp-1")
        expect(refresh.success).toBeTrue()
        expect(inspectRemoteTaskMock).toHaveBeenCalledTimes(1)

        const updated = Database.use((db) =>
          db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, "exp-1")).get(),
        )
        expect(updated?.status).toBe("finished")

        const synced = Database.use((db) =>
          db
            .select()
            .from(ExperimentExecutionWatchTable)
            .where(eq(ExperimentExecutionWatchTable.exp_id, "exp-1"))
            .get(),
        )
        expect(synced?.stage).toBe("planning")
        expect(synced?.status).toBe("pending")
      },
    })
  })

  test("keeps a stopped remote task running during the exit-code grace window", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        const { ExperimentRemoteTaskStartTool } = await import("../../src/tool/experiment-remote-task")
        const { forceRefreshRemoteTask } = await import("../../src/research/experiment-remote-task-watcher")

        const tool = await ExperimentRemoteTaskStartTool.init()
        await tool.execute(
          {
            expId: "exp-1",
            kind: "resource_download",
            title: "CUB download",
            remoteRoot: "/mnt/zhouzih",
            command:
              "/mnt/zhouzih/miniconda3/bin/conda run --no-capture-output -n openresearch_hubdl modelscope download --dataset OpenDataLab/CUB-200-2011 --local_dir /mnt/zhouzih/pico_resources/cub200/source",
            resourceKey: "cub200",
            targetPath: "/mnt/zhouzih/pico_resources/cub200/source",
            sourceSelection: "modelscope",
            method: "modelscope download",
          },
          ctx,
        )

        inspectRemoteTaskMock.mockImplementation(async () => ({
          ok: true,
          output: "__SCREEN__\nstopped\n__TARGET__\nmissing\n__TAIL__\nSTART",
          code: 0,
        }))

        const refresh = await forceRefreshRemoteTask("exp-1")
        expect(refresh.success).toBeTrue()

        const task = Database.use((db) =>
          db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, "exp-1")).get(),
        )
        expect(task?.status).toBe("running")
        expect(task?.error_message).toBeNull()
        expect(typeof task?.stopped_at).toBe("number")

        const watch = Database.use((db) =>
          db
            .select()
            .from(ExperimentExecutionWatchTable)
            .where(eq(ExperimentExecutionWatchTable.exp_id, "exp-1"))
            .get(),
        )
        expect(watch?.status).toBe("pending")
        expect(watch?.stage).toBe("planning")
      },
    })
  })

  test("keeps a detached remote task running", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        const { ExperimentRemoteTaskStartTool } = await import("../../src/tool/experiment-remote-task")
        const { forceRefreshRemoteTask } = await import("../../src/research/experiment-remote-task-watcher")

        const tool = await ExperimentRemoteTaskStartTool.init()
        await tool.execute(
          {
            expId: "exp-1",
            kind: "resource_download",
            title: "CUB download",
            remoteRoot: "/mnt/zhouzih",
            command:
              "/mnt/zhouzih/miniconda3/bin/conda run --no-capture-output -n openresearch_hubdl modelscope download --dataset OpenDataLab/CUB-200-2011 --local_dir /mnt/zhouzih/pico_resources/cub200/source",
            resourceKey: "cub200",
            targetPath: "/mnt/zhouzih/pico_resources/cub200/source",
            sourceSelection: "modelscope",
            method: "modelscope download",
          },
          ctx,
        )

        inspectRemoteTaskMock.mockImplementation(async () => ({
          ok: true,
          output: "__SCREEN__\ndetached\n__TARGET__\nmissing\n__TAIL__\nSTART",
          code: 0,
        }))

        const refresh = await forceRefreshRemoteTask("exp-1")
        expect(refresh.success).toBeTrue()

        const task = Database.use((db) =>
          db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, "exp-1")).get(),
        )
        expect(task?.status).toBe("running")
        expect(task?.error_message).toBeNull()
        expect(task?.stopped_at).toBeNull()
      },
    })
  })

  test("parses a realistic detached screen listing", async () => {
    await Instance.provide({
      directory: "/tmp",
      fn: async () => {
        const { parseInspectOutput } = await import("../../src/research/remote-task-runner")
        const meta = parseInspectOutput(
          "__SCREEN__\ndetached\n__TARGET__\nmissing\n__TAIL__\nThere is a screen on:\n\t1234.opencode-abc\t(Detached)",
        )
        expect(meta.screen).toBe("detached")
      },
    })
  })

  test("parses inspect output with login banner before markers", async () => {
    await Instance.provide({
      directory: "/tmp",
      fn: async () => {
        const { parseInspectOutput } = await import("../../src/research/remote-task-runner")
        const meta = parseInspectOutput(
          [
            "Welcome to Ubuntu 24.04.3 LTS (GNU/Linux 6.17.0-20-generic x86_64)",
            "Documentation: https://help.ubuntu.com",
            "__SCREEN__",
            "detached",
            "__TARGET__",
            "unknown",
            "__TAIL__",
            "START Fri Apr 17 10:41:39 AM CST 2026",
          ].join("\n"),
        )
        expect(meta.screen).toBe("detached")
        expect(meta.target).toBe("unknown")
        expect(meta.tail).toContain("START Fri Apr 17 10:41:39 AM CST 2026")
      },
    })
  })

  test("fails a stopped remote task after the grace window", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        const { ExperimentRemoteTaskStartTool } = await import("../../src/tool/experiment-remote-task")
        const { forceRefreshRemoteTask } = await import("../../src/research/experiment-remote-task-watcher")

        const tool = await ExperimentRemoteTaskStartTool.init()
        await tool.execute(
          {
            expId: "exp-1",
            kind: "resource_download",
            title: "CUB download",
            remoteRoot: "/mnt/zhouzih",
            command:
              "/mnt/zhouzih/miniconda3/bin/conda run --no-capture-output -n openresearch_hubdl modelscope download --dataset OpenDataLab/CUB-200-2011 --local_dir /mnt/zhouzih/pico_resources/cub200/source",
            resourceKey: "cub200",
            targetPath: "/mnt/zhouzih/pico_resources/cub200/source",
            sourceSelection: "modelscope",
            method: "modelscope download",
          },
          ctx,
        )

        inspectRemoteTaskMock.mockImplementation(async () => ({
          ok: true,
          output: "__SCREEN__\nstopped\n__TARGET__\nmissing\n__TAIL__\nSTART",
          code: 0,
        }))

        await forceRefreshRemoteTask("exp-1")

        Database.use((db) =>
          db
            .update(RemoteTaskTable)
            .set({ stopped_at: Date.now() - 11_000 })
            .where(eq(RemoteTaskTable.exp_id, "exp-1"))
            .run(),
        )

        const refresh = await forceRefreshRemoteTask("exp-1")
        expect(refresh.success).toBeTrue()

        const task = Database.use((db) =>
          db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, "exp-1")).get(),
        )
        expect(task?.status).toBe("failed")
        expect(task?.error_message).toBe("remote task stopped before writing completion marker")

        const watch = Database.use((db) =>
          db
            .select()
            .from(ExperimentExecutionWatchTable)
            .where(eq(ExperimentExecutionWatchTable.exp_id, "exp-1"))
            .get(),
        )
        expect(watch?.status).toBe("pending")
        expect(watch?.message).toBeNull()
        expect(watch?.error_message).toBeNull()

        const { ExperimentRemoteTask } = await import("../../src/research/experiment-remote-task")
        expect(ExperimentRemoteTask.current("exp-1")?.error_message).toBe(
          "remote task stopped before writing completion marker",
        )

        Database.use((db) =>
          db
            .update(ResearchProjectTable)
            .set({ project_id: Instance.project.id })
            .where(eq(ResearchProjectTable.research_project_id, "rp-1"))
            .run(),
        )

        const { ResearchRoutes } = await import("../../src/server/routes/research")
        const response = await ResearchRoutes.request("/experiment-watch")
        expect(response.status).toBe(200)
        const list = (await response.json()) as Array<{
          error_message: string | null
          remote_task_error_message: string | null
        }>
        expect(list[0]?.error_message).toBeNull()
        expect(list[0]?.remote_task_error_message).toBe("remote task stopped before writing completion marker")
      },
    })
  })
})
