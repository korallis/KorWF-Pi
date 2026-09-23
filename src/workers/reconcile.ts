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
import type { FailureCategory, FailureClassification } from "../workflow/failure.ts";
import type { RecoveryConfig } from "../config/types.ts";
import { recoverFromFailure, type RecordedRecovery } from "../workflow/recovery.ts";
import { isLegalTaskEdge, transitionTask } from "../workflow/state.ts";
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

/**
 * Reconcile every attempt left `running` by a dead session (AC1).
 *
 * Runs after the lock is taken and before any command is accepted (ADR 0006).
 * Order, and why:
 *
 *  1. Evidence is read per attempt and classified (`classifyInterruption`).
 *  2. `store.reconcile` — #23's single reconciliation path — is given that
 *     as its probe. It closes the rows and releases open budget
 *     reservations through #30's ledger. Nothing here writes an attempt row.
 *  3. Each closed attempt's worktree is *inspected* and reported. It is
 *     never removed, reset or cleaned: what is uncommitted there is the
 *     user's work as far as we can tell (#54, #70), and discarding it would
 *     need a granted `destructive_git` approval, which startup does not have.
 *  4. Completed-action receipts (#42) for the attempt's task are listed, so
 *     whatever resumes the task can see what must not be replayed.
 */
export function reconcileCrashedAttempts(
  options: ReconcileCrashedAttemptsOptions,
): CrashReconciliationReport {
  const now = options.now ?? (() => new Date().toISOString() as IsoTimestamp);
  const verdicts = new Map<string, { attempt: Attempt; verdict: InterruptionVerdict }>();
  const probe = crashProbe({
    storageRoot: options.storageRoot,
    ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
    ...(options.lockPresent === undefined ? {} : { lockPresent: options.lockPresent }),
    onVerdict: (attempt, verdict) => verdicts.set(attempt.id, { attempt, verdict }),
  });

  const storeReport = options.store.reconcile({ probe, now });

  const interrupted: InterruptedAttemptReport[] = [];
  const stillRunning: string[] = [];
  const dirty: string[] = [];

  for (const row of storeReport.attempts) {
    const found = verdicts.get(row.attemptId);
    if (found === undefined) continue;
    const { attempt, verdict } = found;
    if (verdict.cause === "still_running" || row.disposition === "reattached") {
      stillRunning.push(row.attemptId);
      continue;
    }
    const worktree = inspectPreservedWorktree(attempt, options);
    if (worktree.dirty && worktree.path !== null) dirty.push(worktree.path);
    const completedActionIds = options.store.actions
      .forSubject("task", attempt.taskId)
      .map((action) => action.actionId);
    interrupted.push(
      describeInterruption({
        attempt,
        verdict,
        outcome: row.outcome ?? "interrupted",
        worktree,
        completedActionIds,
      }),
    );
  }

  return {
    store: storeReport,
    interrupted,
    stillRunning,
    preservedDirtyWorktrees: dirty,
  };
}

/** What reconciliation saw in a preserved worktree. Read-only, always. */
export interface PreservedWorktree {
  readonly path: string | null;
  readonly exists: boolean;
  readonly dirty: boolean;
  readonly changedPaths: readonly string[];
}

/**
 * Look at an abandoned attempt's worktree without touching it.
 *
 * Only `git status --porcelain` is run, through `src/git/` (ADR 0002). No
 * checkout, reset, clean, stash or worktree removal happens here or anywhere
 * on this path — the uncommitted contents are reported and left alone.
 */
export function inspectPreservedWorktree(
  attempt: Attempt,
  options: Pick<ReconcileCrashedAttemptsOptions, "storageRoot" | "projectRoot" | "gitRunner">,
): PreservedWorktree {
  const marker = readAttemptRuntime(options.storageRoot, attempt.id);
  const path = marker?.worktreePath ?? attemptWorktreePath(options.projectRoot, attempt.id);
  if (!existsSync(path)) return { path, exists: false, dirty: false, changedPaths: [] };
  const live =
    options.gitRunner === undefined ? readLiveRepoState(path) : readLiveRepoState(path, options.gitRunner);
  if (live.kind === "no_repo") return { path, exists: true, dirty: false, changedPaths: [] };
  return {
    path,
    exists: true,
    dirty: live.dirty,
    changedPaths: live.changes.map((change) => change.path),
  };
}

