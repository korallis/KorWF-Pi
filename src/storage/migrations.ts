/**
 * Forward-only migration runner (issue #23; ADR 0006 rule 4).
 *
 * Migrations are numbered SQL files in `src/storage/migrations/NNNN-*.sql`.
 * Each is applied exactly once, inside a transaction, and recorded in the
 * `schema_migration` table together with a checksum of the file. There is no
 * down-migration and no implicit `CREATE TABLE IF NOT EXISTS` anywhere else
 * in the package: if it is not in a numbered file, it does not exist.
 *
 * Opening a store whose recorded version is newer than the highest migration
 * this package ships fails with `SchemaTooNewError` rather than guessing.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MigrationFailedError, SchemaTooNewError } from "./errors.ts";

/** Directory holding the numbered `.sql` files. */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** `NNNN-name.sql` */
const MIGRATION_FILE = /^(\d{4})-([a-z0-9-]+)\.sql$/;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly sql: string;
  /** SHA-256 of the file contents; recorded so drift is detectable. */
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

let cached: readonly Migration[] | null = null;

/** Read and parse every shipped migration, ordered by version. Cached per process. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): readonly Migration[] {
  if (dir === MIGRATIONS_DIR && cached !== null) return cached;
  const migrations: Migration[] = [];
  const seen = new Set<number>();
  for (const fileName of readdirSync(dir).sort()) {
    const match = MIGRATION_FILE.exec(fileName);
    if (match === null) {
      if (fileName.endsWith(".sql")) {
        throw new MigrationFailedError(0, `migration file ${fileName} is not named NNNN-name.sql`);
      }
      continue;
    }
    const version = Number(match[1]);
    if (seen.has(version)) {
      throw new MigrationFailedError(version, `two migration files claim version ${version}`);
    }
    seen.add(version);
    const sql = readFileSync(join(dir, fileName), "utf8");
    migrations.push({
      version,
      name: match[2] ?? fileName,
      fileName,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  migrations.sort((a, b) => a.version - b.version);
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1) {
      throw new MigrationFailedError(
        migration.version,
        `migrations must be numbered consecutively from 0001; found ${migration.fileName} at position ${index + 1}`,
      );
    }
  }
  if (dir === MIGRATIONS_DIR) cached = migrations;
  return migrations;
}

/** Highest migration version this package knows how to apply. */
export function latestSchemaVersion(dir: string = MIGRATIONS_DIR): number {
  const all = loadMigrations(dir);
  return all.length === 0 ? 0 : (all[all.length - 1]?.version ?? 0);
}

/** `true` once migration 0001 has created the ledger. */
function hasLedger(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'")
    .get();
  return row !== undefined;
}

/** Migrations already applied to this database, oldest first. */
export function appliedMigrations(db: DatabaseSync): readonly AppliedMigration[] {
  if (!hasLedger(db)) return [];
  const rows = db
    .prepare("SELECT version, name, checksum, appliedAt FROM schema_migration ORDER BY version")
    .all() as unknown as AppliedMigration[];
  return rows.map((row) => ({
    version: Number(row.version),
    name: String(row.name),
    checksum: String(row.checksum),
    appliedAt: String(row.appliedAt),
  }));
}

/** Current schema version of an open database; `0` for an empty one. */
export function currentSchemaVersion(db: DatabaseSync): number {
  const applied = appliedMigrations(db);
  return applied.length === 0 ? 0 : (applied[applied.length - 1]?.version ?? 0);
}

export interface MigrateOptions {
  /** Directory of SQL files; defaults to the shipped one. */
  readonly dir?: string;
  /** Stop after this version. Used by the migration test matrix. */
  readonly targetVersion?: number;
  /** ISO timestamp recorded in the ledger. */
  readonly now?: string;
  /**
   * Test seam: called after each migration's SQL has run but before its
   * ledger row is committed, so a crash mid-migration can be simulated.
   * Throwing here must leave the database exactly as it was.
   */
  readonly beforeCommit?: (migration: Migration) => void;
}

export interface MigrateResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly number[];
}

/**
 * Bring `db` up to `targetVersion` (default: the latest shipped migration).
 *
 * Each migration runs inside `BEGIN IMMEDIATE` … `COMMIT`. If anything throws
 * the transaction is rolled back, so a crash during migration leaves the
 * store at the previous version with no partial schema.
 */
export function migrate(db: DatabaseSync, options: MigrateOptions = {}): MigrateResult {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const all = loadMigrations(dir);
  const known = all.length === 0 ? 0 : (all[all.length - 1]?.version ?? 0);
  const from = currentSchemaVersion(db);
  if (from > known) throw new SchemaTooNewError(from, known);

  const target = options.targetVersion ?? known;
  const applied: number[] = [];
  for (const migration of all) {
    if (migration.version <= from || migration.version > target) continue;
    applyOne(db, migration, options.now ?? new Date().toISOString(), options.beforeCommit);
    applied.push(migration.version);
  }
  return { fromVersion: from, toVersion: currentSchemaVersion(db), applied };
}

function applyOne(
  db: DatabaseSync,
  migration: Migration,
  now: string,
  beforeCommit: MigrateOptions["beforeCommit"],
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(migration.sql);
    beforeCommit?.(migration);
    db.prepare(
      "INSERT INTO schema_migration (version, name, checksum, appliedAt) VALUES (?, ?, ?, ?)",
    ).run(migration.version, migration.name, migration.checksum, now);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction was already rolled back by SQLite; nothing to undo.
    }
    throw new MigrationFailedError(migration.version, describe(error));
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
