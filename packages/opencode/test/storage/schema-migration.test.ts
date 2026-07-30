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
    expect(sqlite.query("PRAGMA table_info('remote_task_listener')").all()).toContainEqual(
      expect.objectContaining({ name: "run_id" }),
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
