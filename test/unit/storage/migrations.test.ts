/**
 * Migration runner tests (issue #23).
 *
 * AC: "Migration from empty DB and from each prior version succeeds (test
 * matrix grows with versions)" and the deliverable "tests including
 * crash-during-migration".
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync, type Database } from "../../../src/storage/sqlite.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appliedMigrations,
  currentSchemaVersion,
  latestSchemaVersion,
  loadMigrations,
  migrate,
  MIGRATIONS_DIR,
} from "../../../src/storage/migrations.ts";
import { MigrationFailedError, SchemaTooNewError } from "../../../src/storage/errors.ts";
import { makeTempDir } from "../../helpers/temp-dir.ts";

/** Every migration set needs the ledger; the shipped 0001 creates it. */
const LEDGER_SQL =
  "CREATE TABLE schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, appliedAt TEXT NOT NULL);";

function memoryDb(): Database {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function tableNames(db: Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as unknown as { name: string }[];
  return rows.map((r) => String(r.name));
}

describe("loadMigrations", () => {
  it("parses the shipped migrations and numbers them consecutively from 0001", () => {
    const all = loadMigrations();
    expect(all.length).toBeGreaterThan(0);
    expect(all.map((m) => m.version)).toEqual(all.map((_, i) => i + 1));
    expect(all[0]?.fileName).toBe("0001-initial.sql");
    expect(all[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a badly named .sql file", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir.path, "initial.sql"), "SELECT 1;");
      expect(() => loadMigrations(dir.path)).toThrow(MigrationFailedError);
    } finally {
      dir.cleanup();
    }
  });

  it("rejects a gap in the version sequence", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir.path, "0001-a.sql"), "CREATE TABLE a(x);");
      writeFileSync(join(dir.path, "0003-c.sql"), "CREATE TABLE c(x);");
      expect(() => loadMigrations(dir.path)).toThrow(/consecutively/);
    } finally {
      dir.cleanup();
    }
  });
});

describe("migrate (AC: migration from an empty DB succeeds)", () => {
  it("creates every record table plus the migration ledger", () => {
    const db = memoryDb();
    const result = migrate(db, { now: "2026-01-01T00:00:00.000Z" });
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(latestSchemaVersion());
    const names = tableNames(db);
    for (const table of [
      "schema_migration",
      "workflow",
      "phase",
      "task",
      "attempt",
      "decision",
      "evidence",
      "approval",
      "memory",
      "model_availability",
      "model_outcome",
      "audit_entry",
    ]) {
      expect(names).toContain(table);
    }
    db.close();
  });

  it("is idempotent: a second run applies nothing", () => {
    const db = memoryDb();
    migrate(db);
    const second = migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.fromVersion).toBe(second.toVersion);
    db.close();
  });

  it("records version, name and checksum in schema_migration", () => {
    const db = memoryDb();
    migrate(db, { now: "2026-01-01T00:00:00.000Z" });
    const applied = appliedMigrations(db);
    expect(applied.map((a) => a.version)).toEqual(loadMigrations().map((m) => m.version));
    expect(applied[0]?.checksum).toBe(loadMigrations()[0]?.checksum);
    expect(applied[0]?.appliedAt).toBe("2026-01-01T00:00:00.000Z");
    db.close();
  });
});

describe("migrate (AC: migration from each prior version succeeds)", () => {
  // The matrix walks every intermediate version: today that is {0 → latest},
  // and it grows automatically as 0002-*.sql, 0003-*.sql are added.
  const latest = latestSchemaVersion();
  for (let start = 0; start < latest; start += 1) {
    it(`upgrades a store at version ${start} to ${latest}`, () => {
      const db = memoryDb();
      if (start > 0) migrate(db, { targetVersion: start });
      expect(currentSchemaVersion(db)).toBe(start);
      const result = migrate(db);
      expect(result.fromVersion).toBe(start);
      expect(result.toVersion).toBe(latest);
      expect(currentSchemaVersion(db)).toBe(latest);
      db.close();
    });
  }
});

describe("migrate refuses a store from a newer package (ADR 0006 rule 4)", () => {
  it("throws SchemaTooNewError rather than guessing", () => {
    const db = memoryDb();
    migrate(db);
    db.prepare("INSERT INTO schema_migration (version, name, checksum, appliedAt) VALUES (?, ?, ?, ?)").run(
      9999,
      "from-the-future",
      "x",
      "2030-01-01T00:00:00.000Z",
    );
    expect(() => migrate(db)).toThrow(SchemaTooNewError);
    db.close();
  });
});

describe("crash during migration leaves the store unchanged", () => {
  it("rolls back the schema and the ledger row when a migration throws mid-way", () => {
    const db = memoryDb();
    expect(() =>
      migrate(db, {
        beforeCommit: () => {
          throw new Error("simulated crash");
        },
      }),
    ).toThrow(MigrationFailedError);
    // Nothing was committed: no ledger, no tables.
    expect(currentSchemaVersion(db)).toBe(0);
    expect(tableNames(db)).not.toContain("workflow");
    // And the store can still be migrated afterwards.
    migrate(db);
    expect(currentSchemaVersion(db)).toBe(latestSchemaVersion());
    db.close();
  });

  it("rolls back a failing second migration and keeps the first", () => {
    const dir = makeTempDir();
    try {
      mkdirSync(dir.path, { recursive: true });
      writeFileSync(join(dir.path, "0001-a.sql"), `${LEDGER_SQL} CREATE TABLE a(x);`);
      writeFileSync(join(dir.path, "0002-b.sql"), "CREATE TABLE b(x); THIS IS NOT SQL;");
      const db = memoryDb();
      expect(() => migrate(db, { dir: dir.path })).toThrow(MigrationFailedError);
      expect(currentSchemaVersion(db)).toBe(1);
      expect(tableNames(db)).toContain("a");
      expect(tableNames(db)).not.toContain("b");
      db.close();
    } finally {
      dir.cleanup();
    }
  });
});

describe("shipped migrations directory", () => {
  it("is the one inside src/storage", () => {
    expect(MIGRATIONS_DIR.endsWith(join("src", "storage", "migrations"))).toBe(true);
  });
});
