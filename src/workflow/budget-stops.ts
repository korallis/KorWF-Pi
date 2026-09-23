/**
 * Per-phase and per-workflow budget HARD STOPS, and the resumable state a
 * stop leaves behind (issue #81; PLAN §2.6 "per-phase and per-workflow
 * budget caps with hard stop; ... a resumable state on any stop").
 *
 * What this module is NOT: a second budget enforcer. The authority is
 * `src/telemetry/ledger.ts` (#30), whose `reserve()` does its cap check and
 * its insert inside one `BEGIN IMMEDIATE` transaction — proven by the #30
 * tests where 100 concurrent attempts and four simultaneous *processes*
 * against a cap of 10 grant exactly 10. Nothing here counts spend, and
 * nothing here decides whether a reservation is allowed.
 *
 * What this module adds is the *reaction* the scheduler owes a refusal:
 *
 *  - `budgetReservationHook` turns the ledger's `BudgetExceededError` into
 *    the scheduler's `reserve` contract (`null` = do not dispatch) and
 *    latches the breach, so the refusal is visible after the pass;
 *  - a latched cumulative breach makes `shouldStop()` true, which the run
 *    loop polls as its "no task starts after the cap is reached" rule;
 *  - `applyBudgetStop` pauses the phases through #74's `stopRun`, i.e.
 *    `state.ts`'s `phase-pause` edge, landing in `paused_cap` with a
 *    `budget_hard_stop` blocker — the same resumable shape a deliberate
 *    stop (#74) and crash reconciliation (#72) produce;
 *  - `resumeAfterCapRaised` is the config-change path: it re-reads the caps,
 *    refuses to resume while the *new* caps are still breached, and
 *    otherwise resolves the budget blocker so the existing phase-resume edge
 *    can run. Spend already recorded stays recorded; nothing is rolled back.
 */
import type {
  Budget,
  BudgetScopeKind,
  IsoTimestamp,
  Phase,
  PhaseId,
  Task,
  Usage,
  WorkflowId,
} from "../storage/records.ts";
import type { Store } from "../storage/db.ts";
import type { TransitionActor } from "../storage/transition-log.ts";
import type { BudgetsConfig } from "../config/types.ts";
import {
  BudgetExceededError,
  isCumulativeCap,
  type ChargeScope,
  type Ledger,
  type Reservation,
} from "../telemetry/ledger.ts";
import type { DispatchReservation } from "./scheduler.ts";

/** The blocker kind a budget hard stop raises. Matched by `state.ts`'s `CAP_BLOCKER_KINDS`. */
export const BUDGET_STOP_BLOCKER = "budget_hard_stop";

/** One recorded cap breach: exactly what the ledger refused, and where. */
export interface BudgetBreach {
  readonly scope: BudgetScopeKind;
  readonly cap: keyof Budget;
  readonly limit: number;
  readonly committed: number;
  readonly requested: number;
  /** `false` for `maxConcurrency`, which clears when a worker settles. */
  readonly cumulative: boolean;
  /** The task whose dispatch was refused, when the refusal came from a dispatch. */
  readonly taskId: string | null;
  readonly at: IsoTimestamp;
}

/** Human-readable one-liner for a breach, used in blockers and messages. */
export function describeBreach(breach: BudgetBreach): string {
  const where = breach.taskId === null ? "" : ` (refused dispatch of task ${breach.taskId})`;
  return (
    `${breach.scope} budget cap ${breach.cap} = ${breach.limit} reached: ` +
    `${breach.committed} committed, ${breach.requested} more requested${where}`
  );
}

/** Turn a ledger refusal into the breach record this module latches. */
export function breachOf(
  error: BudgetExceededError,
  at: IsoTimestamp,
  taskId: string | null,
): BudgetBreach {
  return {
    scope: error.scope,
    cap: error.cap,
    limit: error.limit,
    committed: error.committed,
    requested: error.requested,
    cumulative: isCumulativeCap(error.cap),
    taskId,
    at,
  };
}

// ---------------------------------------------------------------------------
// The latch
// ---------------------------------------------------------------------------

/**
 * Records cap refusals for one run and answers the scheduler's "may anything
 * else start?" question.
 *
 * The latch exists because a hard stop has to be *sticky* within a pass: the
 * ledger refuses one reservation at a time, and without a latch the loop
 * would go round and ask again for every remaining ready task, producing a
 * refusal per task and no stop. It is **not** an accounting of spend — it
 * holds no totals and grants nothing. Every grant still comes from
 * `Ledger.reserve`, per dispatch.
 *
 * Only a *cumulative* breach latches (see `CUMULATIVE_CAPS`). A
 * `maxConcurrency` refusal is recorded for reporting but leaves
 * `shouldStop()` false, because that cap clears as soon as a worker settles
 * and stopping the run on it would turn the concurrency ceiling into an
 * outage.
 */
