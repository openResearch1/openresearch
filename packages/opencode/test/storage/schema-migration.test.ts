import { readdirSync } from "fs"
import path from "path"

import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"

const root = path.join(import.meta.dir, "../../migration")

function entries() {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      timestamp: Date.UTC(
        Number(entry.name.slice(0, 4)),
        Number(entry.name.slice(4, 6)) - 1,
        Number(entry.name.slice(6, 8)),
        Number(entry.name.slice(8, 10)),
        Number(entry.name.slice(10, 12)),
        Number(entry.name.slice(12, 14)),
      ),
      sql: Bun.file(path.join(root, entry.name, "migration.sql")).text(),
    }))
    .toSorted((a, b) => a.timestamp - b.timestamp)
}

test("upgrades a database that already applied project Atom delegation", async () => {
  const journal = await Promise.all(
    entries().map(async (entry) => ({
      ...entry,
      sql: await entry.sql,
    })),
  )
  const old = journal.findIndex((entry) => entry.name === "20260727042147_project_atom_delegation")
  expect(old).toBeGreaterThan(-1)

  const sqlite = new Database(":memory:")
  try {
    const db = drizzle({ client: sqlite })
    migrate(db, journal.slice(0, old + 1))
    expect(sqlite.query("PRAGMA table_info('collab_agent')").all()).toContainEqual(
      expect.objectContaining({ name: "run_id" }),
    )
    expect(sqlite.query("PRAGMA table_info('collab_message')").all()).not.toContainEqual(
      expect.objectContaining({ name: "claim_id" }),
    )

    migrate(db, journal)

    expect(sqlite.query("PRAGMA table_info('collab_message')").all()).toContainEqual(
      expect.objectContaining({ name: "claim_id" }),
    )
    expect(sqlite.query("PRAGMA table_info('collab_agent')").all()).toContainEqual(
      expect.objectContaining({ name: "initiator" }),
    )
    expect(sqlite.query("PRAGMA table_info('remote_task_listener')").all()).toContainEqual(
      expect.objectContaining({ name: "run_id" }),
    )
    expect(sqlite.query("PRAGMA table_info('scheduled_task')").all()).toContainEqual(
      expect.objectContaining({ name: "due_at", notnull: 1 }),
    )
    expect(sqlite.query("PRAGMA table_info('experiment')").all()).toContainEqual(
      expect.objectContaining({ name: "baseline_commit_sha" }),
    )
    expect(sqlite.query("PRAGMA table_info('atom')").all()).toContainEqual(
      expect.objectContaining({ name: "locked", notnull: 1, dflt_value: "false" }),
    )
    expect(sqlite.query("PRAGMA table_info('research_result')").all()).toContainEqual(
      expect.objectContaining({ name: "atoms_json", notnull: 1 }),
    )
    expect(
      sqlite
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('research_deletion', 'session_deletion', 'session_ownership')",
        )
        .all(),
    ).toHaveLength(3)
  } finally {
    sqlite.close()
  }
})

test("normalizes legacy Atom relation names", async () => {
  const journal = await Promise.all(
    entries().map(async (entry) => ({
      ...entry,
      sql: await entry.sql,
    })),
  )
  const migration = journal.findIndex((entry) => entry.name === "20260729121725_normalize_atom_relations")
  expect(migration).toBeGreaterThan(-1)

  const sqlite = new Database(":memory:")
  try {
    const db = drizzle({ client: sqlite })
    migrate(db, journal.slice(0, migration))
    sqlite.run("PRAGMA foreign_keys = OFF")
    const insert = sqlite.prepare(
      "INSERT INTO atom_relation (atom_id_source, atom_id_target, relation_type, time_created, time_updated) VALUES (?, ?, ?, 1, 1)",
    )
    insert.run("a", "b", "formalizes")
    insert.run("c", "d", "analyzes")
    insert.run("e", "f", "validates")
    insert.run("a", "b", "formalized_by")

    migrate(db, journal)

    expect(sqlite.query("SELECT relation_type FROM atom_relation ORDER BY relation_type").all()).toEqual([
      { relation_type: "analyzed_by" },
      { relation_type: "evaluated_by" },
      { relation_type: "formalized_by" },
    ])
  } finally {
    sqlite.close()
  }
})

