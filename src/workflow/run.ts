/**
 * `/korwf run <phase-id | all>` (issue #74; PLAN §2.1, §2.6).
 *
 * Cost estimate shown BEFORE a run begins, so the user can decline before
 * anything is spent. Any stop leaves resumable state.
 */
import type { Store } from "../storage/db.ts";
import type { IsoTimestamp, Phase, PhaseId, Task, WorkflowId } from "../storage/records.ts";
import type { TransitionActor } from "../storage/transition-log.ts";
import { TASK_TERMINAL_STATES } from "./transitions.ts";
import { classifyCost, type PriceMetadata, type TokenCounts } from "../telemetry/ledger.ts";
import { transitionPhase, TransitionRejected } from "./state.ts";

/** Identifies one `/korwf run` invocation, printed to the user and carried on everything it starts. */
export type RunId = string & { readonly __brand: "RunId" };

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
      const tokens = tokensForTask(task);
      const price = priceForTask(task);
      const usage = classifyCost({
        basis: "estimated",
        ...(tokens === null ? {} : { tokens }),
        ...(price === null ? {} : { price }),
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
  readonly actor: TransitionActor;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
  /**
   * Approval re-check for `authorization_current` (PLAN §2.4 "scope
   * approved"). The caller (the `/korwf run` command) has already resolved
   * this against the live `Approval` table before showing the estimate;
   * this hook lets that same verdict gate the transition rather than being
   * re-derived here.
   */
  readonly authorizationCurrent: (phaseId: PhaseId) => boolean;
}

export interface StartRunResult {
  readonly phaseId: PhaseId;
  readonly ok: boolean;
  readonly phase: Phase | null;
  readonly reason: string | null;
}

export interface StartRunOutcome {
  /**
   * Identity of this `/korwf run` invocation (issue #74; PLAN §2.1 "print
   * the run id"). Minted once, before any phase is touched, and persisted
   * (`store.runs`) so it survives a restart — #72's crash reconciliation
   * and this module's own `stopRun` can both name the run they resume.
   */
  readonly runId: RunId;
  readonly results: readonly StartRunResult[];
}



/**
 * `phase_start_valid` (PLAN §2.1, docs/state-machine.md §4): at least one
 * schedulable task, or every task already done and gating needs retry.
 * Computed structurally from the store — never trusted from a caller claim,
 * matching `state.ts`'s "deterministic checks cannot be waived" rule.
 */
function phaseStartValid(store: Store, phaseId: PhaseId): boolean {
  const tasks = store.tasks.forPhase(phaseId);
  if (tasks.length === 0) return false;
  const allDone = tasks.every((t) => t.status === "done");
  if (allDone) return true;
  return tasks.some((t) => t.status === "proposed" || t.status === "ready");
}

/**
 * Start (or resume-into) each targeted phase: `phase-start` (`pending` →
 * `running`), through `src/workflow/state.ts`, the only writer of
 * `Phase.gateStatus`. Scheduling the ready tasks themselves is #75; this
 * function only performs the phase-level transition the cost estimate was
 * shown for. One phase's refusal does not block the others — each result is
 * reported so a caller can see exactly which phases actually started.
 */
export function startRun(params: StartRunParams): StartRunOutcome {
  const { store, phaseIds, actor, now, newId, authorizationCurrent } = params;

  // Minted and persisted BEFORE any phase is touched: the id the user sees
  // must name the run even if every phase below refuses (issue #74's own
  // absolute rule, applied here as well as to the estimate).
  const runId = newId() as RunId;
  store.runs.insert({ runId, createdAt: now(), workflowId: params.workflowId, phaseIds });

  const results = phaseIds.map((phaseId) => {
    const guards = {
      phase_start_valid: () => phaseStartValid(store, phaseId),
      authorization_current: () => authorizationCurrent(phaseId),
    } as const;
    try {
      const result = transitionPhase({
        store,
        phaseId,
        to: "running",
        trigger: "run",
        actor,
        now,
        newId,
        evidenceRefs: [`run:${phaseId}`, `runId:${runId}`],
        guards,
      });
      // Tag the phase with the run that started it (issue #74 Scope "phases
      // started by that run carry it"), so status can group by run instead
      // of guessing from timing.
      const tagged = store.phases.update(result.subject.id, { runId });
      return { phaseId, ok: true, phase: tagged, reason: null };
    } catch (error) {
      if (error instanceof TransitionRejected) {
        return { phaseId, ok: false, phase: null, reason: error.message };
      }
      throw error;
    }
  });
  return { runId, results };
}

export interface StopRunParams {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly actor: TransitionActor;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
  /** Human-readable reason recorded on the pause blocker; never blank. */
  readonly reason: string;
  /** `true` files this as a budget/cap stop (`paused_cap`) rather than a manual one (`paused_approval`). */
  readonly budgetStop?: boolean;
}

export interface StopRunResult {
  readonly phaseId: PhaseId;
  readonly ok: boolean;
  readonly phase: Phase | null;
  readonly reason: string | null;
}

/**
 * Deliberate stop, leaving resumable state (issue #74; PLAN §2.6 "a
 * resumable state on any stop"). Every non-terminal phase of the workflow
 * moves `phase-pause` (any nonterminal state → `paused`), through
 * `src/workflow/state.ts` — the same single writer of `Phase.gateStatus`
 * that #72's crash reconciliation uses for the involuntary case. A
 * deliberate stop and a crash both land the workflow in the same resumable
 * shape: `paused_cap`/`paused_approval`, a blocker row naming why, and
 * running attempts/worktrees left intact for `/korwf resume` or the next
 * `run` to pick back up — nothing here deletes or rewinds work.
 *
 * Tasks are deliberately left alone: `state.ts`'s own `task-block` edge is
 * how a live task pauses, and the scheduler (#75) is what actually asks a
 * running worker to stop. This function's job is only the phase-level
 * record of the stop and its resumability, matching the scope of
 * `startRun`.
 */
export function stopRun(params: StopRunParams): readonly StopRunResult[] {
  const { store, workflowId, actor, now, newId, reason, budgetStop } = params;
  const phases = store.phases
    .forWorkflow(workflowId)
    .filter((p) => p.gateStatus !== "passed" && p.gateStatus !== "cancelled");

  return phases.map((phase) => {
    const guards = { phase_stop_present: () => true } as const;
    try {
      const result = transitionPhase({
        store,
        phaseId: phase.id,
        to: "paused",
        trigger: "phase_stop",
        actor,
        now,
        newId,
        evidenceRefs: [`stop:${phase.id}:${reason}`],
        blocker: { kind: budgetStop === true ? "budget_hard_stop" : "user_stop", detail: reason },
        guards,
      });
      return { phaseId: phase.id, ok: true, phase: result.subject, reason: null };
    } catch (error) {
      if (error instanceof TransitionRejected) {
        return { phaseId: phase.id, ok: false, phase: null, reason: error.message };
      }
      throw error;
    }
  });
}
