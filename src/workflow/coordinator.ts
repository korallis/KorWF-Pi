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
