/**
 * Atomicity / coverage / readiness evaluators over a generated plan (issue
 * #39; PLAN §3.C "Jev evaluates atomic properties: observable outcome,
 * requirement coverage, ambiguity, verification readiness, coupling";
 * PLAN §2.3 "A task with no checks is not `ready`").
 *
 * Extends the existing plan contract (#37, `plan-schema.ts`/`plan-store.ts`)
 * rather than re-implementing it: `taskReadiness` already enforces the
 * `no_checks` rule structurally, this module composes on top of it.
 *
 * PLAN §3.C names five atomic properties. Three get a dedicated versioned
 * Jev question (`src/decisions/questions/task.ts`), one bounded question
 * each, per `.pi/skills/jev-orchestration/SKILL.md` §2 ("ask one bounded
 * question per criterion and take the conjunction in code" — never a single
 * existential "is this task good?"):
 *
 *  - **observable outcome** → `task.atomic@1`
 *  - **requirement coverage** → `task.coverage@1` (plus a structural
 *    keyword-overlap pass that runs with or without Jev, so coverage gaps
 *    are always visible — "the system must work with no Jev key")
 *  - **ambiguity** → `task.ambiguity@1`
 *  - **verification readiness** → already fully structural: `taskReadiness`
 *    (PLAN §2.3, #37) *is* this property. Nothing semantic is needed: a
 *    check either exists or it does not.
 *  - **coupling** → already fully structural: `ownershipOverlaps` (#37)
 *    flags tasks that cannot run in parallel.
 *
 * Disabled/no-key behaviour (issue #39 Scope): "structural checks only;
 * semantic evaluators report `not_evaluated` (visible, not silent)". A task
 * with no `AskContext`, or one whose transport is disabled, never gets a
 * guessed `atomic`/`ambiguity` verdict — those fields report
 * `not_evaluated` and cannot contribute a blocker. Coverage keeps working
 * because its structural half is a lexical fact, not a semantic guess.
 */
import { ask, type AskContext } from "../decisions/ask.ts";
import {
  coverageFallbackVerdict,
  taskAmbiguityQuestion,
  taskAtomicQuestion,
  taskCoverageQuestion,
  type AtomicVerdict,
} from "../decisions/questions/task.ts";
import { NO_CHECKS_BLOCKER, taskReadiness, type PlanTask } from "./plan-schema.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A semantic field's result: either a real answer, or explicitly not evaluated. */
export type SemanticResult<TValue> =
  | { readonly evaluated: true; readonly value: TValue; readonly source: "jev" | "fallback" }
  | { readonly evaluated: false };

/** The `not_evaluated` sentinel every semantic field can report. */
export const NOT_EVALUATED: SemanticResult<never> = { evaluated: false };

/** One intake requirement, as the caller states it. Opaque id + free text. */
export interface IntakeRequirement {
  readonly id: string;
  readonly text: string;
}

/** Coverage of one requirement by one task. */
export interface RequirementCoverage {
  readonly requirementId: string;
  readonly taskId: string;
  /** Structural (keyword-overlap) verdict; always present, works with no key. */
  readonly structural: boolean;
  /** Semantic verdict from `task.coverage@1`; `not_evaluated` with no Jev. */
  readonly semantic: SemanticResult<boolean>;
  /** `true` when either signal thinks this task covers the requirement. */
  readonly covered: boolean;
}

/** Per-task evaluation result. */
export interface TaskEvaluation {
  readonly taskId: string;
  /** PLAN §2.3, unchanged: a task with no checks can never be ready. */
  readonly readiness: ReturnType<typeof taskReadiness>;
  readonly atomic: SemanticResult<AtomicVerdict>;
  readonly ambiguity: SemanticResult<number>;
  /** Requirement ids this task covers, by either signal. */
  readonly coveredRequirements: readonly string[];
  /**
   * `true` only when structural readiness passes AND no `composite` verdict
   * is outstanding (issue #39 Scope: "Transition proposed → ready only when
   * structural checks pass and no `composite` verdict is outstanding").
   * A `not_evaluated`/`unclear`/`atomic` verdict never blocks by itself.
   */
  readonly canBecomeReady: boolean;
  /** Why `canBecomeReady` is false, for display; empty when it is true. */
  readonly blockers: readonly string[];
}

