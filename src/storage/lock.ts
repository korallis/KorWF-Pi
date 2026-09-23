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
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { LockfileCorruptError, StoreLockedError } from "./errors.ts";

/** Shape written to `korwf.lock`. */
export interface LockfileContents {
  readonly pid: number;
  readonly startedAt: string;
  /** Salted SHA-256 of the hostname, truncated. Never the hostname itself. */
  readonly hostHash: string;
  readonly packageVersion: string;
  /**
   * Opaque identifier of the session that holds the lock, so a denial can
   * name the session and not only a pid (issue #77). Empty when the writer
   * did not supply one — older lockfiles have no such field.
   */
  readonly sessionId?: string;
  /**
   * Last time the holder proved it was still running (issue #77). Absent on
   * store locks, which do not heartbeat. A stale heartbeat on its own is
   * never grounds for eviction: see `classifyHolder`.
   */
  readonly heartbeatAt?: string;
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
  /** Recorded in the lockfile so a denial can name the session (#77). */
  readonly sessionId?: string;
  /** Seed `heartbeatAt` when the holder intends to heartbeat (#77). */
  readonly heartbeat?: boolean;
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
  return createHash("sha256")
    .update(`korwf-lock:${hostname}`)
    .digest("hex")
    .slice(0, 16);
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
    packageVersion:
      typeof record["packageVersion"] === "string"
        ? record["packageVersion"]
        : "",
    ...(typeof record["sessionId"] === "string"
      ? { sessionId: record["sessionId"] }
      : {}),
    ...(typeof record["heartbeatAt"] === "string"
      ? { heartbeatAt: record["heartbeatAt"] }
      : {}),
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
export function acquireLock(
  path: string,
  options: AcquireLockOptions = {},
): LockHandle {
  const alive = options.isProcessAlive ?? isProcessAlive;
  const sleep = options.sleep ?? sleepSync;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const contents: LockfileContents = {
    pid: options.pid ?? process.pid,
    startedAt,
    hostHash: hashHost(hostnameOrEmpty()),
    packageVersion: options.packageVersion ?? "",
    ...(options.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId }),
    ...(options.heartbeat === true ? { heartbeatAt: startedAt } : {}),
  };

  let waited = 0;
  let tookOver = false;
  let previousHolder: LockfileContents | null = null;
  for (;;) {
    if (writeExclusive(path, contents)) {
      return makeHandle(
        path,
        contents,
        tookOver ? "took_over_stale" : "created",
        previousHolder,
      );
    }
    const holder = readHolderOrTreatAsStale(path);
    if (holder === null || !alive(holder.pid)) {
      // Stale (dead pid, or an unreadable lockfile left by a crash): take over.
      tookOver = true;
      previousHolder = holder;
      rmSync(path, { force: true });
      continue;
    }
    if (waited >= timeoutMs)
      throw new StoreLockedError(path, holder.pid, waited);
    const step = Math.min(pollIntervalMs, timeoutMs - waited);
    sleep(step);
    waited += step;
  }
}

// ---------------------------------------------------------------------------
// Heartbeat and liveness (issue #77)
// ---------------------------------------------------------------------------

/** How a lock holder looks to a process that wants the lock. */
export type HolderLiveness = "alive" | "alive_heartbeat_stale" | "dead";

/** What a would-be owner learned about the current holder. */
export interface HolderAssessment {
  readonly liveness: HolderLiveness;
  /** Result of the pid probe. This, and only this, decides `mayTakeOver`. */
  readonly pidAlive: boolean;
  /** Age of `heartbeatAt` in ms; `null` when the lockfile carries no heartbeat. */
  readonly heartbeatAgeMs: number | null;
  /** `heartbeatAgeMs` exceeds the staleness window. Diagnostic only. */
  readonly heartbeatStale: boolean;
  /** True only when the pid is dead. A stale heartbeat alone never sets this. */
  readonly mayTakeOver: boolean;
}

export interface ClassifyHolderOptions {
  /** Liveness probe; defaults to `process.kill(pid, 0)`. Injected in tests. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Current time in ms since the epoch; injected so tests use a fake clock. */
  readonly nowMs?: number;
  /** Heartbeat older than this counts as stale (diagnostic). */
  readonly staleAfterMs?: number;
}

/**
 * Assess a lock holder.
 *
 * `mayTakeOver` is `!pidAlive` and nothing else: a live owner is never
 * evicted, however long ago it last wrote a heartbeat, because a paused,
 * swapped-out or simply busy coordinator is still the owner. The heartbeat
 * age is reported so the caller can say *why* a dead owner's lock looked
 * abandoned, and so a live-but-silent owner can be flagged to the user
 * without being displaced (ADR 0006 rule 1).
 */
export function classifyHolder(
  contents: LockfileContents,
  options: ClassifyHolderOptions = {},
): HolderAssessment {
  const alive = (options.isProcessAlive ?? isProcessAlive)(contents.pid);
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_HEARTBEAT_STALE_MS;
  const beat =
    contents.heartbeatAt === undefined
      ? null
      : Date.parse(contents.heartbeatAt);
  const heartbeatAgeMs =
    beat === null || Number.isNaN(beat) ? null : nowMs - beat;
  const heartbeatStale =
    heartbeatAgeMs !== null && heartbeatAgeMs > staleAfterMs;
  return {
    liveness: alive
      ? heartbeatStale
        ? "alive_heartbeat_stale"
        : "alive"
      : "dead",
    pidAlive: alive,
    heartbeatAgeMs,
    heartbeatStale,
    mayTakeOver: !alive,
  };
}

/** Default heartbeat write interval: the holder refreshes this often. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
/** Default staleness window: `DEFAULT_HEARTBEAT_STALE_MULTIPLIER` intervals. */
export const DEFAULT_HEARTBEAT_STALE_MULTIPLIER = 6;
export const DEFAULT_HEARTBEAT_STALE_MS =
  DEFAULT_HEARTBEAT_INTERVAL_MS * DEFAULT_HEARTBEAT_STALE_MULTIPLIER;

/**
 * Refresh the heartbeat in an existing lockfile.
 *
 * Rewrites the file only when it still names `contents`' pid and start time,
 * so a process whose lock was taken over while it was stopped cannot stamp
 * its heartbeat onto the new owner's lockfile. Returns `false` in that case.
 */
export function writeHeartbeat(
  path: string,
  contents: LockfileContents,
  at: string,
): LockfileContents | null {
  let current: LockfileContents;
  try {
    current = readLockfile(path);
  } catch {
    return null;
  }
  if (current.pid !== contents.pid || current.startedAt !== contents.startedAt)
    return null;
  const next: LockfileContents = { ...current, heartbeatAt: at };
  writeFileSync(path, JSON.stringify(next, null, 2));
  return next;
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
        if (
          current.pid !== contents.pid ||
          current.startedAt !== contents.startedAt
        )
          return;
      } catch {
        return;
      }
      rmSync(path, { force: true });
    },
  };
}