/** Render one interrupted attempt for the report and the status line. */
export function describeInterruption(input: {
  readonly attempt: Attempt;
  readonly verdict: InterruptionVerdict;
  readonly outcome: AttemptOutcome;
  readonly worktree: PreservedWorktree;
  readonly completedActionIds: readonly string[];
}): InterruptedAttemptReport {
  const { attempt, verdict, worktree } = input;
  const where =
    worktree.path === null
      ? "no worktree recorded"
      : worktree.exists
        ? `worktree preserved at ${worktree.path}` +
          (worktree.dirty ? ` with ${worktree.changedPaths.length} uncommitted path(s)` : " (clean)")
        : `worktree ${worktree.path} is gone`;
  const replay =
    input.completedActionIds.length === 0
      ? ""
      : `; ${input.completedActionIds.length} completed action receipt(s) will refuse a replay`;
  return {
    attemptId: attempt.id,
    taskId: attempt.taskId,
    cause: verdict.cause,
    outcome: input.outcome,
    failureCategory: verdict.failureCategory ?? "unknown",
    reason: verdict.reason,
    worktreePath: worktree.path,
    worktreeDirty: worktree.dirty,
    completedActionIds: input.completedActionIds,
    line: `attempt ${attempt.id} (task ${attempt.taskId}) ${input.outcome} — ${verdict.cause}: ${verdict.reason} ${where}${replay}`,
  };
}

// ---------------------------------------------------------------------------
// Task disposition and recovery options (issue #72 Scope)
// ---------------------------------------------------------------------------

/**
 * The #52 classification of an interruption, built from the verdict alone.
 *
 * `harness` for a crash we can attribute (the worker died, or we killed it),
 * `unknown` when the coordinator went down with it — and an `unknown` here
 * carries evidence requests rather than a guess, because nothing observed
 * says whether the work itself was sound.
 */
export function interruptionClassification(verdict: InterruptionVerdict): FailureClassification {
  const category: FailureCategory = verdict.failureCategory ?? "unknown";
  return Object.freeze({
    category,
    confidence: 1,
    rule: `rule:crash-${verdict.cause}`,
    source: "rule" as const,
    reason: verdict.reason,
    needsEvidence: category === "unknown",
    evidenceRequests: Object.freeze(
      category === "unknown"
        ? [
            "state of the preserved attempt worktree (git status, diff against its base revision)",
            "completed-action receipts for the task, to see which effects already happened",
          ]
        : [],
    ),
  });
}

/** Options for moving an interrupted attempt's task out of `running`. */
export interface FailInterruptedTaskOptions {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly taskId: TaskId;
  readonly report: InterruptedAttemptReport;
  readonly verdict: InterruptionVerdict;
  readonly config: RecoveryConfig;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
  /** Attempts already spent on this task, for the bounded ladder (#53). */
  readonly attemptsUsed: number;
}

/** Where an interrupted task ended up, and what it may do next. */
export interface InterruptedTaskDisposition {
  readonly taskId: TaskId;
  readonly status: string;
  readonly recovery: RecordedRecovery;
}

/**
 * Move the crashed attempt's task to `failed` and record its bounded
 * recovery options (#53).
 *
 * `failed` is not terminal in this state machine: the task can be made
 * `ready` again, which is what "resume via handoff or restart" means — the
 * preserved worktree is still there to resume into. The transition goes
 * through `transitionTask`, so it is audited like any other, and the
 * `failure_observed` guard is satisfied by an actual observation: a worker
 * process that is gone with its attempt row still open.
 *
 * A task that is not `running`/`verifying`/`review` is left alone: the
 * `task-failed` edge does not start anywhere else, and forcing it would be
 * inventing a transition rather than reconciling one.
 */
export function failInterruptedTask(options: FailInterruptedTaskOptions): InterruptedTaskDisposition | null {
  const task = options.store.tasks.get(options.taskId);
  if (task === undefined) return null;
  if (!isLegalTaskEdge(task.status, "failed")) return null;

  const result = transitionTask({
    store: options.store,
    taskId: options.taskId,
    to: "failed",
    trigger: "non_cap_failure",
    actor: { kind: "engine", identity: "korwf:reconciler" },
    guards: { failure_observed: () => true },
    evidenceRefs: [
      `attempt:${options.report.attemptId}:${options.report.outcome}`,
      `crash:${options.verdict.cause}`,
      ...(options.report.worktreePath === null ? [] : [`worktree:preserved:${options.report.attemptId}`]),
    ],
    now: options.now,
    newId: options.newId,
  });

  const recovery = recoverFromFailure({
    store: options.store,
    workflowId: options.workflowId,
    subjectKind: "task",
    subjectId: options.taskId,
    classification: interruptionClassification(options.verdict),
    attemptsUsed: options.attemptsUsed,
    config: options.config,
    now: options.now,
    newId: options.newId,
  });

  return { taskId: options.taskId, status: result.subject.status, recovery };
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

