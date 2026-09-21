/**
 * Generic repository machinery (issue #23).
 *
 * Every record is stored as its envelope plus the columns that are joined,
 * filtered or foreign-keyed on, plus the whole record as JSON in `payload`
 * (see `migrations/0001-initial.sql` for why). This module turns a
 * `TableSpec` into typed CRUD and guarantees the two rules that matter:
 *
 * - **Append-only tables expose insert and read only.** `AppendOnlyRepository`
 *   has no `update`/`delete` method at all, and the database has triggers as
 *   a second line of defence (ADR 0006 rule 5).
 * - **Every write to a mutable record produces an audit row** with actor,
 *   timestamp and before/after hashes (PLAN §5).
 */
import { createHash } from "node:crypto";
import type { Database, SqlInputValue } from "../sqlite.ts";
import { RecordNotFoundError, RecordRuleError } from "../errors.ts";
import type {
  AppendOnlyRecord,
  ContentHash,
  IsoTimestamp,
  MutableRecord,
  RecordEnvelope,
  RecordTable,
} from "../records.ts";

/** Values the indexed columns of a table may hold. */
export type ColumnValue = SqlInputValue;

/** Describes how one record type maps onto its table. */
export interface TableSpec<T extends RecordEnvelope<string>> {
  readonly table: RecordTable;
  readonly appendOnly: boolean;
  /** Indexed/foreign-key columns, excluding the envelope and `payload`. */
  readonly columns: readonly string[];
  /** Derive those columns from a record. Keys must match `columns`. */
  extract(record: T): Readonly<Record<string, ColumnValue>>;
  /** Workflow the row belongs to, for the audit row. `null` for workflow itself. */
  workflowIdOf(record: T): string | null;
}

/** Hook used to write the audit row for a mutable change. */
export interface AuditSink {
  record(entry: {
    readonly table: RecordTable;
    readonly recordId: string;
    readonly operation: "insert" | "update" | "delete";
    readonly beforeHash: ContentHash | null;
    readonly afterHash: ContentHash;
    readonly workflowId: string | null;
    readonly actor: string;
  }): void;
}

/** Context a repository needs: the write connection, a clock, and the actor. */
export interface RepoContext {
  readonly db: Database;
  now(): IsoTimestamp;
  /** Who is making the change; recorded on every audit row. */
  actor(): string;
  /** `null` for the audit repository itself, which must not audit itself. */
  readonly audit: AuditSink | null;
  /** Serialise a write in `BEGIN IMMEDIATE` (nested calls join the outer one). */
  write<R>(fn: () => R): R;
}

/** Stable hash of a record, used for audit before/after values. */
export function hashRecord(record: unknown): ContentHash {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}

/** JSON with object keys sorted, so hashing is order-independent. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function quote(column: string): string {
  return `"${column.replace(/"/g, '""')}"`;
}

interface StoredRow {
  readonly payload: string;
}

/** Shared read + insert behaviour. Append-only repositories expose only this. */
export class AppendOnlyRepository<T extends RecordEnvelope<string>> {
  protected readonly ctx: RepoContext;
  protected readonly spec: TableSpec<T>;

  constructor(ctx: RepoContext, spec: TableSpec<T>) {
    this.ctx = ctx;
    this.spec = spec;
  }

  get table(): RecordTable {
    return this.spec.table;
  }

  /** Insert a row. Returns the record exactly as persisted. */
  insert(record: T): T {
    return this.ctx.write(() => {
      const stored = this.normalise(record);
      const columns = ["id", "createdAt", "updatedAt", "schemaVersion", ...this.spec.columns, "payload"];
      const extracted = this.spec.extract(stored);
      const values: ColumnValue[] = [
        stored.id,
        stored.createdAt,
        stored.updatedAt,
        stored.schemaVersion,
        ...this.spec.columns.map((c) => extracted[c] ?? null),
        canonicalJson(stored),
      ];
      const sql =
        `INSERT INTO ${quote(this.spec.table)} (${columns.map(quote).join(", ")}) ` +
        `VALUES (${columns.map(() => "?").join(", ")})`;
      this.ctx.db.prepare(sql).run(...values);
      this.ctx.audit?.record({
        table: this.spec.table,
        recordId: stored.id,
        operation: "insert",
        beforeHash: null,
        afterHash: hashRecord(stored),
        workflowId: this.spec.workflowIdOf(stored),
        actor: this.ctx.actor(),
      });
      return stored;
    });
  }