export class BudgetGovernor {
  readonly #breaches: BudgetBreach[] = [];
  #stopped: BudgetBreach | null = null;

  /** Every refusal seen this run, in order, including non-latching ones. */
  get breaches(): readonly BudgetBreach[] {
    return this.#breaches;
  }

  /** The breach that triggered the hard stop, or `null` if none has. */
  get stopBreach(): BudgetBreach | null {
    return this.#stopped;
  }

  /**
   * `true` once a cumulative cap has refused a reservation. The scheduler
   * polls this before every dispatch, so no task starts after the cap is
   * reached.
   */
  shouldStop(): boolean {
    return this.#stopped !== null;
  }

  /** Record a refusal. Returns the breach; latches it when cumulative. */
  record(breach: BudgetBreach): BudgetBreach {
    this.#breaches.push(breach);
    if (breach.cumulative && this.#stopped === null) this.#stopped = breach;
    return breach;
  }

  /**
   * Clear the latch because the *caps changed* (`resumeAfterCapRaised`).
   * Deliberately not exposed as a general "try again": within one run a
   * cumulative cap cannot un-breach itself, so the only honest reason to
   * clear is a config change, and the caller proves that by re-checking the
   * new caps against the ledger before calling this.
   */
  clearForRaisedCap(): void {
    this.#stopped = null;
  }

  /** Message for the user. Empty string when nothing has stopped the run. */
  stopReason(): string {
    if (this.#stopped === null) return "";
    return (
      `${describeBreach(this.#stopped)}. No further tasks were dispatched. ` +
      "Spend already recorded is kept; raise the cap in config and re-run to resume."
    );
  }
}

// ---------------------------------------------------------------------------
// The scheduler's `reserve` hook
// ---------------------------------------------------------------------------

export interface BudgetHookParams {
  /** The #30 ledger. The only thing that grants or refuses budget. */
  readonly ledger: Ledger;
  readonly governor: BudgetGovernor;
  readonly workflowId: WorkflowId;
  /** Pre-dispatch estimate for the task. Unknown cost is honest and still consumes caps. */
  readonly estimateFor: (task: Task) => Usage;
  readonly now: () => IsoTimestamp;
  /** Attribution carried onto the ledger rows (route/run id, #71/#125). */
  readonly label?: (task: Task) => string;
}

/**
 * The `reserve` hook `runScheduler` calls **once per dispatch** (#75: "an
 * in-process counter is not the authority: the reservation hook is asked per
 * dispatch").
 *
 * Behaviour, in order:
 *  1. if the governor has already latched a cumulative breach, refuse
 *     without touching the ledger — no task starts after the cap is reached,
 *     and asking again would only append another refusal;
 *  2. otherwise ask `Ledger.reserve`, which does the atomic check;
 *  3. a `BudgetExceededError` is recorded as a breach and returned as `null`
 *     (the scheduler's "held, not dispatched" signal). It is never rethrown:
 *     a cap being reached is a stop, not a crash;
 *  4. a granted reservation is wrapped so the scheduler's single
 *     `release()` call releases it in the ledger exactly once.
 *
 * Release, not settle: the scheduler releases when a *dispatch* settles, and
 * the worker's actual usage is settled by the worker layer (#71) against its
 * own reservations. Releasing an estimate the run never spent is not a
 * rollback of recorded spend — no settlement row is removed, and the
 * append-only release row is itself part of the audit.
 */
export function budgetReservationHook(
  params: BudgetHookParams,
): (task: Task) => DispatchReservation | null {
  const { ledger, governor, workflowId, estimateFor, now } = params;
  return (task: Task): DispatchReservation | null => {
    if (governor.shouldStop()) return null;
    const scope: ChargeScope = { workflowId, phaseId: task.phaseId, taskId: task.id };
    let reservation: Reservation;
    try {
      reservation = ledger.reserve({
        scope,
        estimate: estimateFor(task),
        ...(params.label === undefined ? {} : { label: params.label(task) }),
      });
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        governor.record(breachOf(error, now(), task.id));
        return null;
      }
      throw error;
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        ledger.release(reservation, `dispatch settled for task ${task.id}`);
      },
    };
  };
}