/** Result of evaluating a whole plan. */
export interface PlanEvaluation {
  readonly tasks: readonly TaskEvaluation[];
  readonly coverage: readonly RequirementCoverage[];
  /** Requirement ids covered by no task at all — surfaced to the user (issue #39). */
  readonly coverageGaps: readonly string[];
}

// ---------------------------------------------------------------------------
// Per-task semantic evaluation
// ---------------------------------------------------------------------------

/**
 * Ask `task.atomic@1` and `task.ambiguity@1` for one task. With no `ctx`,
 * both report `not_evaluated` — no fallback value is synthesised into a
 * "verdict", because a structural guess here would be exactly the silent
 * degrade the issue's acceptance criteria rule out. `ask()` itself always
 * has a deterministic fallback (disabled transport, no key), but that
 * fallback is treated as `not_evaluated` here too: PLAN §3.C's semantic
 * properties are Jev's to answer, and a fallback answer is not an answer.
 */
export async function evaluateTaskSemantics(
  task: Pick<PlanTask, "id" | "goal" | "acceptanceCriteria">,
  ctx?: AskContext,
): Promise<{ readonly atomic: SemanticResult<AtomicVerdict>; readonly ambiguity: SemanticResult<number> }> {
  const criteria = task.acceptanceCriteria.map((c) => c.text);
  if (ctx === undefined) {
    return { atomic: NOT_EVALUATED, ambiguity: NOT_EVALUATED };
  }
  const [atomicResult, ambiguityResult] = await Promise.all([
    ask(ctx, taskAtomicQuestion, { goal: task.goal, acceptanceCriteria: criteria }),
    ask(ctx, taskAmbiguityQuestion, { goal: task.goal, acceptanceCriteria: criteria }),
  ]);
  const atomic: SemanticResult<AtomicVerdict> =
    atomicResult.source === "jev"
      ? { evaluated: true, value: atomicResult.value, source: "jev" }
      : NOT_EVALUATED;
  const ambiguity: SemanticResult<number> =
    ambiguityResult.source === "jev"
      ? { evaluated: true, value: ambiguityResult.value, source: "jev" }
      : NOT_EVALUATED;
  return { atomic, ambiguity };
}

// ---------------------------------------------------------------------------
// Requirement coverage
// ---------------------------------------------------------------------------

/**
 * Evaluate one (requirement, task) pair. The structural half always runs —
 * "the system must work with no Jev key" applies to coverage gaps too, so a
 * `not_evaluated` semantic field must never hide a gap the keyword overlap
 * would have caught. `covered` is the disjunction: either signal being
 * confident is enough to count as covered, but a coverage *gap* (see
 * `evaluatePlan`) only exists when neither signal thinks any task covers it.
 */
export async function evaluateRequirementCoverage(
  requirement: IntakeRequirement,
  task: Pick<PlanTask, "id" | "goal" | "acceptanceCriteria">,
  ctx?: AskContext,
): Promise<RequirementCoverage> {
  const criteria = task.acceptanceCriteria.map((c) => c.text);
  const structural = coverageFallbackVerdict(requirement.text, task.goal, criteria);
  let semantic: SemanticResult<boolean> = NOT_EVALUATED;
  if (ctx !== undefined) {
    const result = await ask(ctx, taskCoverageQuestion, {
      requirement: requirement.text,
      taskGoal: task.goal,
      taskCriteria: criteria,
    });
    if (result.source === "jev") semantic = { evaluated: true, value: result.value, source: "jev" };
  }
  const covered = structural || (semantic.evaluated && semantic.value === true);
  return { requirementId: requirement.id, taskId: task.id, structural, semantic, covered };
}

// ---------------------------------------------------------------------------
// Composition: conjunction over the atomic properties, in code
// ---------------------------------------------------------------------------

