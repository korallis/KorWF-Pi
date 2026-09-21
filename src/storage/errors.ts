/**
 * Error types for the KorWF store (issue #23, ADR 0006).
 *
 * Every failure a caller can reasonably act on has its own class and a
 * stable `code`, so the extension can print a clear message instead of a
 * SQLite string. Messages never contain credentials; paths are included
 * because they are the user's own project paths.
 */

/** Base class so callers can `instanceof StoreError` for anything from `src/storage/`. */
export class StoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * Another live process holds `<store>/korwf.lock` (ADR 0006 rule 1).
 * The caller may still open a read-only connection.
 */
export class StoreLockedError extends StoreError {
  readonly holderPid: number;
  readonly lockfilePath: string;

  constructor(lockfilePath: string, holderPid: number, waitedMs: number) {
    super(
      "KORWF_STORE_LOCKED",
      `The KorWF store is already open for writing by process ${holderPid} ` +
        `(lockfile ${lockfilePath}); waited ${waitedMs}ms. ` +
        `Only one coordinator may write at a time — open the store read-only instead.`,
    );
    this.holderPid = holderPid;
    this.lockfilePath = lockfilePath;
  }
}

/** The lockfile exists but its contents are not a lockfile this version understands. */
export class LockfileCorruptError extends StoreError {
  constructor(lockfilePath: string, detail: string) {
    super("KORWF_LOCKFILE_CORRUPT", `Lockfile ${lockfilePath} is unreadable: ${detail}`);
  }
}

/** The database was written by a newer package version (ADR 0006 rule 4). */
export class SchemaTooNewError extends StoreError {
  readonly storeVersion: number;
  readonly knownVersion: number;

  constructor(storeVersion: number, knownVersion: number) {
    super(
      "KORWF_SCHEMA_TOO_NEW",
      `The store is at schema version ${storeVersion} but this package only knows ` +
        `version ${knownVersion}. Upgrade korwf before opening this project.`,
    );
    this.storeVersion = storeVersion;
    this.knownVersion = knownVersion;
  }
}

/** A migration failed; the transaction was rolled back and the version is unchanged. */
export class MigrationFailedError extends StoreError {
  readonly version: number;

  constructor(version: number, detail: string) {
    super(
      "KORWF_MIGRATION_FAILED",
      `Migration ${version} failed and was rolled back; the store is unchanged: ${detail}`,
    );
    this.version = version;
  }
}

/** A write was rejected by a record rule (append-only, frozen attempt, revision rule). */
export class RecordRuleError extends StoreError {
  constructor(message: string) {
    super("KORWF_RECORD_RULE", message);
  }
}

/** A read-only connection was asked to write. */
export class ReadOnlyStoreError extends StoreError {
  constructor(operation: string) {
    super("KORWF_STORE_READONLY", `This store handle is read-only; ${operation} is not available.`);
  }
}

/** A referenced row does not exist. */
export class RecordNotFoundError extends StoreError {
  constructor(table: string, id: string) {
    super("KORWF_RECORD_NOT_FOUND", `No ${table} row with id ${id}.`);
  }
}
