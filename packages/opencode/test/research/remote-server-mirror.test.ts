import { afterEach, beforeEach, expect, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectRuntime } from "../../src/research/project-runtime"
import {
  ExperimentExecutionWatchTable,
  ExperimentTable,
  ProjectRuntimeEnvironmentTable,
  ProjectRuntimeResourceTable,
  RemoteServerTable,
  RemoteTaskTable,
  ResearchProjectTable,
} from "../../src/research/research.sql"
import { ResearchRoutes } from "../../src/server/routes/research"
import { Database, eq } from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

beforeEach(async () => resetDatabase())
afterEach(async () => resetDatabase())

test("mirrors runtime records from every project onto a new server", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const now = Date.now() - 10_000
      const source = "server-source"
      const projects = [
        { id: "research-1", project: Instance.project.id, path: tmp.path },
        { id: "research-2", project: "project-2", path: "/worktrees/project-2" },
      ]

      Database.use((db) => {
        db.insert(ProjectTable).values({ id: projects[1].project, worktree: projects[1].path, sandboxes: [] }).run()
        db.insert(ResearchProjectTable)
          .values(projects.map((item) => ({ research_project_id: item.id, project_id: item.project })))
          .run()
        db.insert(RemoteServerTable)
          .values({
            id: source,
            config: JSON.stringify({
              mode: "direct",
              address: "10.0.0.1",
              port: 22,
              user: "source",
              password: "source-secret",
            }),
            time_created: now,
            time_updated: now,
          })
          .run()

        for (const item of projects) {
          const key = ProjectRuntime.key(item.id, source)
          db.insert(ExperimentTable)
            .values({
              exp_id: ProjectRuntime.id(key),
              kind: "project_runtime",
              runtime_key: key,
              research_project_id: item.id,
              exp_name: "[system] Project Runtime",
              remote_server_id: source,
              code_path: item.path,
              status: "running",
              started_at: now,
              time_created: now,
              time_updated: now,
            })
            .run()
        }

        db.insert(ExperimentTable)
          .values({
            exp_id: "ordinary-exp",
            research_project_id: projects[0].id,
            exp_name: "Ordinary experiment",
            remote_server_id: source,
            code_path: tmp.path,
          })
          .run()

        db.insert(ProjectRuntimeEnvironmentTable)
          .values([
            {
              env_id: "env-1",
              research_project_id: projects[0].id,
              remote_server_id: source,
              runtime_exp_id: ProjectRuntime.id(ProjectRuntime.key(projects[0].id, source)),
              env_key: "train",
              conda_env_name: "train-env",
              python_version: "3.12",
              spec: JSON.stringify({ channels: ["conda-forge"], runtime_success: [{ exp_id: "ordinary-exp" }] }),
              fingerprint: "env-sha-1",
              status: "ready",
              last_verified_at: now - 100,
              error_message: null,
              time_created: now,
              time_updated: now,
            },
            {
              env_id: "env-2",
              research_project_id: projects[1].id,
              remote_server_id: source,
              runtime_exp_id: ProjectRuntime.id(ProjectRuntime.key(projects[1].id, source)),
              env_key: "eval",
              conda_env_name: "eval-env",
              python_version: null,
              spec: null,
              fingerprint: null,
              status: "failed",
              last_verified_at: null,
              error_message: "environment failed",
              time_created: now,
              time_updated: now,
            },
          ])
          .run()

        db.insert(ProjectRuntimeResourceTable)
          .values([
            {
              resource_id: "resource-1",
              research_project_id: projects[0].id,
              remote_server_id: source,
              runtime_exp_id: ProjectRuntime.id(ProjectRuntime.key(projects[0].id, source)),
              resource_key: "dataset",
              type: "dataset",
              source: JSON.stringify({ registry: "huggingface", id: "org/data" }),
              target_path: "/data/dataset",
              verify: JSON.stringify({ rows: 100, runtime_success: [{ exp_id: "ordinary-exp" }] }),
              fingerprint: "resource-sha-1",
              status: "ready",
              last_verified_at: now - 200,
              error_message: null,
              time_created: now,
              time_updated: now,
            },
            {
              resource_id: "resource-2",
              research_project_id: projects[1].id,
              remote_server_id: source,
              runtime_exp_id: ProjectRuntime.id(ProjectRuntime.key(projects[1].id, source)),
              resource_key: "checkpoint",
              type: "checkpoint",
              source: null,
              target_path: "/models/checkpoint",
              verify: null,
              fingerprint: null,
              status: "downloading",
              last_verified_at: null,
              error_message: "still downloading",
              time_created: now,
              time_updated: now,
            },
          ])
          .run()

        db.insert(ExperimentExecutionWatchTable)
          .values({
            watch_id: "source-watch",
            exp_id: ProjectRuntime.id(ProjectRuntime.key(projects[0].id, source)),
            status: "running",
            stage: "setting_up_env",
            title: "Source runtime",
            started_at: now,
            time_created: now,
            time_updated: now,
          })
          .run()
        db.insert(RemoteTaskTable)
          .values({
            task_id: "source-task",
            exp_id: ProjectRuntime.id(ProjectRuntime.key(projects[0].id, source)),
            kind: "env_setup",
            resource_key: null,
            title: "Source task",
            status: "running",
            server: JSON.stringify({ address: "10.0.0.1" }),
            remote_root: "/tmp/runtime",
            target_path: null,
            screen_name: "source-task",
            command: "conda env create",
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      const response = await ResearchRoutes.request(`/server/${source}/mirror`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: {
            mode: "ssh_config",
            host_alias: "mirror-host",
            user: "mirror-user",
            resource_root: "/mirror/resources",
          },
        }),
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({
        config: {
          mode: "ssh_config",
          host_alias: "mirror-host",
          user: "mirror-user",
          resource_root: "/mirror/resources",
          network: { mode: "direct" },
        },
        copied: { runtimes: 2, environments: 2, resources: 2 },
      })
      expect(body.config).not.toHaveProperty("password")

      const runtimes = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.remote_server_id, body.id)).all(),
      )
      expect(runtimes).toHaveLength(2)
      expect(runtimes.map((item) => item.research_project_id).sort()).toEqual(["research-1", "research-2"])
      for (const runtime of runtimes) {
        const key = ProjectRuntime.key(runtime.research_project_id, body.id)
        expect(runtime).toMatchObject({
          exp_id: ProjectRuntime.id(key),
          kind: "project_runtime",
          runtime_key: key,
          status: "pending",
          started_at: null,
          finished_at: null,
        })
      }
      expect(runtimes.find((item) => item.research_project_id === "research-2")?.code_path).toBe("/worktrees/project-2")

      const environments = Database.use((db) =>
        db
          .select()
          .from(ProjectRuntimeEnvironmentTable)
          .where(eq(ProjectRuntimeEnvironmentTable.remote_server_id, body.id))
          .all(),
      )
      expect(environments).toHaveLength(2)
      expect(environments.find((item) => item.env_key === "train")).toMatchObject({
        research_project_id: "research-1",
        runtime_exp_id: ProjectRuntime.id(ProjectRuntime.key("research-1", body.id)),
        conda_env_name: "train-env",
        python_version: "3.12",
        spec: JSON.stringify({ channels: ["conda-forge"], runtime_success: [{ exp_id: "ordinary-exp" }] }),
        fingerprint: "env-sha-1",
        status: "ready",
        last_verified_at: now - 100,
        error_message: null,
      })
      expect(environments.find((item) => item.env_key === "eval")).toMatchObject({
        research_project_id: "research-2",
        runtime_exp_id: ProjectRuntime.id(ProjectRuntime.key("research-2", body.id)),
        status: "failed",
        error_message: "environment failed",
      })
      expect(environments.every((item) => item.time_created > now && !["env-1", "env-2"].includes(item.env_id))).toBe(
        true,
      )

      const resources = Database.use((db) =>
        db
          .select()
          .from(ProjectRuntimeResourceTable)
          .where(eq(ProjectRuntimeResourceTable.remote_server_id, body.id))
          .all(),
      )
      expect(resources).toHaveLength(2)
      expect(resources.find((item) => item.resource_key === "dataset")).toMatchObject({
        research_project_id: "research-1",
        runtime_exp_id: ProjectRuntime.id(ProjectRuntime.key("research-1", body.id)),
        type: "dataset",
        source: JSON.stringify({ registry: "huggingface", id: "org/data" }),
        target_path: "/data/dataset",
        verify: JSON.stringify({ rows: 100, runtime_success: [{ exp_id: "ordinary-exp" }] }),
        fingerprint: "resource-sha-1",
        status: "ready",
        last_verified_at: now - 200,
        error_message: null,
      })
      expect(resources.find((item) => item.resource_key === "checkpoint")).toMatchObject({
        research_project_id: "research-2",
        runtime_exp_id: ProjectRuntime.id(ProjectRuntime.key("research-2", body.id)),
        status: "downloading",
        error_message: "still downloading",
      })
      expect(
        resources.every((item) => item.time_created > now && !["resource-1", "resource-2"].includes(item.resource_id)),
      ).toBe(true)

      const watches = Database.use((db) => db.select().from(ExperimentExecutionWatchTable).all())
      expect(watches.filter((item) => runtimes.some((runtime) => runtime.exp_id === item.exp_id))).toHaveLength(2)
      expect(
        watches
          .filter((item) => runtimes.some((runtime) => runtime.exp_id === item.exp_id))
          .every((item) => item.status === "pending" && item.stage === "pending"),
      ).toBe(true)
      expect(Database.use((db) => db.select().from(RemoteTaskTable).all())).toHaveLength(1)
      expect(
        Database.use((db) => db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, "ordinary-exp")).get())
          ?.remote_server_id,
      ).toBe(source)
      expect(
        Database.use((db) =>
          db
            .select()
            .from(ProjectRuntimeEnvironmentTable)
            .where(eq(ProjectRuntimeEnvironmentTable.remote_server_id, source))
            .all(),
        ),
      ).toHaveLength(2)
    },
  })
})

