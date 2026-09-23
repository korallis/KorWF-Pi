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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../storage/db.ts";
import type { Attempt, AttemptOutcome, IsoTimestamp, TaskId, WorkflowId } from "../storage/records.ts";
import type { ReconciliationReport } from "../storage/reconcile.ts";
import type { GitRunner as GitStatusRunner } from "../git/status.ts";
import { attemptWorktreePath } from "./worktree.ts";
import type { WorkerLiveness, WorkerProbe } from "../storage/reconcile.ts";
import { isProcessAlive } from "../storage/lock.ts";
import { readLiveRepoState } from "../git/index.ts";

/** Subdirectory of the storage root holding one marker per live attempt. */
export const RUNTIME_DIR_NAME = "runtime";

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

/**
 * The crash-survivable half of an attempt: what the store cannot hold.
 *
 * The `attempt` row is written inside a transaction and says nothing about
 * the operating system. The pid, the worktree and whether a cancellation was
 * asked for are facts about a process, so they are written to a small file
 * beside the database as they happen — a process that is SIGKILLed gets no
 * chance to flush anything later.
 */
export interface AttemptRuntimeMarker {
  readonly attemptId: string;
  readonly taskId: string;
  readonly workflowId: string;
  /** Coordinator session that spawned the worker. */
  readonly sessionId: string;
  readonly pid: number;
  readonly startedAt: string;
  /** Absolute path of the attempt worktree, so reconciliation can find it. */
  readonly worktreePath: string | null;
  /** Set when a cancellation was requested before the process vanished. */
  readonly cancellationRequestedAt: string | null;
  /** Set when the worker's exit was actually observed by the coordinator. */
  readonly exitObservedAt: string | null;
  /** Exit code, when one was observed. */
  readonly exitCode: number | null;
}

/** Directory holding runtime markers under the storage root. */
export function attemptRuntimeDir(storageRoot: string): string {
  return join(storageRoot, RUNTIME_DIR_NAME);
}

/** Path of one attempt's runtime marker. */
export function attemptRuntimePath(storageRoot: string, attemptId: string): string {
  return join(attemptRuntimeDir(storageRoot), `${attemptId}.json`);
}

/**
 * Write (or overwrite) an attempt's runtime marker.
 *
 * Written to a temporary name and renamed, so a crash mid-write leaves
 * either the previous marker or the new one, never a half-parsed file that
 * reconciliation would have to guess about.
 */
export function writeAttemptRuntime(storageRoot: string, marker: AttemptRuntimeMarker): AttemptRuntimeMarker {
  const dir = attemptRuntimeDir(storageRoot);
  mkdirSync(dir, { recursive: true });
  const target = attemptRuntimePath(storageRoot, marker.attemptId);
  const temp = `${target}.tmp`;
  writeFileSync(temp, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  renameSync(temp, target);
  return marker;
}

/** Read one marker, or `null` when it is absent or unreadable. */
export function readAttemptRuntime(storageRoot: string, attemptId: string): AttemptRuntimeMarker | null {
  const target = attemptRuntimePath(storageRoot, attemptId);
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, "utf8")) as AttemptRuntimeMarker;
  } catch {
    // A corrupt marker is "we know nothing about this process", which is the
    // `machine_crashed` reading — never an excuse to assume a clean exit.
    return null;
  }
}

/** Record that a cancellation was requested, so a later crash is not mislabelled. */
export function markCancellationRequested(
  storageRoot: string,
  attemptId: string,
  at: string,
): AttemptRuntimeMarker | null {
  const marker = readAttemptRuntime(storageRoot, attemptId);
  if (marker === null) return null;
  return writeAttemptRuntime(storageRoot, { ...marker, cancellationRequestedAt: at });
}

/** Evidence for one attempt, read from its marker and the operating system. */
export interface EvidenceOptions {
  readonly storageRoot: string;
  /** Liveness probe; injected in tests. Defaults to `process.kill(pid, 0)`. */
  readonly isAlive?: (pid: number) => boolean;
  /** Does the coordinator lockfile still exist? */
  readonly lockPresent?: boolean;
}

/** Gather the observable facts about one open attempt. */
export function evidenceFor(attemptId: string, options: EvidenceOptions): AttemptLivenessEvidence {
  const marker = readAttemptRuntime(options.storageRoot, attemptId);
  const alive = options.isAlive ?? isProcessAlive;
  const pid = marker?.pid ?? null;
  return {
    pid,
    // A missing marker means no pid to probe, which reads as "not alive" —
    // never as "still running", because that would leave the row open forever.
    pidAlive: pid === null ? false : alive(pid),
    lockPresent: options.lockPresent ?? false,
    cancellationRequested: marker?.cancellationRequestedAt != null,
    exitRecorded: marker?.exitObservedAt != null,
  };
}