  /** Read one row by id, or `undefined`. */
  get(id: string): T | undefined {
    const row = this.ctx.db
      .prepare(`SELECT payload FROM ${quote(this.spec.table)} WHERE id = ?`)
      .get(id) as StoredRow | undefined;
    return row === undefined ? undefined : (JSON.parse(row.payload) as T);
  }

  /** Read one row by id or throw `RecordNotFoundError`. */
  require(id: string): T {
    const found = this.get(id);
    if (found === undefined) throw new RecordNotFoundError(this.spec.table, id);
    return found;
  }

  /** All rows, oldest first. */
  list(): readonly T[] {
    return this.query("", []);
  }

  /** Rows matching `column = value`, oldest first. */
  findBy(column: string, value: ColumnValue): readonly T[] {
    return this.query(`WHERE ${quote(column)} = ?`, [value]);
  }

  /** Escape hatch for repository subclasses: a `WHERE …` clause over this table. */
  protected query(where: string, params: readonly ColumnValue[]): readonly T[] {
    const rows = this.ctx.db
      .prepare(`SELECT payload FROM ${quote(this.spec.table)} ${where} ORDER BY createdAt, id`)
      .all(...params) as unknown as StoredRow[];
    return rows.map((row) => JSON.parse(row.payload) as T);
  }

  count(): number {
    const row = this.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${quote(this.spec.table)}`).get() as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  }

  /** Fill in envelope fields the store owns. Append-only pins `updatedAt`. */
  protected normalise(record: T): T {
    const createdAt = record.createdAt || this.ctx.now();
    const updatedAt = this.spec.appendOnly ? createdAt : record.updatedAt || createdAt;
    return { ...record, createdAt, updatedAt } as T;
  }
}

/** Mutable tables additionally expose `update` and `delete`, both audited. */
export class MutableRepository<T extends MutableRecord<string>> extends AppendOnlyRepository<T> {
  /**
   * Apply a partial patch. `patch` never contains envelope fields — those are
   * owned by the store. Returns the updated record.
   */
  update(id: string, patch: Partial<Omit<T, "id" | "createdAt" | "updatedAt" | "schemaVersion" | "kind">>): T {
    return this.ctx.write(() => {
      const before = this.require(id);
      const candidate = { ...before, ...patch, updatedAt: this.ctx.now() } as T;
      const after = this.beforeUpdate(before, candidate, patch as Partial<T>);
      const assignments = [
        "updatedAt = ?",
        ...this.spec.columns.map((c) => `${quote(c)} = ?`),
        "payload = ?",
      ].join(", ");
      const extracted = this.spec.extract(after);
      const values: ColumnValue[] = [
        after.updatedAt,
        ...this.spec.columns.map((c) => extracted[c] ?? null),
        canonicalJson(after),
        id,
      ];
      this.ctx.db.prepare(`UPDATE ${quote(this.spec.table)} SET ${assignments} WHERE id = ?`).run(...values);
      this.ctx.audit?.record({
        table: this.spec.table,
        recordId: id,
        operation: "update",
        beforeHash: hashRecord(before),
        afterHash: hashRecord(after),
        workflowId: this.spec.workflowIdOf(after),
        actor: this.ctx.actor(),
      });
      return after;
    });
  }

  /** Delete a row; cascades are enforced by the database. Audited. */
  delete(id: string): void {
    this.ctx.write(() => {
      const before = this.require(id);
      this.ctx.db.prepare(`DELETE FROM ${quote(this.spec.table)} WHERE id = ?`).run(id);
      this.ctx.audit?.record({
        table: this.spec.table,
        recordId: id,
        operation: "delete",
        beforeHash: hashRecord(before),
        afterHash: hashRecord(null),
        workflowId: this.spec.workflowIdOf(before),
        actor: this.ctx.actor(),
      });
    });
  }

  /**
   * Record-specific rules run inside the update transaction. The default
   * rejects nothing; subclasses override to enforce docs/records.md §4/§5.
   */
  protected beforeUpdate(_before: T, candidate: T, _patch: Partial<T>): T {
    return candidate;
  }

  /** Helper for subclasses that need to reject a patch with a clear message. */
  protected reject(message: string): never {
    throw new RecordRuleError(message);
  }
}

/** Compile-time guard: an append-only record may never reach `MutableRepository`. */
export type NotAppendOnly<T> = T extends AppendOnlyRecord<string> ? never : T;
