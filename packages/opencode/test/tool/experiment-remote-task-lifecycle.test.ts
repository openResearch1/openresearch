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
import { RemoteTaskListenerTable } from "../../src/research/remote-task-listener.sql"

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
  control: (root: string, taskId: string, screenName: string) => {
    const dir = `${root.replace(/\/$/, "")}/.openresearch/tasks/${taskId}`
    return {
      dir,
      logPath: `${dir}/task.log`,
      exitPath: `${dir}/exit-${screenName}`,
      pendingPath: `${dir}/exit-${screenName}.pending`,
    }
  },
  session: (taskId: string) => `openresearch${taskId.slice(0, 8)}`,
  wrapRemoteScript: (_server: unknown, script: string) => script,
  startRemoteTask: startRemoteTaskMock,
  inspectRemoteTask: inspectRemoteTaskMock,
  readRemoteTaskLog: mock(async () => ({ ok: true, output: "", code: 0 })),
  parseInspectOutput(output: string) {
    const screenAt = output.indexOf("__SCREEN__\n")
    const targetAt = output.indexOf("\n__TARGET__\n", screenAt)
    const exitAt = output.indexOf("\n__EXIT__\n", targetAt)
    const tailAt = output.indexOf("\n__TAIL__\n", targetAt)
    if (screenAt === -1 || targetAt === -1 || tailAt === -1 || screenAt > targetAt || targetAt > tailAt) {
      return {
        screen: "",
        screenLine: "",
        target: "",
        code: undefined,
        managed: false,
        tail: output.trim(),
      }
    }
    const status =
      exitAt === -1 || exitAt > tailAt ? "legacy" : output.slice(exitAt + "\n__EXIT__\n".length, tailAt).trim()
    const line = output.slice(screenAt + "__SCREEN__\n".length, targetAt).trim()
    return {
      screen: line,
      screenLine: line,
      target: output
        .slice(targetAt + "\n__TARGET__\n".length, exitAt === -1 || exitAt > tailAt ? tailAt : exitAt)
        .trim(),
      code: /^\d+$/.test(status) ? Number(status) : undefined,
      managed: status !== "legacy",
      tail: output.slice(tailAt + "\n__TAIL__\n".length).trim(),
    }
  },
  exitCodeFromTail(tail: string) {
    const lines = tail.split("\n")
    const start = lines.findLastIndex((line) => line.trimStart().startsWith("START"))
    const text = (start === -1 ? lines : lines.slice(start)).join("\n")
    const match = [...text.matchAll(/EXIT_CODE:(\d+)/g)].at(-1)
    if (!match) return
    return Number(match[1])
  },
}))

