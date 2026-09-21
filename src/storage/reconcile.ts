/**
 * Startup reconciliation of abandoned attempts (issue #23; ADR 0006 rule 7,
 * PLAN §5 "abandoned attempts reconciled on startup").
 *
 * After the coordinator wins the lockfile and before it accepts any command,
 * every `attempt` with `outcome IS NULL` is checked against its worker: a
 * worker that is still alive is re-attached; one that is gone had its attempt
 * abandoned when the previous session died, so the row is closed with
 * `outcome = "abandoned"` and an audit entry.
 *
 * This module owns the *store* half only. Deciding what re-attaching means —
 * re-opening the RPC channel, resuming the worker's stage, moving the task
 * (docs/state-machine.md) — is Stage 5 work, so the worker probe and the
 * per-attempt follow-up are injected through `ReconcileOptions`. The default
 * probe reports every worker as gone, which is the safe reading for a store
 * that has just been opened by a new process.
 */
import type { Attempt, AttemptOutcome, IsoTimestamp } from "./records.ts";
import type { AttemptRepository, AuditRepository } from "./repos/index.ts";

/** What a liveness probe concluded about one open attempt's worker. */
export type WorkerLiveness =
  | { readonly kind: "alive"; readonly detail?: string }
  | { readonly kind: "gone"; readonly detail?: string };

/**
 * Stage 5 supplies the real probe (ADR 0004 worker pid/snapshot). The
 * interface is fixed here so the store can be written and tested now.
 */
export type WorkerProbe = (attempt: Attempt) => WorkerLiveness;

/** Outcome written for an attempt whose worker did not survive the restart. */
export const ABANDONED_OUTCOME: AttemptOutcome = "abandoned";

export interface ReconcileOptions {
  /** Liveness probe; defaults to "every worker is gone". */
  readonly probe?: WorkerProbe;
  /** Called for each attempt whose worker is still alive (Stage 5 re-attach). */
  readonly onReattach?: (attempt: Attempt) => void;
  readonly now?: () => IsoTimestamp;
  /** Actor recorded on the audit rows; defaults to `korwf:reconciler`. */
  readonly actor?: string;
}

export interface ReconciledAttempt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly disposition: "reattached" | "abandoned";
  readonly detail: string | null;
}

export interface ReconciliationReport {
  readonly at: IsoTimestamp;
  readonly examined: number;
  readonly reattached: number;
  readonly abandoned: number;
  readonly attempts: readonly ReconciledAttempt[];
}

export interface ReconcileDeps {
  readonly attempts: AttemptRepository;
  readonly audit: AuditRepository;
}

/** Default probe: after a restart nothing is assumed to have survived. */
export const assumeWorkersGone: WorkerProbe = () => ({ kind: "gone", detail: "no worker probe registered" });

/**
 * Close or re-attach every open attempt. Idempotent: running it twice finds
 * nothing the second time, because abandoned attempts now have an outcome.
 */
export function reconcileAbandonedAttempts(
  deps: ReconcileDeps,
  options: ReconcileOptions = {},
): ReconciliationReport {
  const probe = options.probe ?? assumeWorkersGone;
  const now = options.now ?? (() => new Date().toISOString());
  const at = now();
  const results: ReconciledAttempt[] = [];

  for (const attempt of deps.attempts.open()) {
    const liveness = probe(attempt);
    if (liveness.kind === "alive") {
      options.onReattach?.(attempt);
      results.push({
        attemptId: attempt.id,
        taskId: attempt.taskId,
        workerId: attempt.workerId,
        disposition: "reattached",
        detail: liveness.detail ?? null,
      });
      continue;
    }
    // Frozen from here on: the attempt repository rejects further patches
    // once `outcome` is non-null (docs/records.md §4).
    deps.attempts.update(attempt.id, {
      outcome: ABANDONED_OUTCOME,
      timestamps: { ...attempt.timestamps, endedAt: at },
    });
    results.push({
      attemptId: attempt.id,
      taskId: attempt.taskId,
      workerId: attempt.workerId,
      disposition: "abandoned",
      detail: liveness.detail ?? null,
    });
  }

  return {
    at,
    examined: results.length,
    reattached: results.filter((r) => r.disposition === "reattached").length,
    abandoned: results.filter((r) => r.disposition === "abandoned").length,
    attempts: results,
  };
}
