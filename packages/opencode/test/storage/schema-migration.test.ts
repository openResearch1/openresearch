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