const ctx = {
  sessionID: "test-session",
  messageID: "test-message",
  callID: "test-call",
  agent: "experiment_resource_prepare",
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
    startRemoteTaskMock.mockImplementation(async (input) => ({
      ok: true,
      output: "",
      code: 0,
      logPath: `${input.remoteRoot}/.openresearch/tasks/${input.taskId}/task.log`,
    }))
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

  test("keeps a task pending while remote startup is in flight", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        const gate = Promise.withResolvers<{
          ok: boolean
          output: string
          code: number
          logPath: string
        }>()
        startRemoteTaskMock.mockImplementation(() => gate.promise)
        const { ExperimentRemoteTaskGetTool, ExperimentRemoteTaskListTool, ExperimentRemoteTaskStartTool } =
          await import("../../src/tool/experiment-remote-task")
        const { ExperimentRemoteTask } = await import("../../src/research/experiment-remote-task")
        const start = await ExperimentRemoteTaskStartTool.init()
        const run = start.execute(
          {
            expId: "exp-1",
            kind: "experiment_run",
            title: "Train model",
            remoteRoot: "/mnt/zhouzih",
            command: "python train.py",
          },
          ctx,
        )
        const task = ExperimentRemoteTask.current("exp-1")!

        const get = await ExperimentRemoteTaskGetTool.init()
        const result = await get.execute({ expId: "exp-1", taskId: task.task_id }, ctx)
        expect(result.metadata.status).toBe("pending")
        expect(result.metadata.screen).toBe("starting")
        expect(ExperimentRemoteTask.get(task.task_id)?.error_message).toBeNull()

        const list = await ExperimentRemoteTaskListTool.init()
        const active = await list.execute({ expId: "exp-1" }, ctx)
        expect(active.metadata.tasks).toHaveLength(1)
        expect(active.metadata.tasks[0]?.status).toBe("pending")
        expect(inspectRemoteTaskMock).not.toHaveBeenCalled()

        const logPath = `/mnt/zhouzih/.openresearch/tasks/${task.task_id}/task.log`
        gate.resolve({ ok: true, output: "", code: 0, logPath })
        await run

        expect(ExperimentRemoteTask.get(task.task_id)?.status).toBe("running")
        expect(ExperimentRemoteTask.get(task.task_id)?.log_path).toBe(logPath)
      },
    })
  })

  test("records a thrown remote startup error immediately", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        startRemoteTaskMock.mockImplementation(async () => {
          throw new Error("ssh unavailable")
        })
        const { ExperimentRemoteTaskStartTool } = await import("../../src/tool/experiment-remote-task")
        const { ExperimentRemoteTask } = await import("../../src/research/experiment-remote-task")
        const start = await ExperimentRemoteTaskStartTool.init()

        await expect(
          start.execute(
            {
              expId: "exp-1",
              kind: "experiment_run",
              title: "Train model",
              remoteRoot: "/mnt/zhouzih",
              command: "python train.py",
            },
            ctx,
          ),
        ).rejects.toThrow("ssh unavailable")

        expect(ExperimentRemoteTask.current("exp-1")?.status).toBe("failed")
        expect(ExperimentRemoteTask.current("exp-1")?.error_message).toBe("ssh unavailable")
      },
    })
  })

  test("fails a stale pending task after the startup grace window", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        const { ExperimentRemoteTask } = await import("../../src/research/experiment-remote-task")
        const { forceRefreshRemoteTask } = await import("../../src/research/experiment-remote-task-watcher")
        const task = ExperimentRemoteTask.create({
          expId: "exp-1",
          kind: "experiment_run",
          title: "Train model",
          server: JSON.stringify({ mode: "direct", address: "10.0.0.1", port: 22, user: "zhouzih" }),
          remoteRoot: "/mnt/zhouzih",
          screenName: "openresearch-stale",
          command: "python train.py",
        })
        Database.use((db) =>
          db
            .update(RemoteTaskTable)
            .set({ time_created: Date.now() - 4 * 60 * 1000 })
            .where(eq(RemoteTaskTable.task_id, task.task_id))
            .run(),
        )

        await forceRefreshRemoteTask("exp-1")

        expect(ExperimentRemoteTask.get(task.task_id)?.status).toBe("failed")
        expect(ExperimentRemoteTask.get(task.task_id)?.error_message).toBe("remote task log path missing")
      },
    })
  })

  test("fails resource download when target exists but exit code is non-zero", async () => {
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
          output: "__SCREEN__\nstopped\n__TARGET__\npresent\n__TAIL__\nSTART\nInterrupted\nEXIT_CODE:130",
          code: 0,
        }))

        const refresh = await forceRefreshRemoteTask("exp-1")
        expect(refresh.success).toBeTrue()

        const task = Database.use((db) =>
          db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, "exp-1")).get(),
        )
        expect(task?.status).toBe("failed")
        expect(task?.error_message).toContain("EXIT_CODE:130")
      },
    })
  })

  test("uses managed exit status instead of screen state or log markers", async () => {
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
            kind: "experiment_run",
            title: "Train model",
            remoteRoot: "/mnt/zhouzih",
            command: "python train.py",
          },
          ctx,
        )

        inspectRemoteTaskMock.mockImplementation(async () => ({
          ok: true,
          output: "__SCREEN__\ndetached\n__TARGET__\nunknown\n__EXIT__\n7\n__TAIL__\nSTART\nEXIT_CODE:0",
          code: 0,
        }))

        await forceRefreshRemoteTask("exp-1")
        const task = Database.use((db) =>
          db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, "exp-1")).get(),
        )
        expect(task?.status).toBe("failed")
        expect(task?.error_message).toContain("EXIT_CODE:0")
      },
    })
  })

  test("does not reuse shared log exit markers while managed status is pending", async () => {
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
            kind: "experiment_run",
            title: "Train model",
            remoteRoot: "/mnt/zhouzih",
            command: "python train.py",
          },
          ctx,
        )

        inspectRemoteTaskMock.mockImplementation(async () => ({
          ok: true,
          output: "__SCREEN__\ndetached\n__TARGET__\nunknown\n__EXIT__\npending\n__TAIL__\nSTART old\nEXIT_CODE:0",
          code: 0,
        }))

        await forceRefreshRemoteTask("exp-1")
        const task = Database.use((db) =>
          db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, "exp-1")).get(),
        )
        expect(task?.status).toBe("running")
        expect(task?.error_message).toBeNull()
      },
    })
  })

  test("shows starting while the managed screen is registering", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        const { ExperimentRemoteTaskGetTool, ExperimentRemoteTaskStartTool } = await import(
          "../../src/tool/experiment-remote-task"
        )
        const start = await ExperimentRemoteTaskStartTool.init()
        const started = await start.execute(
          {
            expId: "exp-1",
            kind: "experiment_run",
            title: "Train model",
            remoteRoot: "/mnt/zhouzih",
            command: "python train.py",
          },
          ctx,
        )
        inspectRemoteTaskMock.mockImplementation(async () => ({
          ok: true,
          output: "__SCREEN__\nstopped\n__TARGET__\nunknown\n__EXIT__\npending\n__TAIL__\nSTART",
          code: 0,
        }))

        const get = await ExperimentRemoteTaskGetTool.init()
        const result = await get.execute({ expId: "exp-1", taskId: started.metadata.taskId }, ctx)

        expect(inspectRemoteTaskMock).toHaveBeenCalledTimes(1)
        expect(result.metadata.screen).toBe("starting")
        expect(result.output).toContain("Screen: starting")
      },
    })
  })

  test("reports inspection failures instead of unknown screen state", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        const { ExperimentRemoteTaskGetTool, ExperimentRemoteTaskStartTool } = await import(
          "../../src/tool/experiment-remote-task"
        )
        const start = await ExperimentRemoteTaskStartTool.init()
        const started = await start.execute(
          {
            expId: "exp-1",
            kind: "experiment_run",
            title: "Train model",
            remoteRoot: "/mnt/zhouzih",
            command: "python train.py",
          },
          ctx,
        )
        inspectRemoteTaskMock.mockImplementation(async () => ({
          ok: false,
          output: "ssh unavailable",
          code: 255,
        }))

        const get = await ExperimentRemoteTaskGetTool.init()
        const result = await get.execute({ expId: "exp-1", taskId: started.metadata.taskId }, ctx)

        expect(inspectRemoteTaskMock).toHaveBeenCalledTimes(1)
        expect(result.metadata.screen).toBe("inspect_failed")
        expect(result.metadata.screenInspectError).toBe("ssh unavailable")
        expect(result.output).toContain("remote task inspect failed: ssh unavailable")
      },
    })
  })

  test("applies the stop grace window to ambiguous screen states", async () => {
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
            kind: "experiment_run",
            title: "Train model",
            remoteRoot: "/mnt/zhouzih",
            command: "python train.py",
          },
          ctx,
        )
        inspectRemoteTaskMock.mockImplementation(async () => ({
          ok: true,
          output: "__SCREEN__\nunknown\n__TARGET__\nunknown\n__EXIT__\npending\n__TAIL__\nSTART",
          code: 0,
        }))

        await forceRefreshRemoteTask("exp-1")
        const task = Database.use((db) =>
          db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, "exp-1")).get(),
        )
        expect(task?.status).toBe("running")
        expect(typeof task?.stopped_at).toBe("number")
      },
    })
  })

  test("does not reuse old successful exit code for new resource download attempt", async () => {
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
          output: "__SCREEN__\nstopped\n__TARGET__\npresent\n__TAIL__\nSTART old\nEXIT_CODE:0\nSTART new",
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
      },
    })
  })

  test("syncs project runtime env setup into execution watch", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        Database.use((db) =>
          db
            .update(ExperimentTable)
            .set({
              kind: "project_runtime",
              runtime_key: "project:rp-1:server:server-1",
            })
            .where(eq(ExperimentTable.exp_id, "exp-1"))
            .run(),
        )

        const { ExperimentRemoteTaskStartTool } = await import("../../src/tool/experiment-remote-task")
        const { forceRefreshRemoteTask } = await import("../../src/research/experiment-remote-task-watcher")
        const tool = await ExperimentRemoteTaskStartTool.init()
        await tool.execute(
          {
            expId: "exp-1",
            kind: "env_setup",
            title: "Python env setup",
            remoteRoot: "/mnt/zhouzih",
            command: "/mnt/zhouzih/miniconda3/bin/conda env update -n openresearch -f environment.yml",
            targetPath: "/mnt/zhouzih/miniconda3/envs/openresearch",
          },
          ctx,
        )

        const running = Database.use((db) =>
          db
            .select()
            .from(ExperimentExecutionWatchTable)
            .where(eq(ExperimentExecutionWatchTable.exp_id, "exp-1"))
            .get(),
        )
        expect(running?.status).toBe("running")
        expect(running?.stage).toBe("setting_up_env")
        expect(running?.message).toBe("Python env setup")
        expect(running?.error_message).toBeNull()
        expect(running?.finished_at).toBeNull()

        inspectRemoteTaskMock.mockImplementation(async () => ({
          ok: true,
          output: "__SCREEN__\nstopped\n__TARGET__\npresent\n__TAIL__\nSTART\nEXIT_CODE:0",
          code: 0,
        }))

        await forceRefreshRemoteTask("exp-1")

        const finished = Database.use((db) =>
          db
            .select()
            .from(ExperimentExecutionWatchTable)
            .where(eq(ExperimentExecutionWatchTable.exp_id, "exp-1"))
            .get(),
        )
        expect(finished?.status).toBe("finished")
        expect(finished?.stage).toBe("setting_up_env")
        expect(finished?.message).toBe("Python env setup finished")
        expect(typeof finished?.finished_at).toBe("number")

        inspectRemoteTaskMock.mockImplementation(async () => ({
          ok: true,
          output: "__SCREEN__\nstopped\n__TARGET__\nmissing\n__TAIL__\nTraceback\nEXIT_CODE:2",
          code: 0,
        }))

        await forceRefreshRemoteTask("exp-1")

        const failed = Database.use((db) =>
          db
            .select()
            .from(ExperimentExecutionWatchTable)
            .where(eq(ExperimentExecutionWatchTable.exp_id, "exp-1"))
            .get(),
        )
        expect(failed?.status).toBe("failed")
        expect(failed?.stage).toBe("setting_up_env")
        expect(failed?.message).toBe("Traceback\nEXIT_CODE:2")
        expect(failed?.error_message).toBe("Traceback\nEXIT_CODE:2")
      },
    })
  })

  test("aggregates multiple project runtime tasks into one watch", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        Database.use((db) =>
          db
            .update(ExperimentTable)
            .set({
              kind: "project_runtime",
              runtime_key: "project:rp-1:server:server-1",
            })
            .where(eq(ExperimentTable.exp_id, "exp-1"))
            .run(),
        )

        const { ExperimentRemoteTaskStartTool } = await import("../../src/tool/experiment-remote-task")
        const tool = await ExperimentRemoteTaskStartTool.init()
        await tool.execute(
          {
            expId: "exp-1",
            kind: "resource_download",
            title: "CUB download",
            remoteRoot: "/mnt/zhouzih",
            command: "python prepare_cub.py",
            resourceKey: "cub200",
            targetPath: "/mnt/zhouzih/resources/cub200",
          },
          ctx,
        )
        await tool.execute(
          {
            expId: "exp-1",
            kind: "resource_download",
            title: "ImageNet download",
            remoteRoot: "/mnt/zhouzih",
            command: "python prepare_imagenet.py",
            resourceKey: "imagenet",
            targetPath: "/mnt/zhouzih/resources/imagenet",
          },
          ctx,
        )

        const tasks = Database.use((db) =>
          db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, "exp-1")).all(),
        )
        expect(tasks).toHaveLength(2)

        const watch = Database.use((db) =>
          db
            .select()
            .from(ExperimentExecutionWatchTable)
            .where(eq(ExperimentExecutionWatchTable.exp_id, "exp-1"))
            .get(),
        )
        expect(watch?.status).toBe("running")
        expect(watch?.stage).toBe("remote_downloading")
        expect(watch?.message).toBe("2 remote tasks running")
        expect(watch?.finished_at).toBeNull()
      },
    })
  })

  test("lists active tasks and gets a specific task by task id", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        const { ExperimentRemoteTaskGetTool, ExperimentRemoteTaskListTool, ExperimentRemoteTaskStartTool } =
          await import("../../src/tool/experiment-remote-task")
        const start = await ExperimentRemoteTaskStartTool.init()
        const cub = await start.execute(
          {
            expId: "exp-1",
            kind: "resource_download",
            title: "CUB download",
            remoteRoot: "/mnt/zhouzih",
            command: "python prepare_cub.py",
            resourceKey: "cub200",
            targetPath: "/mnt/zhouzih/resources/cub200",
          },
          ctx,
        )
        const imagenet = await start.execute(
          {
            expId: "exp-1",
            kind: "resource_download",
            title: "ImageNet download",
            remoteRoot: "/mnt/zhouzih",
            command: "python prepare_imagenet.py",
            resourceKey: "imagenet",
            targetPath: "/mnt/zhouzih/resources/imagenet",
          },
          ctx,
        )

        const list = await ExperimentRemoteTaskListTool.init()
        const active = await list.execute({ expId: "exp-1" }, ctx)
        expect(active.metadata.tasks).toHaveLength(2)
        expect(active.metadata.tasks.map((task) => task.taskId)).toContain(cub.metadata.taskId)
        expect(active.metadata.tasks.map((task) => task.taskId)).toContain(imagenet.metadata.taskId)

        const get = await ExperimentRemoteTaskGetTool.init()
        const result = await get.execute({ expId: "exp-1", taskId: cub.metadata.taskId, waitForTerminal: false }, ctx)
        expect(result.metadata.taskId).toBe(cub.metadata.taskId)
        expect(result.metadata.title).toBe("CUB download")
        expect(result.output).toContain("Task ID: " + cub.metadata.taskId)

        await expect(
          get.execute({ expId: "exp-2", taskId: cub.metadata.taskId, waitForTerminal: false }, ctx),
        ).rejects.toThrow("remote task does not belong to experiment")
      },
    })
  })

  test("does not regress a finished task when remote inspection is unavailable", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        const { ExperimentRemoteTaskGetTool, ExperimentRemoteTaskListTool, ExperimentRemoteTaskStartTool } =
          await import("../../src/tool/experiment-remote-task")
        const { ExperimentRemoteTask } = await import("../../src/research/experiment-remote-task")
        const { forceRefreshRemoteTask } = await import("../../src/research/experiment-remote-task-watcher")
        const start = await ExperimentRemoteTaskStartTool.init()
        const started = await start.execute(
          {
            expId: "exp-1",
            kind: "experiment_run",
            title: "Train model",
            remoteRoot: "/mnt/zhouzih",
            command: "python train.py",
          },
          ctx,
        )

        inspectRemoteTaskMock.mockImplementation(async () => ({
          ok: true,
          output: "__SCREEN__\nstopped\n__TARGET__\nunknown\n__EXIT__\n0\n__TAIL__\nSTART\nEXIT_CODE:0",
          code: 0,
        }))
        await forceRefreshRemoteTask("exp-1")
        expect(ExperimentRemoteTask.get(started.metadata.taskId)?.status).toBe("finished")

        inspectRemoteTaskMock.mockClear()
        inspectRemoteTaskMock.mockImplementation(async () => ({
          ok: false,
          output: "ssh unavailable",
          code: 255,
        }))
        const get = await ExperimentRemoteTaskGetTool.init()
        const result = await get.execute({ expId: "exp-1", taskId: started.metadata.taskId }, ctx)

        expect(inspectRemoteTaskMock).toHaveBeenCalledTimes(1)
        expect(result.metadata.status).toBe("finished")
        expect(result.metadata.terminal).toBe(true)
        expect(result.metadata.screen).toBe("inspect_failed")
        expect(result.output).toContain("Status: finished")
        expect(result.output).toContain("Screen inspect error: ssh unavailable")
        expect(ExperimentRemoteTask.get(started.metadata.taskId)?.status).toBe("finished")
        expect(ExperimentRemoteTask.get(started.metadata.taskId)?.error_message).toBeNull()

        inspectRemoteTaskMock.mockClear()
        const list = await ExperimentRemoteTaskListTool.init()
        const active = await list.execute({ expId: "exp-1" }, ctx)

        expect(inspectRemoteTaskMock).not.toHaveBeenCalled()
        expect(active.metadata.tasks).toHaveLength(0)
        expect(active.output).toBe("No active remote tasks.")
      },
    })
  })

  test("does not let a stale watcher overwrite a terminal update", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        const { ExperimentRemoteTaskStartTool } = await import("../../src/tool/experiment-remote-task")
        const { ExperimentRemoteTask } = await import("../../src/research/experiment-remote-task")
        const { forceRefreshRemoteTask } = await import("../../src/research/experiment-remote-task-watcher")
        const start = await ExperimentRemoteTaskStartTool.init()
        const started = await start.execute(
          {
            expId: "exp-1",
            kind: "experiment_run",
            title: "Train model",
            remoteRoot: "/mnt/zhouzih",
            command: "python train.py",
          },
          ctx,
        )
        const gate = Promise.withResolvers<void>()
        inspectRemoteTaskMock.mockImplementation(async () => {
          await gate.promise
          return {
            ok: true,
            output: "__SCREEN__\ndetached\n__TARGET__\nunknown\n__EXIT__\npending\n__TAIL__\nSTART",
            code: 0,
          }
        })

        const refresh = forceRefreshRemoteTask("exp-1")
        ExperimentRemoteTask.update({ taskId: started.metadata.taskId, status: "finished", errorMessage: null })
        gate.resolve()
        await refresh

        expect(ExperimentRemoteTask.get(started.metadata.taskId)?.status).toBe("finished")
        expect(ExperimentRemoteTask.get(started.metadata.taskId)?.error_message).toBeNull()
      },
    })
  })

  test("waits for the specified task id only", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        const { ExperimentRemoteTaskGetTool, ExperimentRemoteTaskStartTool } = await import(
          "../../src/tool/experiment-remote-task"
        )
        const { ExperimentRemoteTask } = await import("../../src/research/experiment-remote-task")
        const start = await ExperimentRemoteTaskStartTool.init()
        const cub = await start.execute(
          {
            expId: "exp-1",
            kind: "resource_download",
            title: "CUB download",
            remoteRoot: "/mnt/zhouzih",
            command: "python prepare_cub.py",
            resourceKey: "cub200",
            targetPath: "/mnt/zhouzih/resources/cub200",
          },
          ctx,
        )
        const imagenet = await start.execute(
          {
            expId: "exp-1",
            kind: "resource_download",
            title: "ImageNet download",
            remoteRoot: "/mnt/zhouzih",
            command: "python prepare_imagenet.py",
            resourceKey: "imagenet",
            targetPath: "/mnt/zhouzih/resources/imagenet",
          },
          ctx,
        )

        const get = await ExperimentRemoteTaskGetTool.init()
        const pending = get.execute(
          { expId: "exp-1", taskId: cub.metadata.taskId, waitForTerminal: true, waitTimeoutMs: 1000 },
          ctx,
        )
        setTimeout(() => {
          ExperimentRemoteTask.update({ taskId: cub.metadata.taskId, status: "finished", errorMessage: null })
        }, 10)

        const result = await pending
        expect(result.metadata.taskId).toBe(cub.metadata.taskId)
        expect(result.metadata.status).toBe("finished")
        expect(result.metadata.waited).toBe(true)
        expect(ExperimentRemoteTask.get(imagenet.metadata.taskId)?.status).toBe("running")
      },
    })
  })

  test("registers one durable direct listener and posts one completion message", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { Session } = await import("../../src/session")
        const { Collab, CollabAutoWake, CollabMessage } = await import("../../src/collab")
        CollabAutoWake.setEnabled(false)
        try {
          await seed(tmp.path)
          const { ExperimentRemoteTaskGetTool, ExperimentRemoteTaskStartTool } = await import(
            "../../src/tool/experiment-remote-task"
          )
          const { ExperimentRemoteTask } = await import("../../src/research/experiment-remote-task")
          const session = await Session.create({ title: "remote listener" })
          const context = { ...ctx, sessionID: session.id }
          const start = await ExperimentRemoteTaskStartTool.init()
          const started = await start.execute(
            {
              expId: "exp-1",
              kind: "experiment_run",
              title: "Train model",
              remoteRoot: "/mnt/zhouzih",
              command: "python train.py",
              targetPath: null,
            },
            context,
          )

          const get = await ExperimentRemoteTaskGetTool.init()
          const first = await get.execute(
            {
              expId: "exp-1",
              taskId: started.metadata.taskId,
              listenForTerminal: true,
              waitTimeoutMs: 1000,
            },
            context,
          )
          expect(first.metadata.listening).toBe(true)
          expect(first.metadata.duplicate).toBe(false)
          expect(first.metadata.phase).toBe("listening_terminal")
          expect(first.output).toContain("YOU MUST END YOUR TURN NOW")
          expect(inspectRemoteTaskMock).toHaveBeenCalledTimes(1)

          const again = await get.execute(
            { expId: "exp-1", taskId: started.metadata.taskId, listenForTerminal: true },
            context,
          )
          expect(again.metadata.duplicate).toBe(true)
          expect(inspectRemoteTaskMock).toHaveBeenCalledTimes(2)
          const listeners = Database.use((db) => db.select().from(RemoteTaskListenerTable).all())
          expect(listeners).toHaveLength(1)
          expect(listeners[0].mode).toBe("direct")
          expect(Collab.workflowAsyncState(session.id).hasRemoteTaskListeners).toBe(false)

          ExperimentRemoteTask.update({ taskId: started.metadata.taskId, status: "finished", errorMessage: null })

          expect(Database.use((db) => db.select().from(RemoteTaskListenerTable).all())).toHaveLength(0)
          const node = Collab.getBySession(session.id)!
          const messages = CollabMessage.list(node.id, { kind: "session_remote_task_terminal" })
          expect(messages).toHaveLength(1)
          expect(messages[0].status).toBe("pending")
          expect(messages[0].payload_json).toMatchObject({
            taskId: started.metadata.taskId,
            expId: "exp-1",
            status: "finished",
          })
          expect(Collab.workflowAsyncState(session.id)).toMatchObject({
            hasRemoteTaskListeners: false,
            hasPendingWakeMessages: false,
          })

          ExperimentRemoteTask.update({ taskId: started.metadata.taskId, status: "finished" })
          expect(CollabMessage.list(node.id, { kind: "session_remote_task_terminal" })).toHaveLength(1)
        } finally {
          CollabAutoWake.setEnabled(true)
        }
      },
    })
  })

  test("registers human session listeners in direct mode", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { Session } = await import("../../src/session")
        const { Collab, CollabAutoWake } = await import("../../src/collab")
        const { ExperimentRemoteTaskGetTool, ExperimentRemoteTaskStartTool } = await import(
          "../../src/tool/experiment-remote-task"
        )
        const { SessionOwnership } = await import("../../src/session/ownership")
        CollabAutoWake.setEnabled(false)
        try {
          await seed(tmp.path)
          const session = await Session.create({ title: "human remote listener" })
          const context = { ...ctx, sessionID: session.id }
          const start = await ExperimentRemoteTaskStartTool.init()
          const started = await start.execute(
            {
              expId: "exp-1",
              kind: "experiment_run",
              title: "Train model",
              remoteRoot: "/mnt/zhouzih",
              command: "python train.py",
              targetPath: null,
            },
            context,
          )
          const release = SessionOwnership.claim(session.id, "human")!
          try {
            const get = await ExperimentRemoteTaskGetTool.init()
            await get.execute(
              { expId: "exp-1", taskId: started.metadata.taskId, listenForTerminal: true },
              context,
            )
          } finally {
            release()
          }

          const listener = Database.use((db) => db.select().from(RemoteTaskListenerTable).get())
          expect(listener?.mode).toBe("direct")
          expect(Collab.workflowAsyncState(session.id).hasRemoteTaskListeners).toBe(false)
        } finally {
          CollabAutoWake.setEnabled(true)
        }
      },
    })
  })

  test("validates terminal listener parameters before inspecting a task", async () => {
    const { ExperimentRemoteTaskGetTool } = await import("../../src/tool/experiment-remote-task")
    const get = await ExperimentRemoteTaskGetTool.init()
    await expect(get.execute({ expId: "exp-1", listenForTerminal: true }, ctx)).rejects.toThrow(
      "taskId is required",
    )
    await expect(
      get.execute(
        {
          expId: "exp-1",
          taskId: "task-1",
          listenForTerminal: true,
          waitForTerminal: true,
        },
        ctx,
      ),
    ).rejects.toThrow("cannot both be enabled")
  })

  test("refreshes the specified task id even when it is not the current task", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        const { ExperimentRemoteTaskGetTool, ExperimentRemoteTaskStartTool } = await import(
          "../../src/tool/experiment-remote-task"
        )
        const { ExperimentRemoteTask } = await import("../../src/research/experiment-remote-task")
        const start = await ExperimentRemoteTaskStartTool.init()
        const cub = await start.execute(
          {
            expId: "exp-1",
            kind: "resource_download",
            title: "CUB download",
            remoteRoot: "/mnt/zhouzih",
            command: "python prepare_cub.py",
            resourceKey: "cub200",
            targetPath: "/mnt/zhouzih/resources/cub200",
          },
          ctx,
        )
        const imagenet = await start.execute(
          {
            expId: "exp-1",
            kind: "resource_download",
            title: "ImageNet download",
            remoteRoot: "/mnt/zhouzih",
            command: "python prepare_imagenet.py",
            resourceKey: "imagenet",
            targetPath: "/mnt/zhouzih/resources/imagenet",
          },
          ctx,
        )

        ExperimentRemoteTask.update({ taskId: cub.metadata.taskId, status: "finished" })
        inspectRemoteTaskMock.mockClear()
        inspectRemoteTaskMock.mockImplementation(async () => ({
          ok: true,
          output: "__SCREEN__\nstopped\n__TARGET__\nmissing\n__TAIL__\nTraceback\nEXIT_CODE:2",
          code: 0,
        }))

        const get = await ExperimentRemoteTaskGetTool.init()
        const result = await get.execute({ expId: "exp-1", taskId: cub.metadata.taskId, waitForTerminal: false }, ctx)

        expect(inspectRemoteTaskMock).toHaveBeenCalledTimes(1)
        expect(result.metadata.taskId).toBe(cub.metadata.taskId)
        expect(result.metadata.status).toBe("failed")
        expect(ExperimentRemoteTask.get(cub.metadata.taskId)?.status).toBe("failed")
        expect(ExperimentRemoteTask.get(imagenet.metadata.taskId)?.status).toBe("running")
      },
    })
  })

  test("waits for running env setup task to reach terminal status", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        const { ExperimentRemoteTaskStartTool, ExperimentRemoteTaskGetTool } = await import(
          "../../src/tool/experiment-remote-task"
        )
        const { ExperimentRemoteTask } = await import("../../src/research/experiment-remote-task")

        const start = await ExperimentRemoteTaskStartTool.init()
        await start.execute(
          {
            expId: "exp-1",
            kind: "env_setup",
            title: "Python env setup",
            remoteRoot: "/mnt/zhouzih",
            command: "/mnt/zhouzih/miniconda3/bin/conda env update -n openresearch -f environment.yml",
            targetPath: "/mnt/zhouzih/miniconda3/envs/openresearch",
          },
          ctx,
        )

        const task = ExperimentRemoteTask.current("exp-1")!
        const get = await ExperimentRemoteTaskGetTool.init()
        const pending = get.execute({ expId: "exp-1", waitForTerminal: true, waitTimeoutMs: 1000 }, ctx)
        setTimeout(() => {
          ExperimentRemoteTask.update({ taskId: task.task_id, status: "finished", errorMessage: null })
        }, 10)

        const result = await pending
        expect(result.output).toContain("Status: finished")
        expect(result.output).toContain("Waited: terminal")
        expect(result.metadata.status).toBe("finished")
        expect(result.metadata.waited).toBe(true)
      },
    })
  })

  test("waits for experiment run task terminal status", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(tmp.path)
        const { ExperimentRemoteTaskStartTool, ExperimentRemoteTaskGetTool } = await import(
          "../../src/tool/experiment-remote-task"
        )
        const { ExperimentRemoteTask } = await import("../../src/research/experiment-remote-task")

        const start = await ExperimentRemoteTaskStartTool.init()
        await start.execute(
          {
            expId: "exp-1",
            kind: "experiment_run",
            title: "Train model",
            remoteRoot: "/mnt/zhouzih",
            command: "python train.py",
            targetPath: null,
          },
          ctx,
        )

        const task = ExperimentRemoteTask.current("exp-1")!
        const get = await ExperimentRemoteTaskGetTool.init()
        const pending = get.execute({ expId: "exp-1", waitForTerminal: true, waitTimeoutMs: 1000 }, ctx)
        setTimeout(() => {
          ExperimentRemoteTask.update({ taskId: task.task_id, status: "finished", errorMessage: null })
        }, 10)

        const result = await pending
        expect(result.output).toContain("Status: finished")
        expect(result.output).toContain("Waited: terminal")
        expect(result.metadata.kind).toBe("experiment_run")
        expect(result.metadata.waited).toBe(true)
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

  test("fails a dead remote task without grace delay", async () => {
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
          output: "__SCREEN__\ndead\n__TARGET__\nmissing\n__TAIL__\nSTART",
          code: 0,
        }))

        const refresh = await forceRefreshRemoteTask("exp-1")
        expect(refresh.success).toBeTrue()

        const task = Database.use((db) =>
          db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, "exp-1")).get(),
        )
        expect(task?.status).toBe("failed")
        expect(task?.stopped_at).toBeNull()
        expect(task?.error_message).toBe("remote task screen is dead before writing completion marker")
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
