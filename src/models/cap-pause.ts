/**
 * Applies a `chooseFallback` (#63) decision to task/phase state, through
 * `src/workflow/state.ts` (#41) — that module is the only writer of
 * `Task.status`/`Phase.gateStatus`; this one never touches a row directly.
 */
import type { Store } from "../storage/db.ts";
import type { IsoTimestamp, PhaseId, TaskId } from "../storage/records.ts";
import type { TransitionActor } from "../storage/transition-log.ts";
import type { FallbackDecision } from "./fallback.ts";
import { transitionPhase, transitionTask, type TransitionResult } from "../workflow/state.ts";
import type { Phase, RouteId, Task } from "../storage/records.ts";
import type { RouteAvailabilityTable } from "./availability.ts";
import { resolveBlockersOfKind } from "../workflow/blockers.ts";

export interface CapPauseDeps {
  readonly store: Store;
  readonly taskId: TaskId;
  readonly phaseId: PhaseId;
  readonly actor: TransitionActor;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
}

export interface CapPauseResult {
  readonly task: TransitionResult<Task>;
  readonly phase: TransitionResult<Phase>;
}

/**
 * Pause the task (`task-cap`) and its parent phase (`phase-cap`) on an
 * `all_capped`/`no_adequate` `chooseFallback` decision — through
 * `src/workflow/state.ts` (#41), the only writer of `Task.status`/
 * `Phase.gateStatus`. `all_eligible_models_capped` is satisfied here because
 * `chooseFallback` has already established a nonempty, code-computed
 * eligible set with every member capped (PLAN §3.D §4.1: "not vacuous
 * all-capped"); this module trusts that upstream computation rather than
 * repeating it, same as `blockers.ts` trusts a raised blocker row.
 */
export function applyCapPause(
  deps: CapPauseDeps,
  decision: Extract<FallbackDecision, { kind: "pause" }>,
): CapPauseResult {
  const { store, actor, now, newId } = deps;
  const detail =
    decision.reason === "no_adequate"
      ? `no adequate substitute for this task profile (${decision.blocker})`
      : decision.reason === "pin_capped"
        ? `pinned model is capped; ask before any substitute (${decision.blocker})`
        : decision.reason === "prefer_wait"
          ? `waiting for the primary's cap to clear (${decision.blocker})`
          : `all eligible candidates capped (${decision.blocker})`;
  const guards = { all_eligible_models_capped: () => true } as const;

  return store.write(() => {
    const task = transitionTask({
      store,
      taskId: deps.taskId,
      to: "paused_cap",
      trigger: "all_candidates_capped",
      actor,
      now,
      newId,
      evidenceRefs: [`availability:earliest_reset=${decision.earliestReset ?? "unknown"}`, ...decision.watchRoutes.map((r) => `route:${r}`)],
      blocker: { kind: "all_candidates_capped", detail },
      guards,
    });
    const phase = transitionPhase({
      store,
      phaseId: deps.phaseId,
      to: "paused",
      trigger: "all_candidates_capped",
      actor,
      now,
      newId,
      evidenceRefs: [`availability:earliest_reset=${decision.earliestReset ?? "unknown"}`],
      blocker: { kind: "all_candidates_capped", detail },
      guards,
    });
    return { task, phase };
  });
}

/** Optional caller-supplied guards for `authorization_current`/`recovery_authorized` (default: satisfied). */
export interface ResumeGuards {
  readonly authorizationCurrent?: () => boolean;
  readonly recoveryAuthorized?: () => boolean;
}

/**
 * Auto-resume: `task-cap-resume` then `phase-cap-resume`, once any watched
 * route's cap has cleared (`RouteAvailabilityTable.isEligible`) — with NO
 * user action (PLAN §3.D "resume when a cap clears"; docs/state-machine.md
 * §4.1 "Auto-resume is allowed only ... when at least one formerly capped
 * eligible model becomes available"). Returns `null` when nothing has
 * cleared yet: a reset timer is a reason to re-check, never proof of
 * success (§4.1), so this never speculatively resumes.
 */
export function resumeIfCapCleared(
  deps: CapPauseDeps,
  watchRoutes: readonly RouteId[],
  availability: RouteAvailabilityTable,
  guards: ResumeGuards = {},
): CapPauseResult | null {
  const { store, actor, now, newId } = deps;
  const at = now();
  if (!watchRoutes.some((routeId) => availability.isEligible(routeId, at))) return null;

  const resumeGuards = {
    cap_resume_valid: () => true,
    authorization_current: guards.authorizationCurrent ?? (() => true),
    recovery_authorized: guards.recoveryAuthorized ?? (() => true),
  } as const;

  return store.write(() => {
    // Resolve the cap blocker the pause raised, *before* the guard runs: the
    // structural `readiness_valid` guard reads unresolved rows from the
    // store, and a cap clearing must not "clear another unresolved reason"
    // (approval, manual pause, budget hard stop) — only this kind
    // (docs/state-machine.md §4.1). Any other unresolved blocker keeps the
    // guard failing, as it should. Same transaction as the transitions below.
    resolveBlockersOfKind({
      store,
      actor,
      now,
      newId,
      subjectKind: "task",
      subjectId: deps.taskId,
      kind: "all_candidates_capped",
      detail: `resolved: route available at ${at}`,
    });
    resolveBlockersOfKind({
      store,
      actor,
      now,
      newId,
      subjectKind: "phase",
      subjectId: deps.phaseId,
      kind: "all_candidates_capped",
      detail: `resolved: route available at ${at}`,
    });

    const task = transitionTask({
      store,
      taskId: deps.taskId,
      to: "ready",
      trigger: "eligible_cap_cleared",
      actor,
      now,
      newId,
      evidenceRefs: [`availability:cleared_at=${at}`, ...watchRoutes.map((r) => `route:${r}`)],
      guards: resumeGuards,
    });
    const phase = transitionPhase({
      store,
      phaseId: deps.phaseId,
      to: "running",
      trigger: "eligible_cap_cleared",
      actor,
      now,
      newId,
      evidenceRefs: [`availability:cleared_at=${at}`],
      guards: resumeGuards,
    });
    return { task, phase };
  });
}
