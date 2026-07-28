import { afterEach, beforeEach, expect, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { ProjectRuntimeResourceTable, RemoteServerTable, ResearchProjectTable } from "../../src/research/research.sql"
import { Session } from "../../src/session"
import { Database, and, eq } from "../../src/storage/db"
import type { Tool } from "../../src/tool/tool"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

beforeEach(async () => resetDatabase())
afterEach(async () => resetDatabase())

test("resource upsert preserves omitted metadata and merges verification", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "resource upsert" })
      Database.use((db) =>
        db
          .insert(ResearchProjectTable)
          .values({ research_project_id: "research-1", project_id: Instance.project.id })
          .run(),
      )
      Database.use((db) =>
        db
          .insert(RemoteServerTable)
          .values({
            id: "server-1",
            config: JSON.stringify({ mode: "direct", address: "10.0.0.1", port: 22, user: "user" }),
          })
          .run(),
      )

      const tool = await import("../../src/tool/project-runtime").then((mod) =>
        mod.ProjectRuntimeResourceUpsertTool.init(),
      )
      const ctx = {
        sessionID: session.id,
        messageID: "message-1",
        callID: "call-1",
        agent: "experiment_resource_prepare",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => {},
        ask: async () => {},
      } satisfies Tool.Context

      await tool.execute(
        {
          remoteServerId: "server-1",
          resourceKey: "dataset-1",
          type: "dataset",
          targetPath: "/resources/dataset-1",
          source: { registry: "huggingface", id: "org/dataset" },
          verify: {
            runtime_success: [{ code_root: "/repo", state: "trusted", exp_id: "exp-1" }],
            rows: 100,
          },
          fingerprint: "sha256:old",
          status: "ready",
          lastVerifiedAt: 100,
        },
        ctx,
      )
      await tool.execute(
        {
          remoteServerId: "server-1",
          resourceKey: "dataset-1",
          type: "dataset",
          targetPath: "/resources/dataset-1",
          verify: { samples: ["train/0.json"] },
        },
        ctx,
      )

      const row = Database.use((db) =>
        db
          .select()
          .from(ProjectRuntimeResourceTable)
          .where(
            and(
              eq(ProjectRuntimeResourceTable.research_project_id, "research-1"),
              eq(ProjectRuntimeResourceTable.remote_server_id, "server-1"),
              eq(ProjectRuntimeResourceTable.resource_key, "dataset-1"),
            ),
          )
          .get(),
      )!
      expect(JSON.parse(row.source!)).toEqual({ registry: "huggingface", id: "org/dataset" })
      expect(JSON.parse(row.verify!)).toEqual({
        runtime_success: [{ code_root: "/repo", state: "trusted", exp_id: "exp-1" }],
        rows: 100,
        samples: ["train/0.json"],
      })
      expect(row.fingerprint).toBe("sha256:old")
      expect(row.status).toBe("ready")
      expect(row.last_verified_at).toBe(100)
    },
  })
})
