/**
 * Dependency-aware scheduler (issue #75; PLAN §3.E "Single-worker,
 * sequential, parallel, and dependency-aware workflows. Enforce concurrency
 * limits." and "Declared ownership conflicts detected in code; Jev adds a
 * semantic-coupling signal; default to serial when coupling is uncertain").
 *
 * This module turns the persisted task graph into a stream of dispatches. It
 * does not re-derive anything that already exists on main:
 *
 * - dependency order and the ready set come from `graph.ts` (#40);
 * - every task status write goes through `state.ts` (#41) — including the
 *   claim, so a second claim of the same task loses on the stale-snapshot
 *   check rather than on a mutex invented here;
 * - the concurrency ceiling is enforced by the #30 ledger's atomic
 *   `BEGIN IMMEDIATE` reservation, which is what makes two schedulers safe;
 *   the in-process count below is a *pre-filter*, never the authority;
 * - worker launch, progress and crash reconciliation are #68/#71/#72 and
 *   reach this module only through the injected `dispatch` hook.
 *
 * Pi's RPC `prompt` is asynchronous — it returns on acceptance and events
 * stream afterwards — so `dispatch` returns a promise that the loop keeps
 * in flight. N workers therefore run concurrently from one coordinator; the
 * loop never awaits one dispatch before starting the next.
 */
import type { Phase, PhaseId, Task, TaskId, WorkflowId } from "../storage/records.ts";
import type { Store } from "../storage/db.ts";

export type { Phase, Task };

/** Why a ready task was not dispatched on this pass. */
export type HoldReason =
  | "concurrency_cap"
  | "ownership_conflict"
  | "coupling_uncertain"
  | "coupled"
  | "budget_refused"
  | "claim_lost"
  | "cancelled";

/** A task the scheduler considered but did not dispatch, and why. */
export interface HeldTask {
  readonly taskId: TaskId;
  readonly reason: HoldReason;
  readonly detail: string;
}

/** Semantic-coupling verdict for a pair of tasks (Jev's signal, #78/PLAN §3.E). */
export type CouplingVerdict = "independent" | "coupled" | "unknown";

/** What the scheduler is allowed to run right now, and what it is holding back. */
export interface DispatchPlan {
  readonly dispatch: readonly TaskId[];
  readonly held: readonly HeldTask[];
  /** In-flight count the plan was computed against. */
  readonly inFlight: number;
  /** Effective ceiling; `null` means uncapped by config. */
  readonly limit: number | null;
}

export interface SchedulerHooks {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly phaseIds: readonly PhaseId[];
}