test("backfills experiment status from the latest execution watch", async () => {
  const journal = await Promise.all(
    entries().map(async (entry) => ({
      ...entry,
      sql: await entry.sql,
    })),
  )
  const migration = journal.findIndex((entry) => entry.name === "20260803022416_experiment_status_projection")
  expect(migration).toBeGreaterThan(-1)

  const sqlite = new Database(":memory:")
  try {
    const db = drizzle({ client: sqlite })
    migrate(db, journal.slice(0, migration))
    sqlite.run("PRAGMA foreign_keys = OFF")
    sqlite.run(
      "INSERT INTO experiment (exp_id, research_project_id, exp_name, code_path, status, time_created, time_updated) VALUES ('exp-1', 'research-1', 'experiment', '/tmp/experiment', 'pending', 1, 1)",
    )
    sqlite.run(
      "INSERT INTO experiment_execution_watch (watch_id, exp_id, status, stage, title, started_at, finished_at, time_created, time_updated) VALUES ('watch-1', 'exp-1', 'running', 'running_experiment', 'old', 10, NULL, 10, 10)",
    )
    sqlite.run(
      "INSERT INTO experiment_execution_watch (watch_id, exp_id, status, stage, title, started_at, finished_at, time_created, time_updated) VALUES ('watch-2', 'exp-1', 'finished', 'running_experiment', 'latest', 20, 30, 20, 30)",
    )

    migrate(db, journal)

    expect(sqlite.query("SELECT status, started_at, finished_at, time_updated FROM experiment").get()).toEqual({
      status: "done",
      started_at: 20,
      finished_at: 30,
      time_updated: 30,
    })
  } finally {
    sqlite.close()
  }
})

test("backfills remote task server IDs only for unique server identities", async () => {
  const journal = await Promise.all(
    entries().map(async (entry) => ({
      ...entry,
      sql: await entry.sql,
    })),
  )
  const migration = journal.findIndex((entry) => entry.name === "20260827011202_remote_task_server_id")
  expect(migration).toBeGreaterThan(-1)

  const sqlite = new Database(":memory:")
  try {
    const db = drizzle({ client: sqlite })
    migrate(db, journal.slice(0, migration))
    sqlite.run("PRAGMA foreign_keys = OFF")
    sqlite.run(
      `INSERT INTO remote_server (id, config, time_created, time_updated) VALUES
        ('server-a', '{"mode":"direct","address":"10.0.0.1","port":22,"user":"root","password":"rotated"}', 1, 1),
        ('server-b', '{"mode":"direct","address":"10.0.0.2","port":22,"user":"root"}', 1, 1),
        ('server-ssh', '{"mode":"ssh_config","host_alias":"gpu","ssh_config_path":"/tmp/ssh","user":"runner"}', 1, 1),
        ('server-dup-1', '{"mode":"direct","address":"10.0.0.3","port":22,"user":"root"}', 1, 1),
        ('server-dup-2', '{"mode":"direct","address":"10.0.0.3","port":22,"user":"root"}', 1, 1)`,
    )
    sqlite.run(
      `INSERT INTO experiment (exp_id, research_project_id, exp_name, remote_server_id, code_path, status, time_created, time_updated) VALUES
        ('exp-1', 'research-1', 'experiment', 'server-b', '/tmp/experiment', 'pending', 1, 1)`,
    )
    const insert = sqlite.prepare(
      "INSERT INTO remote_task (task_id, exp_id, kind, title, status, server, remote_root, screen_name, command, time_created, time_updated) VALUES (?, 'exp-1', 'experiment_run', ?, 'finished', ?, '/tmp', ?, 'true', 1, 1)",
    )
    insert.run(
      "task-direct",
      "direct",
      '{"mode":"direct","address":"10.0.0.1","port":22,"user":"root","password":"original"}',
      "direct",
    )
    insert.run(
      "task-legacy",
      "legacy",
      '{"address":"10.0.0.1","port":22,"user":"root","password":"original"}',
      "legacy",
    )
    insert.run(
      "task-ssh",
      "ssh",
      '{"mode":"ssh_config","host_alias":"gpu","ssh_config_path":"/tmp/ssh","user":"runner"}',
      "ssh",
    )
    insert.run(
      "task-ambiguous",
      "ambiguous",
      '{"mode":"direct","address":"10.0.0.3","port":22,"user":"root"}',
      "ambiguous",
    )
    insert.run("task-missing", "missing", '{"mode":"direct","address":"10.0.0.9","port":22,"user":"root"}', "missing")
    insert.run("task-invalid", "invalid", "{", "invalid")

    migrate(db, journal)

    expect(sqlite.query("SELECT task_id, remote_server_id FROM remote_task ORDER BY task_id").all()).toEqual([
      { task_id: "task-ambiguous", remote_server_id: null },
      { task_id: "task-direct", remote_server_id: "server-a" },
      { task_id: "task-invalid", remote_server_id: null },
      { task_id: "task-legacy", remote_server_id: "server-a" },
      { task_id: "task-missing", remote_server_id: null },
      { task_id: "task-ssh", remote_server_id: "server-ssh" },
    ])
  } finally {
    sqlite.close()
  }
})
