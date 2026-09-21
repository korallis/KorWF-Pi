/**
 * The KorWF store (issue #23; ADR 0006).
 *
 * Driver: **`node:sqlite`**, built into Node ≥ 22.5 and therefore available
 * under this package's `engines.node: ">=22.6"` floor with no native build
 * step and no new dependency. The choice is recorded in
 * `docs/adr/0006-sqlite-single-writer.md`; nothing outside `src/storage/`
 * imports it.
 *
 * Exactly one process holds a write connection, proved by `<store>/korwf.lock`
 * (`src/storage/lock.ts`). A second process either waits, fails with a clear
 * `StoreLockedError`, or opens read-only. Workers never open the store at all
 * (ADR 0006 rule 2) — the store path is not on their command line.
 */
import { mkdirSync } from "node:fs";
import { DatabaseSync, type Database } from "./sqlite.ts";
import { ReadOnlyStoreError } from "./errors.ts";
import { acquireLock, DEFAULT_LOCK_TIMEOUT_MS, type AcquireLockOptions, type LockHandle } from "./lock.ts";
import { currentSchemaVersion, latestSchemaVersion, migrate, type MigrateResult } from "./migrations.ts";
import { resolveArtifactDir, resolveDatabasePath, resolveLockfilePath } from "./paths.ts";
import { ArtifactStore } from "./artifacts.ts";
import { reconcileAbandonedAttempts, type ReconcileOptions, type ReconciliationReport } from "./reconcile.ts";
import type { AuditEntry, AuditEntryId, IsoTimestamp, RecordTable, WorkflowId } from "./records.ts";
import { RECORDS_SCHEMA_VERSION } from "./records.ts";
import { hashRecord, type AuditSink, type RepoContext } from "./repos/base.ts";
import {
  ApprovalRepository,
  AttemptRepository,
  AuditRepository,
  DecisionRepository,
  EvidenceRepository,
  MemoryRepository,
  ModelAvailabilityRepository,
  ModelOutcomeRepository,
  PhaseRepository,
  TaskRepository,
  WorkflowRepository,
} from "./repos/index.ts";

/** Driver identity, asserted by a test so the ADR and the code cannot drift. */
export const STORE_DRIVER = "node:sqlite" as const;

export interface OpenStoreOptions {
  /** Storage root, from `resolveStorageRoot` (issue #19). */
  readonly storageRoot: string;
  /** `false` opens a read-only connection and takes no lock (ADR 0006 rule 3). */
  readonly writable?: boolean;
  /** Wait this long for a live lock holder before failing. */
  readonly lockTimeoutMs?: number;
  /** Actor recorded on audit rows written by this session. */
  readonly actor?: string;
  readonly packageVersion?: string;
  readonly now?: () => IsoTimestamp;
  /** Id factory; injected in tests for deterministic audit ids. */
  readonly newId?: () => string;
  /** Skip startup reconciliation (used by tests that install a probe later). */
  readonly reconcile?: ReconcileOptions | false;
  /** Lock options (liveness probe, sleep) — injected by tests. */
  readonly lock?: AcquireLockOptions;
}

/** What happened while opening. */
export interface OpenStoreReport {
  readonly migrations: MigrateResult;
  readonly lock: { readonly kind: LockHandle["kind"]; readonly pid: number } | null;
  readonly reconciliation: ReconciliationReport | null;
}

