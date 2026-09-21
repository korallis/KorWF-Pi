/**
 * SQLite store, migrations, lockfile, artifacts (KorWF-Pi module, see
 * docs/adr/0002-source-layout.md and docs/adr/0006-sqlite-single-writer.md).
 *
 * This is the only module in the package that imports a SQLite driver
 * (`node:sqlite`). Domain modules use the typed repositories on `Store`;
 * they never hold a raw connection.
 */
export {
  DEFAULT_STORAGE_DIR_NAME,
  resolveStorageRoot,
  resolveDatabasePath,
  resolveLockfilePath,
  resolveArtifactDir,
} from "./paths.ts";

export { Store, openStore, openStoreReadOnly, STORE_DRIVER, latestSchemaVersion } from "./db.ts";
export type { OpenStoreOptions, OpenStoreReport } from "./db.ts";

export {
  acquireLock,
  hashHost,
  isProcessAlive,
  readLockfile,
  DEFAULT_LOCK_TIMEOUT_MS,
} from "./lock.ts";
export type { LockHandle, LockfileContents, AcquireLockOptions } from "./lock.ts";

export {
  appliedMigrations,
  currentSchemaVersion,
  loadMigrations,
  migrate,
  MIGRATIONS_DIR,
} from "./migrations.ts";
export type { Migration, AppliedMigration, MigrateResult } from "./migrations.ts";

export { ArtifactStore, artifactRelativePath, MANIFEST_NAME, sha256 } from "./artifacts.ts";
export { DecisionCacheStore } from "./decision-cache.ts";
export type { DecisionCacheRow } from "./decision-cache.ts";
export { DecisionTraceStore } from "./trace-store.ts";
export type { ArtifactManifest, ArtifactManifestEntry } from "./artifacts.ts";

export {
  ABANDONED_OUTCOME,
  LEDGER_ABANDONED_REASON,
  assumeWorkersGone,
  reconcileAbandonedAttempts,
  reconcileOpenReservations,
} from "./reconcile.ts";
export type {
  AbandonedReservationRow,
  ReconcileOptions,
  ReconcileReservationsOptions,
  ReconciledAttempt,
  ReconciliationReport,
  WorkerLiveness,
  WorkerProbe,
} from "./reconcile.ts";

export {
  LockfileCorruptError,
  MigrationFailedError,
  ReadOnlyStoreError,
  RecordNotFoundError,
  RecordRuleError,
  SchemaTooNewError,
  StoreError,
  StoreLockedError,
} from "./errors.ts";

export { TABLE_SPECS } from "./repos/specs.ts";
export {
  ApprovalRepository,
  AttemptRepository,
  AuditRepository,
  DecisionRepository,
  EvidenceRepository,
  LedgerRepository,
  MemoryRepository,
  ModelAvailabilityRepository,
  ModelOutcomeRepository,
  PhaseRepository,
  TaskRepository,
  WorkflowRepository,
} from "./repos/index.ts";

export type { LedgerScopeColumn, LedgerTotals } from "./repos/index.ts";

export type { RecordTypes, RecordTable, AnyRecord } from "./records.ts";
