/**
 * Schema/spec drift guards (issue #23).
 *
 * The migration SQL and the `TableSpec`s are written by hand in two places;
 * these tests make it impossible for them to disagree, and pin the driver
 * choice ADR 0006 records.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, STORE_DRIVER, type Store } from "../../../src/storage/db.ts";
import { TABLE_SPECS } from "../../../src/storage/repos/specs.ts";
import { APPEND_ONLY_TABLES, MUTABLE_TABLES } from "../../../src/storage/records.ts";
import { latestSchemaVersion } from "../../../src/storage/migrations.ts";
import { ReadOnlyStoreError } from "../../../src/storage/errors.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makeWorkflow } from "../../helpers/records.ts";

const open: { dir: TempDir; store: Store }[] = [];

function freshStore(): Store {
  const dir = makeTempDir("korwf-schema-");
  const { store } = openStore({ storageRoot: dir.path });
  open.push({ dir, store });
  return store;
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

function columnsOf(store: Store, table: string): string[] {
  const rows = store.connection.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return rows.map((r) => String(r.name));
}

describe("every record table exists with the columns its spec declares", () => {
  const specs = Object.values(TABLE_SPECS);
  for (const spec of specs) {
    it(`${spec.table}: envelope + declared columns + payload`, () => {
      const store = freshStore();
      const actual = columnsOf(store, spec.table);
      for (const column of ["id", "createdAt", "updatedAt", "schemaVersion", "payload", ...spec.columns]) {
        // `table` is a reserved-ish name in the record type; the column is `tableName`.
        const expected = spec.table === "audit_entry" && column === "table" ? "tableName" : column;
        expect(actual, `${spec.table}.${expected}`).toContain(expected);
      }
    });
  }

  it("covers all eleven record types", () => {
    expect(Object.keys(TABLE_SPECS).sort()).toEqual([...APPEND_ONLY_TABLES, ...MUTABLE_TABLES].sort());
  });

  it("marks exactly the append-only tables as append-only", () => {
    const appendOnly = Object.values(TABLE_SPECS)
      .filter((s) => s.appendOnly)
      .map((s) => s.table)
      .sort();
    expect(appendOnly).toEqual([...APPEND_ONLY_TABLES].sort());
  });
});

describe("driver and pragmas (ADR 0006)", () => {
  it("uses the built-in node:sqlite driver", () => {
    expect(STORE_DRIVER).toBe("node:sqlite");
  });

  it("opens in WAL journal mode so readers never block the writer (rule 3)", () => {
    const store = freshStore();
    const row = store.connection.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
    expect(String(row?.journal_mode).toLowerCase()).toBe("wal");
  });

  it("enforces foreign keys", () => {
    const store = freshStore();
    const row = store.connection.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number } | undefined;
    expect(Number(row?.foreign_keys)).toBe(1);
  });

  it("migrates to the latest version on open", () => {
    const store = freshStore();
    expect(store.schemaVersion).toBe(latestSchemaVersion());
  });
});

describe("a read-only handle takes no lock and refuses to write (rule 3)", () => {
  it("throws ReadOnlyStoreError on any write path", () => {
    const dir = makeTempDir("korwf-ro-handle-");
    try {
      const writer = openStore({ storageRoot: dir.path });
      writer.store.workflows.insert(makeWorkflow());
      writer.store.close();

      const reader = openStore({ storageRoot: dir.path, writable: false });
      expect(reader.report.lock).toBeNull();
      expect(reader.store.lockHolderPid).toBeNull();
      expect(reader.store.workflows.count()).toBe(1);
      expect(() => reader.store.workflows.insert(makeWorkflow())).toThrow(ReadOnlyStoreError);
      expect(() => reader.store.reconcile()).toThrow(ReadOnlyStoreError);
      reader.store.close();
    } finally {
      dir.cleanup();
    }
  });
});

describe("no machine-specific or credential-looking data is persisted", () => {
  it("stores only project-relative paths in the artifact root", () => {
    const store = freshStore();
    expect(store.artifacts.root.endsWith("artifacts")).toBe(true);
    // Records themselves carry no absolute paths — asserted by the record
    // fixtures, which use repository-relative paths only.
    const workflow = store.workflows.insert(makeWorkflow());
    expect(JSON.stringify(workflow)).not.toContain(store.storageRoot);
  });
});