// ---------------------------------------------------------------------------
// Classification (issue #72 Scope: "detection"; #52 taxonomy)
// ---------------------------------------------------------------------------

/**
 * Decide what happened to one attempt from the evidence, and nothing more.
 *
 * Three distinguishable endings, in the order the evidence can support them:
 *
 *  - **still_running** — the pid is alive. Nothing is written; the caller
 *    re-attaches. A live worker is never closed by reconciliation.
 *  - **process_killed** — a cancellation was requested before the process
 *    vanished, so the kill is ours and the attempt is `cancelled`.
 *  - **worker_died** — the coordinator saw the worker exit but never settled
 *    the row. The harness failed; `#52` calls that `harness`.
 *  - **machine_crashed** — no exit was observed and no cancellation was
 *    asked for: the coordinator itself went down with the worker. Nothing
 *    about the work can be asserted, so the category is `unknown`.
 */
export function classifyInterruption(evidence: AttemptLivenessEvidence): InterruptionVerdict {
  if (evidence.pidAlive && evidence.pid !== null) {
    return {
      cause: "still_running",
      outcome: null,
      failureCategory: null,
      reason: `Worker pid ${evidence.pid} is still alive; the attempt was not interrupted.`,
    };
  }
  if (evidence.cancellationRequested) {
    return {
      cause: "process_killed",
      outcome: "cancelled",
      failureCategory: "harness",
      reason:
        "A cancellation was requested for this attempt before its process vanished, so the " +
        "process was killed by us rather than lost.",
    };
  }
  if (evidence.exitRecorded) {
    return {
      cause: "worker_died",
      outcome: "interrupted",
      failureCategory: "harness",
      reason:
        "The worker process exited and the coordinator observed it, but the attempt was never " +
        "settled: the harness failed, not the work.",
    };
  }
  return {
    cause: "machine_crashed",
    outcome: "interrupted",
    failureCategory: "unknown",
    reason:
      "No worker exit was observed and no cancellation was requested" +
      (evidence.lockPresent ? "" : ", and the coordinator lockfile did not survive") +
      ": the coordinator stopped without recording anything, so what the attempt did is unknown.",
  };
}

// ---------------------------------------------------------------------------
// The probe handed to `src/storage/reconcile.ts`
// ---------------------------------------------------------------------------

/** Options shared by the probe and the reporting wrapper. */
export interface CrashProbeOptions extends EvidenceOptions {
  /** Called for every attempt the probe judged, in probe order. */
  readonly onVerdict?: (attempt: Attempt, verdict: InterruptionVerdict) => void;
}

/**
 * Build the `WorkerProbe` that #23's `reconcileAbandonedAttempts` already
 * takes. This is the whole integration: there is no second scan of the
 * `attempt` table here, and no write — the store closes the rows.
 */
export function crashProbe(options: CrashProbeOptions): WorkerProbe {
  return (attempt: Attempt): WorkerLiveness => {
    const verdict = classifyInterruption(evidenceFor(attempt.id, options));
    options.onVerdict?.(attempt, verdict);
    if (verdict.cause === "still_running") {
      return { kind: "alive", detail: verdict.reason };
    }
    return {
      kind: "gone",
      detail: `${verdict.cause}: ${verdict.reason}`,
      ...(verdict.outcome === null ? {} : { outcome: verdict.outcome }),
    };
  };
}

// ---------------------------------------------------------------------------
// Startup entry point
// ---------------------------------------------------------------------------

export interface ReconcileCrashedAttemptsOptions {
  readonly store: Store;
  readonly storageRoot: string;
  /** The user's repository root; attempt worktrees hang below it. */
  readonly projectRoot: string;
  /** Pi session performing the reconciliation, for the receipt listing. */
  readonly sessionId?: string;
  readonly isAlive?: (pid: number) => boolean;
  readonly lockPresent?: boolean;
  readonly now?: () => IsoTimestamp;
  readonly gitRunner?: GitStatusRunner;
}

/** What one startup reconciliation found and did. */
export interface CrashReconciliationReport {
  /** The store's own report; the only place attempt rows were written. */
  readonly store: ReconciliationReport;
  readonly interrupted: readonly InterruptedAttemptReport[];
  /** Attempts whose worker was still alive and was left running. */
  readonly stillRunning: readonly string[];
  /** Worktrees preserved with uncommitted work in them. */
  readonly preservedDirtyWorktrees: readonly string[];
}

/** Record an observed worker exit. An attempt with this set did not crash unseen. */
export function markExitObserved(
  storageRoot: string,
  attemptId: string,
  at: string,
  exitCode: number | null,
): AttemptRuntimeMarker | null {
  const marker = readAttemptRuntime(storageRoot, attemptId);
  if (marker === null) return null;
  return writeAttemptRuntime(storageRoot, { ...marker, exitObservedAt: at, exitCode });
}

