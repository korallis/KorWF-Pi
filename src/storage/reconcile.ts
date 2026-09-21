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
import type {
  Attempt,
  AttemptOutcome,
  IsoTimestamp,
  LedgerEntry,
  LedgerEntryId,
  ReservationId,
  UsageChannel,
  Usage,
  WorkflowId,
} from "./records.ts";
import { RECORDS_SCHEMA_VERSION } from "./records.ts";
import type { AttemptRepository, AuditRepository, LedgerRepository } from "./repos/index.ts";

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
  /** Budget-reservation reconciliation (issue #30). */
  readonly reservations?: ReconcileReservationsOptions;
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
  /** Budget reservations closed as abandoned (issue #30). */
  readonly reservations: readonly AbandonedReservationRow[];
}

export interface ReconcileDeps {
  readonly attempts: AttemptRepository;
  readonly audit: AuditRepository;
  /** Optional so callers that only reconcile attempts keep working. */
  readonly ledger?: LedgerRepository;
}

/** A budget reservation whose session died before it settled (issue #30). */
export interface AbandonedReservationRow {
  readonly reservationId: ReservationId;
  readonly sessionId: string;
  readonly channel: UsageChannel;
  readonly workflowId: WorkflowId;
  /** The estimate, which stays charged: we cannot know what the call used. */
  readonly estimate: Usage;
}

/** Reason written on an abandonment row. */
export const LEDGER_ABANDONED_REASON = "reservation had no settlement when the store was reopened";

export interface ReconcileReservationsOptions {
  /**
   * Reservations from this session are left alone — they belong to the
   * caller's own in-flight calls. At startup nothing is in flight, so the
   * default (`undefined`) closes every open reservation.
   */
  readonly keepSessionId?: string;
  readonly now?: () => IsoTimestamp;
  readonly newId?: () => string;
}

let reservationIdCounter = 0;
function defaultAbandonmentId(): string {
  reservationIdCounter += 1;
  return `aban-${Date.now().toString(36)}-${process.pid.toString(36)}-${reservationIdCounter.toString(36)}`;
}

/**
 * Close every open budget reservation with an `abandonment` row (issue #30).
 *
 * The estimate is retained rather than refunded: a reserved call may well
 * have run and cost money before the process died, and silently returning the
 * budget would let a crash loop spend past its cap. The row records that the
 * amount is an unverified estimate, so reports stay honest.
 *
 * Idempotent — the abandonment row is itself the terminal row, so a second
 * pass finds nothing.
 */
export function reconcileOpenReservations(
  ledger: LedgerRepository,
  options: ReconcileReservationsOptions = {},
): readonly AbandonedReservationRow[] {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? defaultAbandonmentId;
  const at = now();
  const closed: AbandonedReservationRow[] = [];

  for (const open of ledger.openReservations()) {
    if (options.keepSessionId !== undefined && open.sessionId === options.keepSessionId) continue;
    const row: LedgerEntry = {
      id: newId() as LedgerEntryId,
      createdAt: at,
      updatedAt: at,
      schemaVersion: RECORDS_SCHEMA_VERSION,
      kind: "append_only",
      scope: open.scope,
      channel: open.channel,
      entryKind: "abandonment",
      reservationId: open.reservationId,
      sessionId: open.sessionId,
      usage: open.usage,
      elapsedMs: open.elapsedMs,
      label: open.label,
      reason: LEDGER_ABANDONED_REASON,
    };
    ledger.insert(row);
    closed.push({
      reservationId: open.reservationId,
      sessionId: open.sessionId,
      channel: open.channel,
      workflowId: open.scope.workflowId,
      estimate: open.usage,
    });
  }
  return closed;
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

  const reservations =
    deps.ledger === undefined
      ? []
      : reconcileOpenReservations(deps.ledger, { now: () => at, ...options.reservations });

  return {
    at,
    examined: results.length,
    reattached: results.filter((r) => r.disposition === "reattached").length,
    abandoned: results.filter((r) => r.disposition === "abandoned").length,
    attempts: results,
    reservations,
  };
}