test("returns 404 without creating a server when the source is missing", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const response = await ResearchRoutes.request("/server/missing/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { mode: "direct", address: "10.0.0.2", port: 22, user: "root" } }),
      })
      expect(response.status).toBe(404)
      expect(Database.use((db) => db.select().from(RemoteServerTable).all())).toHaveLength(0)
    },
  })
})

test("creates a target server when the source has no runtime records", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Database.use((db) =>
        db
          .insert(RemoteServerTable)
          .values({
            id: "server-source",
            config: JSON.stringify({ mode: "direct", address: "10.0.0.1", port: 22, user: "root" }),
          })
          .run(),
      )
      const response = await ResearchRoutes.request("/server/server-source/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { mode: "direct", address: "10.0.0.2", port: 22, user: "root" } }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ copied: { runtimes: 0, environments: 0, resources: 0 } })
      expect(Database.use((db) => db.select().from(RemoteServerTable).all())).toHaveLength(2)
      expect(Database.use((db) => db.select().from(ExperimentTable).all())).toHaveLength(0)
    },
  })
})

test("does not create a target server when source runtime records are inconsistent", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Database.use((db) => {
        db.insert(ResearchProjectTable)
          .values({ research_project_id: "research-1", project_id: Instance.project.id })
          .run()
        db.insert(RemoteServerTable)
          .values({
            id: "server-source",
            config: JSON.stringify({ mode: "direct", address: "10.0.0.1", port: 22, user: "root" }),
          })
          .run()
        db.insert(ExperimentTable)
          .values({
            exp_id: "ordinary-exp",
            research_project_id: "research-1",
            exp_name: "Ordinary experiment",
            code_path: tmp.path,
          })
          .run()
        db.insert(ProjectRuntimeEnvironmentTable)
          .values({
            env_id: "broken-env",
            research_project_id: "research-1",
            remote_server_id: "server-source",
            runtime_exp_id: "ordinary-exp",
            env_key: "broken",
            conda_env_name: "broken",
          })
          .run()
      })

      const response = await ResearchRoutes.request("/server/server-source/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { mode: "direct", address: "10.0.0.2", port: 22, user: "root" } }),
      })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        success: false,
        message: "project runtime not found for environment: broken-env",
      })
      expect(Database.use((db) => db.select().from(RemoteServerTable).all())).toHaveLength(1)
      expect(Database.use((db) => db.select().from(ProjectRuntimeEnvironmentTable).all())).toHaveLength(1)
    },
  })
})
