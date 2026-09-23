/**
 * `/korwf run <phase-id | all>` (issue #74; PLAN §2.1, §2.6).
 *
 * Cost estimate shown BEFORE a run begins, so the user can decline before
 * anything is spent. Any stop leaves resumable state.
 */
import type { Store } from "../storage/db.ts";
import type { PhaseId, WorkflowId } from "../storage/records.ts";

export interface RunEstimatePhase {
  readonly phaseId: PhaseId;
  readonly tasks: number;
  readonly knownUsd: number;
  readonly estimatedUsd: number;
  readonly unknownTasks: number;
}

/** Cost estimate shown BEFORE a run begins, so the user can decline. */
export interface RunEstimate {
  readonly tasks: number;
  readonly knownUsd: number;
  readonly estimatedUsd: number;
  readonly unknownTasks: number;
  readonly perPhase: readonly RunEstimatePhase[];
}

export interface EstimateRunParams {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly phaseIds: readonly PhaseId[];
}

export function estimateRun(_params: EstimateRunParams): RunEstimate {
  throw new Error("todo");
}

export interface StartRunParams {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly phaseIds: readonly PhaseId[];
}

export function startRun(_params: StartRunParams): void {
  throw new Error("todo");
}

export interface StopRunParams {
  readonly store: Store;
  readonly workflowId: WorkflowId;
}

export function stopRun(_params: StopRunParams): void {
  throw new Error("todo");
}
