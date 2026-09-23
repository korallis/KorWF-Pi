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
import { createHash } from "node:crypto";
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
  /** Timestamp of the most recent successful heartbeat write, or of acquisition. */
  lastHeartbeatAt(): string | null;
  /** `false` once this lease has been released or displaced. */
  isOwned(): boolean;
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

  constructor(
    lockPath: string,
    holder: LockfileContents,
    assessment: HolderAssessment,
  ) {
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
  const session =
    holder.sessionId === undefined || holder.sessionId === ""
      ? `pid ${holder.pid}`
      : holder.sessionId;
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
    | "storageRoot"
    | "isProcessAlive"
    | "nowMs"
    | "heartbeatIntervalMs"
    | "heartbeatStaleMultiplier"
  >,
): {
  readonly holder: LockfileContents;
  readonly assessment: HolderAssessment;
} | null {
  const path = resolveCoordinatorLockPath(options.storageRoot);
  let holder: LockfileContents;
  try {
    holder = readLockfile(path);
  } catch {
    return null;
  }
  return { holder, assessment: assess(holder, options) };
}

/**
 * Take the right to schedule, or refuse (AC: "two concurrent `run`
 * invocations: exactly one proceeds").
 *
 * Order of events:
 *
 * 1. Read the lockfile. If a holder is there and its **pid is alive**, throw
 *    `CoordinatorActiveError` naming its session and start time. No timeout,
 *    no retry: the second `/korwf run` is a user mistake, not a race to wait
 *    out, and the user has a scheduler already running to look at.
 * 2. If the pid is dead the lock is stale. `acquireLock` removes it and
 *    re-creates it under `O_EXCL`, so two processes racing to take over the
 *    same dead owner still produce exactly one winner and the loser sees the
 *    winner as a live holder.
 * 3. On takeover, write the audit row (`korwf:coordinator-lock`) and then run
 *    store reconciliation, so the dead owner's open attempts are closed
 *    before this coordinator dispatches anything (ADR 0006 rule 7).
 */
export function acquireCoordinatorLock(
  options: AcquireCoordinatorOptions,
): CoordinatorLease {
  const path = resolveCoordinatorLockPath(options.storageRoot);
  const now = options.now ?? (() => new Date().toISOString());
  const intervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const existing = inspectCoordinator(options);
  if (existing !== null && !existing.assessment.mayTakeOver) {
    throw new CoordinatorActiveError(
      path,
      existing.holder,
      existing.assessment,
    );
  }

  let handle: LockHandle;
  try {
    handle = acquireLock(path, {
      ...(options.pid === undefined ? {} : { pid: options.pid }),
      ...(options.packageVersion === undefined
        ? {}
        : { packageVersion: options.packageVersion }),
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      ...(options.isProcessAlive === undefined
        ? {}
        : { isProcessAlive: options.isProcessAlive }),
      heartbeat: true,
      now,
      // Do not wait: step 1 already established that no live coordinator
      // holds the lock. A zero timeout turns a lost takeover race into an
      // immediate, accurate "someone else got there first".
      timeoutMs: 0,
    });
  } catch (error) {
    if (error instanceof StoreLockedError) {
      const winner = inspectCoordinator(options);
      if (winner !== null) {
        throw new CoordinatorActiveError(
          path,
          winner.holder,
          winner.assessment,
        );
      }
    }
    throw error;
  }

  const previousOwner =
    handle.kind === "took_over_stale" ? handle.previousHolder : null;
  const reconciliation =
    handle.kind === "took_over_stale"
      ? auditAndReconcileTakeover(options.store, handle.contents, previousOwner)
      : null;

  return makeLease({
    handle,
    acquisition: handle.kind,
    previousOwner,
    reconciliation,
    intervalMs,
    now,
    ...(options.setInterval === undefined
      ? {}
      : { setIntervalFn: options.setInterval }),
    ...(options.clearInterval === undefined
      ? {}
      : { clearIntervalFn: options.clearInterval }),
  });
}

interface LeaseParams {
  readonly handle: LockHandle;
  readonly acquisition: CoordinatorAcquisition;
  readonly previousOwner: LockfileContents | null;
  readonly reconciliation: ReconciliationReport | null;
  readonly intervalMs: number;
  readonly now: () => string;
  readonly setIntervalFn?: (
    fn: () => void,
    ms: number,
  ) => { unref?: () => void };
  readonly clearIntervalFn?: (handle: unknown) => void;
}

