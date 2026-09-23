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
import type { Budget, IsoTimestamp, Phase, PhaseId, Task, WorkflowId } from "../storage/records.ts";
import type { BudgetScopeKind } from "../storage/records.ts";
import type { Store } from "../storage/db.ts";
import type { TransitionActor } from "../storage/transition-log.ts";
import type { BudgetsConfig } from "../config/types.ts";
import {
  BudgetExceededError,
  isCumulativeCap,
  type ChargeScope,
  type Ledger,
  type Reservation,
  type Usage,
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