let idCounter = 0;
function defaultNewId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${idCounter.toString(36)}`;
}

/**
 * A single writer's handle on the store, or a read-only reader.
 *
 * Every mutating call goes through `write()`, which wraps the work in
 * `BEGIN IMMEDIATE` so a gate predicate always sees a consistent snapshot
 * (ADR 0006 rule 6). Nested `write()` calls join the outer transaction.
 */
export class Store {
  readonly storageRoot: string;
  readonly databasePath: string;
  readonly writable: boolean;
  readonly artifacts: ArtifactStore;

  readonly workflows: WorkflowRepository;
  readonly phases: PhaseRepository;
  readonly tasks: TaskRepository;
  readonly attempts: AttemptRepository;
  readonly decisions: DecisionRepository;
  readonly evidence: EvidenceRepository;
  readonly approvals: ApprovalRepository;
  readonly memories: MemoryRepository;
  readonly modelAvailability: ModelAvailabilityRepository;
  readonly modelOutcomes: ModelOutcomeRepository;
  readonly audit: AuditRepository;

  readonly #db: Database;
  readonly #lock: LockHandle | null;
  readonly #now: () => IsoTimestamp;
  readonly #newId: () => string;
  #actor: string;
  #depth = 0;
  #closed = false;

  constructor(params: {
    db: Database;
    storageRoot: string;
    databasePath: string;
    writable: boolean;
    lock: LockHandle | null;
    now: () => IsoTimestamp;
    newId: () => string;
    actor: string;
  }) {
    this.#db = params.db;
    this.#lock = params.lock;
    this.#now = params.now;
    this.#newId = params.newId;
    this.#actor = params.actor;
    this.storageRoot = params.storageRoot;
    this.databasePath = params.databasePath;
    this.writable = params.writable;
    this.artifacts = new ArtifactStore(resolveArtifactDir(params.storageRoot), { now: params.now });

    const auditCtx: RepoContext = this.#context(null);
    this.audit = new AuditRepository(auditCtx);
    const sink: AuditSink = { record: (entry) => this.#writeAuditRow(entry) };
    const ctx = this.#context(sink);

    this.workflows = new WorkflowRepository(ctx);
    this.phases = new PhaseRepository(ctx);
    this.tasks = new TaskRepository(ctx);
    this.attempts = new AttemptRepository(ctx);
    this.decisions = new DecisionRepository(ctx);
    this.evidence = new EvidenceRepository(ctx);
    this.approvals = new ApprovalRepository(ctx);
    this.memories = new MemoryRepository(ctx);
    this.modelAvailability = new ModelAvailabilityRepository(ctx);
    this.modelOutcomes = new ModelOutcomeRepository(ctx);
  }

  #context(audit: AuditSink | null): RepoContext {
    return {
      db: this.#db,
      now: () => this.#now(),
      actor: () => this.#actor,
      audit,
      write: (fn) => this.write(fn),
    };
  }

  /** Raw connection, for migrations and the schema-drift test only. */
  get connection(): Database {
    return this.#db;
  }

  get schemaVersion(): number {
    return currentSchemaVersion(this.#db);
  }

  /** Lockfile pid this session holds, or `null` for a read-only handle. */
  get lockHolderPid(): number | null {
    return this.#lock?.contents.pid ?? null;
  }

  /** Change the actor recorded on subsequent audit rows (e.g. "user" vs a role). */
  setActor(actor: string): void {
    this.#actor = actor;
  }

  /**
   * Run `fn` inside the single serialised write transaction. Nested calls
   * join the outer transaction rather than starting a new one.
   */
  write<R>(fn: () => R): R {
    if (!this.writable) throw new ReadOnlyStoreError("writing");
    if (this.#depth > 0) {
      this.#depth += 1;
      try {
        return fn();
      } finally {
        this.#depth -= 1;
      }
    }
    this.#db.exec("BEGIN IMMEDIATE");
    this.#depth = 1;
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Already rolled back by SQLite.
      }
      throw error;
    } finally {
      this.#depth = 0;
    }
  }

  /** Write an audit row directly (policy decisions, lock takeover, and so on). */
  recordAudit(entry: {
    readonly table: RecordTable;
    readonly recordId: string;
    readonly operation: AuditEntry["operation"];
    readonly beforeHash?: string | null;
    readonly afterHash: string;
    readonly workflowId?: string | null;
    readonly actor?: string;
  }): AuditEntry {
    return this.write(() =>
      this.#writeAuditRow({
        table: entry.table,
        recordId: entry.recordId,
        operation: entry.operation,
        beforeHash: entry.beforeHash ?? null,
        afterHash: entry.afterHash,
        workflowId: entry.workflowId ?? null,
        actor: entry.actor ?? this.#actor,
      }),
    );
  }

  #writeAuditRow(entry: {
    table: RecordTable;
    recordId: string;
    operation: AuditEntry["operation"];
    beforeHash: string | null;
    afterHash: string;
    workflowId: string | null;
    actor: string;
  }): AuditEntry {
    const at = this.#now();
    return this.audit.insert({
      id: this.#newId() as AuditEntryId,
      createdAt: at,
      updatedAt: at,
      schemaVersion: RECORDS_SCHEMA_VERSION,
      kind: "append_only",
      workflowId: entry.workflowId as WorkflowId | null,
      table: entry.table,
      recordId: entry.recordId,
      operation: entry.operation,
      beforeHash: entry.beforeHash,
      afterHash: entry.afterHash,
      actor: entry.actor,
    });
  }

  /** Reconcile attempts left open by a previous session (ADR 0006 rule 7). */
  reconcile(options: ReconcileOptions = {}): ReconciliationReport {
    if (!this.writable) throw new ReadOnlyStoreError("reconciliation");
    const actor = options.actor ?? "korwf:reconciler";
    const previous = this.#actor;
    this.#actor = actor;
    try {
      return this.write(() =>
        reconcileAbandonedAttempts(
          { attempts: this.attempts, audit: this.audit },
          { ...options, now: options.now ?? (() => this.#now()) },
        ),
      );
    } finally {
      this.#actor = previous;
    }
  }

  /** Close the connection and release the lock. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#db.close();
    } finally {
      this.#lock?.release();
    }
  }
}

/**
 * Open the store: create the storage root, take the lock (when writable),
 * migrate forward, then reconcile abandoned attempts before returning.
 */
export function openStore(options: OpenStoreOptions): { store: Store; report: OpenStoreReport } {
  const writable = options.writable !== false;
  const storageRoot = options.storageRoot;
  const databasePath = resolveDatabasePath(storageRoot);
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? defaultNewId;
  mkdirSync(storageRoot, { recursive: true });
  mkdirSync(resolveArtifactDir(storageRoot), { recursive: true });

  let lock: LockHandle | null = null;
  if (writable) {
    lock = acquireLock(resolveLockfilePath(storageRoot), {
      timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      packageVersion: options.packageVersion ?? "",
      now,
      ...options.lock,
    });
  }

  let db: Database;
  try {
    db = new DatabaseSync(databasePath, writable ? {} : { readOnly: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    lock?.release();
    throw error;
  }

  let migrations: MigrateResult;
  try {
    migrations = writable
      ? migrate(db, { now: now() })
      : { fromVersion: currentSchemaVersion(db), toVersion: currentSchemaVersion(db), applied: [] };
  } catch (error) {
    db.close();
    lock?.release();
    throw error;
  }

  const store = new Store({
    db,
    storageRoot,
    databasePath,
    writable,
    lock,
    now,
    newId,
    actor: options.actor ?? "korwf:coordinator",
  });

  // A stale lock was taken over: record it before anything else happens, so
  // the audit trail shows which pid's session was displaced (ADR 0006 rule 1).
  if (lock !== null && lock.kind === "took_over_stale") {
    store.recordAudit({
      table: "audit_entry",
      recordId: `lock:${lock.contents.pid}`,
      operation: "insert",
      beforeHash: lock.previousHolder === null ? null : hashRecord(lock.previousHolder),
      afterHash: hashRecord(lock.contents),
      actor: "korwf:lock",
    });
  }

  const reconciliation =
    writable && options.reconcile !== false ? store.reconcile(options.reconcile ?? {}) : null;

  return {
    store,
    report: {
      migrations,
      lock: lock === null ? null : { kind: lock.kind, pid: lock.contents.pid },
      reconciliation,
    },
  };
}

/** Open a read-only handle; never takes the lock, never migrates. */
export function openStoreReadOnly(storageRoot: string): Store {
  return openStore({ storageRoot, writable: false }).store;
}

export { latestSchemaVersion };
