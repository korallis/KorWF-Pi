/**
 * `/korwf run <phase-id | all>` (issue #74; PLAN §2.1, §2.6).
 *
 * Cost estimate shown BEFORE a run begins, so the user can decline before
 * anything is spent. Any stop leaves resumable state.
 */
import type { Store } from "../storage/db.ts";
import type { PhaseId, Task, WorkflowId } from "../storage/records.ts";
import { TASK_TERMINAL_STATES } from "./transitions.ts";
import { classifyCost, type PriceMetadata, type TokenCounts } from "../telemetry/ledger.ts";

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
  /**
   * Per-task expected token counts, from the planner's `expectedArtifacts`
   * sizing (#124) or a caller-supplied heuristic. `null`/absent means
   * genuinely unknown — never assumed zero (PLAN §3.I).
   */
  readonly tokensForTask?: (task: Task) => TokenCounts | null;
  /** Per-task model price, from the model card the task would use. */
  readonly priceForTask?: (task: Task) => PriceMetadata | null;
}

/**
 * Sum an honest cost estimate over every non-terminal task of the targeted
 * phases (issue #74; PLAN §2.6 "a cost estimate before run begins").
 *
 * Uses `graph.ts`'s definition of ready/pending work — non-terminal tasks —
 * rather than re-deriving it, and `telemetry/ledger.ts`'s `classifyCost` so
 * the known/estimated/unknown rule is the one true rule (#30): a task with
 * no price metadata or no token estimate contributes to `unknownTasks`, never
 * to `knownUsd`/`estimatedUsd` as a fabricated `$0`.
 */
export function estimateRun(params: EstimateRunParams): RunEstimate {
  const { store, phaseIds } = params;
  const tokensForTask = params.tokensForTask ?? (() => null);
  const priceForTask = params.priceForTask ?? (() => null);

  const perPhase: RunEstimatePhase[] = [];
  let totalTasks = 0;
  let totalKnown = 0;
  let totalEstimated = 0;
  let totalUnknown = 0;

  for (const phaseId of phaseIds) {
    const tasks = store.tasks
      .forPhase(phaseId)
      .filter((task) => !(TASK_TERMINAL_STATES as readonly string[]).includes(task.status));

    let knownUsd = 0;
    let estimatedUsd = 0;
    let unknownTasks = 0;
    for (const task of tasks) {
      const usage = classifyCost({
        tokens: tokensForTask(task) ?? undefined,
        price: priceForTask(task),
        basis: "estimated",
      });
      if (usage.costBasis === "unknown") {
        unknownTasks += 1;
      } else if (usage.costBasis === "known") {
        knownUsd += usage.spendUsd ?? 0;
      } else {
        estimatedUsd += usage.spendUsd ?? 0;
      }
    }

    perPhase.push({ phaseId, tasks: tasks.length, knownUsd, estimatedUsd, unknownTasks });
    totalTasks += tasks.length;
    totalKnown += knownUsd;
    totalEstimated += estimatedUsd;
    totalUnknown += unknownTasks;
  }

  return {
    tasks: totalTasks,
    knownUsd: totalKnown,
    estimatedUsd: totalEstimated,
    unknownTasks: totalUnknown,
    perPhase,
  };
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
