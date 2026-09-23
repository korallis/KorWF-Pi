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

  /** Message for the user. Empty string when nothing has stopped the run. */
  stopReason(): string {
    if (this.#stopped === null) return "";
    return (
      `${describeBreach(this.#stopped)}. No further tasks were dispatched. ` +
      "Spend already recorded is kept; raise the cap in config and re-run to resume."
    );
  }
}
