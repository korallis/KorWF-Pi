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

// ---------------------------------------------------------------------------
// Declared ownership overlap (PLAN §3.E, "detected in code")
// ---------------------------------------------------------------------------

/** The declared paths and components two tasks both claim. */
export interface OwnershipOverlap {
  readonly paths: readonly string[];
  readonly components: readonly string[];
}

/**
 * Declared ownership overlap between two tasks: exactly the paths and
 * components both `Task.ownership` lists name. No normalisation beyond
 * exact string equality — `plan-schema.ts` already warns about the same
 * overlap at plan time using the same comparison, and inventing a
 * path-prefix rule here would make the two disagree.
 */
export function ownershipOverlap(a: Task, b: Task): OwnershipOverlap {
  const paths = new Set(a.ownership.paths);
  const components = new Set(a.ownership.components);
  return {
    paths: b.ownership.paths.filter((p) => paths.has(p)),
    components: b.ownership.components.filter((c) => components.has(c)),
  };
}

/** `true` when the two tasks declare any path or component in common. */
export function conflictsOnOwnership(a: Task, b: Task): boolean {
  const overlap = ownershipOverlap(a, b);
  return overlap.paths.length > 0 || overlap.components.length > 0;
}

/**
 * Semantic-coupling signal, supplied by the caller (Jev, issue #78).
 *
 * Returning `"unknown"` — or having no signal at all, which is what happens
 * with no Jev key — means the pair is treated as coupled and therefore
 * serialised: PLAN §3.E's "default to serial when coupling is uncertain".
 * The deterministic fallback is the conservative one, so the product works
 * unchanged with Jev disabled.
 */
export type CouplingSignal = (a: Task, b: Task) => CouplingVerdict;

/** The no-Jev default: every pair is uncertain, so every pair serialises. */
export const UNCERTAIN_COUPLING: CouplingSignal = () => "unknown";

/**
 * May `candidate` run at the same time as `other`? Declared ownership
 * overlap is decided in code and is not overridable by any signal — a
 * coupling verdict of `"independent"` cannot unblock two tasks that both
 * claim `src/foo.ts`. Only when there is no declared overlap does the
 * semantic signal get a say, and there `unknown` means no.
 */
export function mayRunConcurrently(
  candidate: Task,
  other: Task,
  coupling: CouplingSignal,
): { readonly ok: boolean; readonly reason: HoldReason | null; readonly detail: string } {
  const overlap = ownershipOverlap(candidate, other);
  if (overlap.paths.length > 0 || overlap.components.length > 0) {
    const what = [...overlap.paths, ...overlap.components].join(", ");
    return {
      ok: false,
      reason: "ownership_conflict",
      detail: `task ${candidate.id} and ${other.id} both declare ownership of ${what}`,
    };
  }
  const verdict = coupling(candidate, other);
  if (verdict === "coupled") {
    return {
      ok: false,
      reason: "coupled",
      detail: `task ${candidate.id} is semantically coupled to ${other.id}; running serially`,
    };
  }
  if (verdict === "unknown") {
    return {
      ok: false,
      reason: "coupling_uncertain",
      detail:
        `coupling between ${candidate.id} and ${other.id} is uncertain; ` +
        `defaulting to serial (PLAN §3.E)`,
    };
  }
  return { ok: true, reason: null, detail: "" };
}
