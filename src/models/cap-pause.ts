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
import type { Phase, Task } from "../storage/records.ts";

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

/** Auto-resume: `task-cap-resume` + `phase-cap-resume` once a watched route clears. No user action required. */
export function resumeIfCapCleared(deps: CapPauseDeps): void {
  throw new Error("todo");
}