/**
 * `proposed → ready` transition rule (issue #39 Scope): structural checks
 * pass (PLAN §2.3, unchanged) AND no `composite` verdict is outstanding.
 * A `composite` verdict is a real blocker regardless of what checks say —
 * mirroring the "task with no checks is never ready regardless of Jev
 * output" acceptance criterion, this direction also cannot be waived: a
 * mock or a real Jev answering `atomic` cannot make a checkless task ready,
 * and a `composite` verdict blocks a task that does have checks.
 */
export function composeTaskReadiness(
  readiness: ReturnType<typeof taskReadiness>,
  atomic: SemanticResult<AtomicVerdict>,
): { readonly canBecomeReady: boolean; readonly blockers: readonly string[] } {
  const blockers: string[] = [];
  if (!readiness.canBecomeReady) blockers.push(readiness.blocker ?? NO_CHECKS_BLOCKER);
  if (atomic.evaluated && atomic.value === "composite") blockers.push("composite_task");
  return { canBecomeReady: blockers.length === 0, blockers };
}

// ---------------------------------------------------------------------------
// Whole-plan evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate every task in a plan plus requirement coverage across the whole
 * task set. `ctx` omitted (or a disabled transport behind it) degrades to
 * structural-only evaluation: readiness and coupling are unaffected (they
 * were always structural), atomic/ambiguity report `not_evaluated`, and
 * coverage falls back to the keyword-overlap signal alone.
 */
export async function evaluatePlan(
  tasks: readonly PlanTask[],
  requirements: readonly IntakeRequirement[],
  ctx?: AskContext,
): Promise<PlanEvaluation> {
  const taskEvaluations: TaskEvaluation[] = [];
  const coverage: RequirementCoverage[] = [];

  for (const task of tasks) {
    const readiness = taskReadiness(task);
    const semantics = await evaluateTaskSemantics(task, ctx);
    const composed = composeTaskReadiness(readiness, semantics.atomic);

    const covers: string[] = [];
    for (const requirement of requirements) {
      const result = await evaluateRequirementCoverage(requirement, task, ctx);
      coverage.push(result);
      if (result.covered) covers.push(requirement.id);
    }

    taskEvaluations.push({
      taskId: task.id,
      readiness,
      atomic: semantics.atomic,
      ambiguity: semantics.ambiguity,
      coveredRequirements: covers,
      canBecomeReady: composed.canBecomeReady,
      blockers: composed.blockers,
    });
  }

  const coveredIds = new Set(coverage.filter((c) => c.covered).map((c) => c.requirementId));
  const coverageGaps = requirements.map((r) => r.id).filter((id) => !coveredIds.has(id));

  return { tasks: taskEvaluations, coverage, coverageGaps };
}

// ---------------------------------------------------------------------------
// Board display (issue #39 acceptance criterion: "Disabled Jev shows
// `not_evaluated` for semantic fields in the board")
// ---------------------------------------------------------------------------

/** Render a semantic field for the task board / `/korwf` output. */
export function formatSemanticField<TValue>(result: SemanticResult<TValue>, render: (value: TValue) => string): string {
  if (!result.evaluated) return "not_evaluated";
  return render(result.value);
}

/** One line per task, for a text board. */
export function formatTaskEvaluation(evaluation: TaskEvaluation): string {
  const atomic = formatSemanticField(evaluation.atomic, (v) => v);
  const ambiguity = formatSemanticField(evaluation.ambiguity, (v) => String(v));
  const ready = evaluation.canBecomeReady ? "ready-eligible" : `blocked (${evaluation.blockers.join(", ")})`;
  return `  - ${evaluation.taskId}: atomic=${atomic} ambiguity=${ambiguity} covers=[${evaluation.coveredRequirements.join(", ")}] ${ready}`;
}

/** Render the whole plan evaluation, including any coverage gaps. */
export function formatPlanEvaluation(evaluation: PlanEvaluation): string {
  const lines: string[] = ["Task evaluation:", ...evaluation.tasks.map(formatTaskEvaluation)];
  if (evaluation.coverageGaps.length > 0) {
    lines.push("", "Coverage gaps (no task covers this requirement):", ...evaluation.coverageGaps.map((id) => `  ! ${id}`));
  } else {
    lines.push("", "Coverage: every requirement is covered by at least one task.");
  }
  return lines.join("\n");
}
