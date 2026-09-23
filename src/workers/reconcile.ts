/**
 * Crash-interrupted attempt reconciliation on startup (issue #72; PLAN §5
 * "Abandoned attempts reconciled on startup", PLAN §3.E; ADR 0006 rule 7).
 *
 * When Pi or the coordinator dies mid-attempt, the store still says the
 * attempt is `running` and its worktree may be mid-edit. Neither may be
 * trusted and neither may be discarded: the row is closed honestly, the
 * worktree is kept exactly as the dead worker left it, and budget
 * reservations are released.
 *
 * This is **not a third reconciliation path**. It is the worker-side probe
 * and follow-up that `src/storage/reconcile.ts` (#23) already asks for
 * through `ReconcileOptions.probe`, plus a thin report that names #42's
 * receipts as the replay guard. The store still does the writing, and
 * `src/workflow/reconcile.ts` still owns session-vs-repo reconciliation.
 */
import type { Attempt, AttemptOutcome, IsoTimestamp } from "../storage/records.ts";
import type { WorkerLiveness, WorkerProbe } from "../storage/reconcile.ts";

/** How an attempt's worker came to be gone. Maps onto #52's taxonomy. */
export type InterruptionCause = "worker_died" | "process_killed" | "machine_crashed" | "still_running";

/** Everything observable about one abandoned attempt before it is judged. */
export interface AttemptLivenessEvidence {
  /** Worker pid recorded when the attempt started; `null` when never recorded. */
  readonly pid: number | null;
  /** Is that pid still alive and signalable by us? */
  readonly pidAlive: boolean;
  /** Did the coordinator lockfile survive, and was it this session's? */
  readonly lockPresent: boolean;
  /** Was a cancellation recorded for this attempt before the process vanished? */
  readonly cancellationRequested: boolean;
  /** Did the worker write a clean exit record? */
  readonly exitRecorded: boolean;
}

/** What the probe concluded, in terms the store can act on. */
export interface InterruptionVerdict {
  readonly cause: InterruptionCause;
  readonly outcome: AttemptOutcome | null;
  /** #52 failure category; `null` when the attempt is still running. */
  readonly failureCategory: "harness" | "unknown" | null;
  readonly reason: string;
}

/** One reconciled crash, as the report renders it. */
export interface InterruptedAttemptReport {
  readonly attemptId: string;
  readonly taskId: string;
  readonly cause: InterruptionCause;
  readonly outcome: AttemptOutcome;
  readonly failureCategory: "harness" | "unknown";
  readonly reason: string;
  /** Absolute path of the worktree that was preserved, when one is known. */
  readonly worktreePath: string | null;
  /** `true` when the preserved worktree still holds uncommitted work. */
  readonly worktreeDirty: boolean;
  /** Completed-action receipts (#42) that must not be replayed on resume. */
  readonly completedActionIds: readonly string[];
  readonly line: string;
}

export {};
