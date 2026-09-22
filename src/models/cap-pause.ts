/**
 * Applies a `chooseFallback` (#63) decision to task/phase state, through
 * `src/workflow/state.ts` (#41) — that module is the only writer of
 * `Task.status`/`Phase.gateStatus`; this one never touches a row directly.
 */
import type { Store } from "../storage/db.ts";
import type { IsoTimestamp, PhaseId, TaskId } from "../storage/records.ts";
import type { TransitionActor } from "../storage/transition-log.ts";
import type { FallbackDecision } from "./fallback.ts";

export interface CapPauseDeps {
  readonly store: Store;
  readonly taskId: TaskId;
  readonly phaseId: PhaseId;
  readonly actor: TransitionActor;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
}

/** Pause the task (`task-cap`) and its parent phase (`phase-cap`) on an `all_capped`/`no_adequate` decision. */
export function applyCapPause(deps: CapPauseDeps, decision: Extract<FallbackDecision, { kind: "pause" }>): void {
  throw new Error("todo");
}

/** Auto-resume: `task-cap-resume` + `phase-cap-resume` once a watched route clears. No user action required. */
export function resumeIfCapCleared(deps: CapPauseDeps): void {
  throw new Error("todo");
}
