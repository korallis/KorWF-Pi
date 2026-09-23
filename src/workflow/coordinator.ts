/**
 * Coordinator lock (issue #77; PLAN §5 "lockfile for coordinator ownership",
 * PLAN §8 Stage 6; ADR 0006 rule 1).
 *
 * The store lock (#23, `src/storage/lock.ts`) protects the *database*. This
 * one protects the right to **schedule**: two `/korwf run` invocations in one
 * repository must not both dispatch work. They are separate files under the
 * storage root because they answer different questions — a session may hold a
 * write connection (migrations, `/korwf status` writes, intake) without ever
 * running the scheduler, and a `/korwf run` that cannot schedule should say so
 * in those terms rather than "the store is locked".
 *
 * Built on the same `O_EXCL` primitive as the store lock rather than a second
 * implementation: `acquireLock` already denies a second writer by pid, takes
 * over a lockfile whose pid is dead, and reports which of the two happened.
 * What this module adds is what Stage 6 asked for:
 *
 * - a **heartbeat** the holder refreshes on an interval, so a stalled owner is
 *   visible;
 * - a refusal that names the **session and start time** of the live holder;
 * - a takeover that is **audited** and hands the caller the reconciliation
 *   report for the dead owner's abandoned attempts.
 *
 * Staleness never breaks a lock on its own. The eviction test is the pid probe
 * (`classifyHolder().mayTakeOver === !pidAlive`); the heartbeat age only
 * explains a dead owner and flags a live-but-silent one.
 */
import type { Store } from "../storage/db.ts";
import {
  acquireLock,
  classifyHolder,
  readLockfile,
  writeHeartbeat,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_STALE_MULTIPLIER,
  type HolderAssessment,
  type LockfileContents,
  type LockHandle,
} from "../storage/lock.ts";
import { resolveCoordinatorLockPath } from "../storage/paths.ts";
import { StoreLockedError } from "../storage/errors.ts";
import type { ReconciliationReport } from "../storage/reconcile.ts";

/** How the coordinator lock was obtained. */
export type CoordinatorAcquisition = "created" | "took_over_stale";

/** An owned right to schedule. Release it when the run stops. */
export interface CoordinatorLease {
  readonly path: string;
  readonly contents: LockfileContents;
  readonly acquisition: CoordinatorAcquisition;
  /** The dead owner that was displaced, when `acquisition === "took_over_stale"`. */
  readonly previousOwner: LockfileContents | null;
  /** Reconciliation run after a takeover; `null` when nothing was taken over. */
  readonly reconciliation: ReconciliationReport | null;
  /** Milliseconds between heartbeats; the staleness window is a multiple of it. */
  readonly heartbeatIntervalMs: number;
  /** Write a heartbeat now. `false` once the lease no longer owns the file. */
  heartbeat(): boolean;
  /** Start writing heartbeats on a timer. Returns a stop function. */
  startHeartbeat(): () => void;
  /** Give up scheduling rights. Idempotent; never removes another owner's lock. */
  release(): void;
}

export interface AcquireCoordinatorOptions {
  /** Storage root (`<project>/.korwf`), from `resolveStorageRoot`. */
  readonly storageRoot: string;
  /**
   * Writable store. Used to audit a takeover and to reconcile the dead
   * owner's abandoned attempts. Omit only in tests of the lock mechanics.
   */
  readonly store?: Store;
  /** Opaque session identifier printed to the user when a run is refused. */
  readonly sessionId?: string;
  readonly pid?: number;
  readonly packageVersion?: string;
  /** ISO clock; injected so tests do not depend on wall time. */
  readonly now?: () => string;
  /** Epoch-ms clock used for heartbeat ages; defaults to `Date.parse(now())`. */
  readonly nowMs?: () => number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatStaleMultiplier?: number;
  /** Liveness probe; defaults to `process.kill(pid, 0)`. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Timer factory, injected so tests need no real timers. */
  readonly setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  readonly clearInterval?: (handle: unknown) => void;
}

/** Raised when another *live* coordinator already owns scheduling. */
export class CoordinatorActiveError extends Error {
  readonly code = "KORWF_COORDINATOR_ACTIVE";
  readonly holder: LockfileContents;
  readonly assessment: HolderAssessment;
  readonly lockPath: string;

  constructor(lockPath: string, holder: LockfileContents, assessment: HolderAssessment) {
    super(describeActiveHolder(holder, assessment));
    this.name = "CoordinatorActiveError";
    this.lockPath = lockPath;
    this.holder = holder;
    this.assessment = assessment;
  }
}

/** The message a second `/korwf run` prints (AC: "coordinator active in session X since T"). */
export function describeActiveHolder(
  holder: LockfileContents,
  assessment: HolderAssessment,
): string {
  const session = holder.sessionId === undefined || holder.sessionId === "" ? `pid ${holder.pid}` : holder.sessionId;
  const base = `Coordinator active in session ${session} since ${holder.startedAt} (pid ${holder.pid}).`;
  const tail =
    assessment.liveness === "alive_heartbeat_stale"
      ? ` Its last heartbeat was ${assessment.heartbeatAgeMs}ms ago, but the process is still running, so it keeps the lock.`
      : "";
  return `${base}${tail} Only one coordinator may schedule per project; stop that run before starting another.`;
}

/**
 * Inspect the coordinator lock without taking it.
 *
 * Returns `null` when no coordinator holds it (no file, or a file whose
 * contents cannot be parsed — a crash mid-write leaves no owner to protect).
 */
export function inspectCoordinator(
  options: Pick<
    AcquireCoordinatorOptions,
    "storageRoot" | "isProcessAlive" | "nowMs" | "heartbeatIntervalMs" | "heartbeatStaleMultiplier"
  >,
): { readonly holder: LockfileContents; readonly assessment: HolderAssessment } | null {
  const path = resolveCoordinatorLockPath(options.storageRoot);
  let holder: LockfileContents;
  try {
    holder = readLockfile(path);
  } catch {
    return null;
  }
  return { holder, assessment: assess(holder, options) };
}

function assess(
  holder: LockfileContents,
  options: Pick<
    AcquireCoordinatorOptions,
    "isProcessAlive" | "nowMs" | "heartbeatIntervalMs" | "heartbeatStaleMultiplier"
  >,
): HolderAssessment {
  const intervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const multiplier = options.heartbeatStaleMultiplier ?? DEFAULT_HEARTBEAT_STALE_MULTIPLIER;
  return classifyHolder(holder, {
    ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
    nowMs: (options.nowMs ?? (() => Date.now()))(),
    staleAfterMs: intervalMs * multiplier,
  });
}
