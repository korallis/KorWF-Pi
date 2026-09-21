/**
 * Coordinator lockfile (issue #23; ADR 0006 rule 1).
 *
 * Exactly one process may hold a write connection to the store. Ownership is
 * expressed by `<store>/korwf.lock`, created with `O_EXCL` so creation is
 * atomic even on a shared filesystem that has no advisory locking.
 *
 * Contents: `{ pid, startedAt, hostHash, packageVersion }`. The host is
 * stored as a salted hash, never as a hostname: the lockfile lives in the
 * user's repository and a machine name is user data (docs/threat-model.md).
 *
 * A lockfile whose pid is dead is stale. A stale lock may be taken over; the
 * takeover is recorded in the audit table by the caller (`openStore`), which
 * also runs reconciliation before accepting any command.
 */
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { LockfileCorruptError, StoreLockedError } from "./errors.ts";

/** Shape written to `korwf.lock`. */
export interface LockfileContents {
  readonly pid: number;
  readonly startedAt: string;
  /** Salted SHA-256 of the hostname, truncated. Never the hostname itself. */
  readonly hostHash: string;
  readonly packageVersion: string;
}

/** How the lock was obtained. */
export type LockAcquisitionKind = "created" | "took_over_stale";

export interface LockHandle {
  readonly path: string;
  readonly contents: LockfileContents;
  readonly kind: LockAcquisitionKind;
  /** Details of the dead holder when `kind === "took_over_stale"`. */
  readonly previousHolder: LockfileContents | null;
  /** Remove the lockfile. Idempotent. */
  release(): void;
}

export interface AcquireLockOptions {
  readonly pid?: number;
  readonly packageVersion?: string;
  readonly now?: () => string;
  /** Total time to wait for a live holder to release (config `storage.lockTimeoutMs`). */
  readonly timeoutMs?: number;
  /** Polling interval while waiting. */
  readonly pollIntervalMs?: number;
  /** Liveness probe; defaults to `process.kill(pid, 0)`. Injected in tests. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Sleep used between polls; injected so tests do not actually wait. */
  readonly sleep?: (ms: number) => void;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 50;

/** Is a process with this pid running and signalable by us? */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user: still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Hash the host so the lockfile never carries a machine name. */
export function hashHost(hostname: string): string {
  return createHash("sha256").update(`korwf-lock:${hostname}`).digest("hex").slice(0, 16);
}

/** Read and validate a lockfile. Throws `LockfileCorruptError` if unusable. */
export function readLockfile(path: string): LockfileContents {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new LockfileCorruptError(path, (error as Error).message);
  }
  return parseLockfile(path, raw);
}

function parseLockfile(path: string, raw: string): LockfileContents {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LockfileCorruptError(path, "not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new LockfileCorruptError(path, "not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record["pid"] !== "number" || !Number.isInteger(record["pid"])) {
    throw new LockfileCorruptError(path, "missing integer `pid`");
  }
  if (typeof record["startedAt"] !== "string") {
    throw new LockfileCorruptError(path, "missing `startedAt`");
  }
  return {
    pid: record["pid"],
    startedAt: record["startedAt"],
    hostHash: typeof record["hostHash"] === "string" ? record["hostHash"] : "",
    packageVersion: typeof record["packageVersion"] === "string" ? record["packageVersion"] : "",
  };
}

function writeExclusive(path: string, contents: LockfileContents): boolean {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(contents, null, 2));
  } finally {
    closeSync(fd);
  }
  return true;
}

function sleepSync(ms: number): void {
  // Blocking sleep: acquiring the lock happens before the store is usable, and
  // the writer must not proceed concurrently with its own wait loop.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire the coordinator lock, waiting up to `timeoutMs` for a live holder.
 *
 * Throws `StoreLockedError` naming the holder's pid when the wait expires.
 * Takes over a lockfile whose pid is dead, reporting `kind: "took_over_stale"`
 * so the caller can write the audit row ADR 0006 rule 1 requires.
 */
export function acquireLock(path: string, options: AcquireLockOptions = {}): LockHandle {
  const alive = options.isProcessAlive ?? isProcessAlive;
  const sleep = options.sleep ?? sleepSync;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? (() => new Date().toISOString());
  const contents: LockfileContents = {
    pid: options.pid ?? process.pid,
    startedAt: now(),
    hostHash: hashHost(hostnameOrEmpty()),
    packageVersion: options.packageVersion ?? "",
  };

  let waited = 0;
  let previousHolder: LockfileContents | null = null;
  for (;;) {
    if (writeExclusive(path, contents)) {
      return makeHandle(path, contents, previousHolder === null ? "created" : "took_over_stale", previousHolder);
    }
    const holder = readHolderOrTreatAsStale(path);
    if (holder === null || !alive(holder.pid)) {
      // Stale (dead pid, or an unreadable lockfile left by a crash): take over.
      previousHolder = holder;
      rmSync(path, { force: true });
      continue;
    }
    if (waited >= timeoutMs) throw new StoreLockedError(path, holder.pid, waited);
    const step = Math.min(pollIntervalMs, timeoutMs - waited);
    sleep(step);
    waited += step;
  }
}

function readHolderOrTreatAsStale(path: string): LockfileContents | null {
  try {
    return readLockfile(path);
  } catch {
    return null;
  }
}

function hostnameOrEmpty(): string {
  try {
    // Imported lazily so this module has no side effects at load time.
    return process.env["HOSTNAME"] ?? "";
  } catch {
    return "";
  }
}

function makeHandle(
  path: string,
  contents: LockfileContents,
  kind: LockAcquisitionKind,
  previousHolder: LockfileContents | null,
): LockHandle {
  let released = false;
  return {
    path,
    contents,
    kind,
    previousHolder,
    release(): void {
      if (released) return;
      released = true;
      // Only remove the file if it is still ours: a takeover by another
      // process must not have its lock deleted by our shutdown.
      try {
        const current = readLockfile(path);
        if (current.pid !== contents.pid || current.startedAt !== contents.startedAt) return;
      } catch {
        return;
      }
      rmSync(path, { force: true });
    },
  };
}