function makeLease(params: LeaseParams): CoordinatorLease {
  const { handle, intervalMs, now } = params;
  let current = handle.contents;
  let owned = true;
  let timer: unknown = null;
  const setIntervalFn =
    params.setIntervalFn ??
    ((fn: () => void, ms: number) =>
      setInterval(fn, ms) as unknown as { unref?: () => void });
  const clearIntervalFn =
    params.clearIntervalFn ??
    ((h: unknown) => clearInterval(h as NodeJS.Timeout));

  const beat = (): boolean => {
    if (!owned) return false;
    const next = writeHeartbeat(handle.path, handle.contents, now());
    if (next === null) {
      // The lockfile is gone or belongs to someone else now: this lease no
      // longer owns scheduling and must stop claiming it does.
      owned = false;
      return false;
    }
    current = next;
    return true;
  };

  return {
    path: handle.path,
    contents: handle.contents,
    acquisition: params.acquisition,
    previousOwner: params.previousOwner,
    reconciliation: params.reconciliation,
    heartbeatIntervalMs: intervalMs,
    heartbeat: beat,
    lastHeartbeatAt: () => current.heartbeatAt ?? null,
    isOwned: () => owned,
    startHeartbeat(): () => void {
      if (timer !== null) return () => this.release();
      const handleRef = setIntervalFn(() => void beat(), intervalMs);
      handleRef.unref?.();
      timer = handleRef;
      return () => {
        if (timer !== null) {
          clearIntervalFn(timer);
          timer = null;
        }
      };
    },
    release(): void {
      if (timer !== null) {
        clearIntervalFn(timer);
        timer = null;
      }
      owned = false;
      // `LockHandle.release` already refuses to delete a file whose pid or
      // startedAt differs, so a lock taken over from us stays with its owner.
      handle.release();
    },
  };
}

/** Actor recorded on the takeover audit row. */
export const COORDINATOR_LOCK_ACTOR = "korwf:coordinator-lock";

/**
 * Record the takeover, then reconcile (ADR 0006 rule 1 and rule 7).
 *
 * The audit row is written *before* reconciliation so that a crash during
 * reconciliation still leaves evidence of which coordinator was displaced.
 * With no store (lock-mechanics tests) neither step runs and `null` is
 * returned — the lease then carries `reconciliation: null`, which is the
 * honest answer, not a claim that nothing needed reconciling.
 */
function auditAndReconcileTakeover(
  store: Store | undefined,
  contents: LockfileContents,
  previousOwner: LockfileContents | null,
): ReconciliationReport | null {
  if (store === undefined) return null;
  store.recordAudit({
    table: "audit_entry",
    recordId: `coordinator-lock:${contents.pid}`,
    operation: "insert",
    beforeHash: previousOwner === null ? null : hashHolder(previousOwner),
    afterHash: hashHolder(contents),
    actor: COORDINATOR_LOCK_ACTOR,
  });
  return store.reconcile({ actor: COORDINATOR_LOCK_ACTOR });
}

/** Stable digest of a lock holder, for the audit row's before/after hashes. */
function hashHolder(contents: LockfileContents): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        contents.pid,
        contents.startedAt,
        contents.hostHash,
        contents.packageVersion,
        contents.sessionId ?? "",
        contents.heartbeatAt ?? "",
      ]),
    )
    .digest("hex");
}

function assess(
  holder: LockfileContents,
  options: Pick<
    AcquireCoordinatorOptions,
    | "isProcessAlive"
    | "nowMs"
    | "heartbeatIntervalMs"
    | "heartbeatStaleMultiplier"
  >,
): HolderAssessment {
  const intervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const multiplier =
    options.heartbeatStaleMultiplier ?? DEFAULT_HEARTBEAT_STALE_MULTIPLIER;
  return classifyHolder(holder, {
    ...(options.isProcessAlive === undefined
      ? {}
      : { isProcessAlive: options.isProcessAlive }),
    nowMs: (options.nowMs ?? (() => Date.now()))(),
    staleAfterMs: intervalMs * multiplier,
  });
}
