/**
 * The evidence-gap evaluator — condition 2 of the task gate (issue #47;
 * PLAN §2.4 (2), §3.F, §6; deliverable `src/verification/evaluate.ts`).
 *
 * > **PLAN §2.4 (2)** Jev finds no evidence gap — completion claim is
 * > supported by the presented evidence; every acceptance criterion maps to a
 * > check or evidence item; tests exercise the requirement rather than
 * > something unrelated.
 *
 * What this module is, and is not:
 *
 * - It **supplies** the evaluators `src/verification/task-gate.ts` (#46)
 *   consumes. It does not re-implement the gate, and it cannot waive a
 *   deterministic check: the gate computes C1 and C3 without reading a single
 *   `Decision`, and the only thing this module produces is a `Decision`.
 * - It **decomposes**. `.pi/skills/jev-orchestration/SKILL.md` §2: a single
 *   existential "does this evidence support completion?" deflates as scope is
 *   itemised, independent of real completeness. So the three questions in
 *   `src/decisions/questions/verify.ts` are asked once per acceptance
 *   criterion (and once per (test, criterion) pair), and the conjunction is
 *   taken **here, in code**, with `allTrue`/`anyTrue` from
 *   `src/decisions/compose.ts`.
 * - It **never turns an abstention into a pass**. An abstention, an
 *   `unknown`, a transport error, a missing answer and a below-threshold
 *   answer all land on the same outcome: a gap naming the criterion.
 * - It **works with no Jev key**. The deterministic fallback is the mapping
 *   rule: every acceptance criterion needs at least one linked *passing*
 *   check and at least one passing evidence item attributed to it. Semantic
 *   dimensions then report `not_evaluated` — visible, never a silent pass.
 */
import { ask, type AskContext, type DecisionResult } from "../decisions/ask.ts";
import {
  claimSupportedQuestion,
  evidenceGapFallback,
  evidenceGapQuestion,
  testExercisesQuestion,
  TEST_EXERCISES_MIN_LEVEL,
  type ClaimVerdict,
  type CriterionRef,
  type EvidenceGapState,
  type EvidenceSummary,
} from "../decisions/questions/verify.ts";
import type { RiskClass } from "../storage/records.ts";

// ---------------------------------------------------------------------------
// Thresholds per risk class (issue #47 Scope: "thresholds per risk class from
// config (conservative defaults; abstain → treat as gap)")
// ---------------------------------------------------------------------------

/** Confidence/score floors one risk class applies. All comparisons are code. */
export interface EvaluatorThresholds {
  /**
   * Minimum confidence for a `supported` claim answer to count. Below it the
   * answer is an abstention, and an abstention is a gap.
   */
  readonly claimConfidence: number;
  /**
   * Maximum probability-of-gap that still counts as "no gap". Deliberately
   * expressed as a ceiling on the *gap* side: a noul near the middle is not
   * evidence of absence.
   */
  readonly gapCeiling: number;
  /** Lowest `verify.test_exercises@1` level that credits a test. */
  readonly testExercisesMinLevel: number;
  /**
   * Must at least one linked test be *semantically* credited for a criterion
   * when Jev answered? `true` for higher risk classes: there, a criterion
   * whose tests are all level 0/1 is a gap even if the claim looked
   * supported.
   */
  readonly requireExercisingTest: boolean;
}

/**
 * Shipped defaults, conservative per PLAN §6 ("until enough data exists, use
 * conservative defaults and abstention"). Higher risk ⇒ stricter, never
 * looser. These are the values used when no config is supplied; a caller
 * passes `thresholdsFor(config.verification, riskClass)` in the product.
 */
export const DEFAULT_EVALUATOR_THRESHOLDS: Readonly<Record<RiskClass, EvaluatorThresholds>> = Object.freeze({
  low: Object.freeze({
    claimConfidence: 0.6,
    gapCeiling: 0.35,
    testExercisesMinLevel: TEST_EXERCISES_MIN_LEVEL,
    requireExercisingTest: false,
  }),
  medium: Object.freeze({
    claimConfidence: 0.7,
    gapCeiling: 0.25,
    testExercisesMinLevel: TEST_EXERCISES_MIN_LEVEL,
    requireExercisingTest: true,
  }),
  high: Object.freeze({
    claimConfidence: 0.8,
    gapCeiling: 0.15,
    testExercisesMinLevel: TEST_EXERCISES_MIN_LEVEL + 1,
    requireExercisingTest: true,
  }),
});

/**
 * Thresholds for a risk class, with optional per-class overrides from config.
 *
 * An override may only make a threshold **stricter**: AGENTS.md §4, "the
 * system never weakens its own permission, allowlist or spending policy", and
 * the same reasoning applies to a verification floor. A config that tries to
 * lower a floor is ignored on that field rather than rejected, so a bad value
 * can never open the gate.
 */
export function thresholdsFor(
  riskClass: RiskClass,
  overrides?: Partial<Record<RiskClass, Partial<EvaluatorThresholds>>>,
): EvaluatorThresholds {
  const base = DEFAULT_EVALUATOR_THRESHOLDS[riskClass];
  const over = overrides?.[riskClass];
  if (over === undefined) return base;
  return Object.freeze({
    claimConfidence: Math.max(base.claimConfidence, over.claimConfidence ?? base.claimConfidence),
    gapCeiling: Math.min(base.gapCeiling, over.gapCeiling ?? base.gapCeiling),
    testExercisesMinLevel: Math.max(base.testExercisesMinLevel, over.testExercisesMinLevel ?? base.testExercisesMinLevel),
    requireExercisingTest: base.requireExercisingTest || (over.requireExercisingTest ?? false),
  });
}

// ---------------------------------------------------------------------------
// Inputs: minimal, already-filtered material about one task
// ---------------------------------------------------------------------------

/** One check linked to a criterion, with the state #51 assigned it. */
export interface LinkedCheck {
  readonly checkId: string;
  readonly command: string;
  /** `pass` / `fail` / `flaky` / `missing` / `unavailable` / `timeout`. */
  readonly state: string;
  /** Criterion ids the check *claims* to cover (`CheckDefinition.coversCriteria`). */
  readonly coversCriteria: readonly string[];
}

/** One test file linked to a criterion, with a filtered excerpt of its source. */
export interface LinkedTest {
  readonly checkId: string;
  readonly command: string;
  readonly testPath: string;
  /** Already filtered and truncated by the caller; #28 filters again. */
  readonly excerpt: string;
  readonly coversCriteria: readonly string[];
}

/**
 * Everything the evaluator reads. Assembled by the caller from the store and
 * `src/git/`; deliberately **not** the `Task`/`Evidence` records themselves,
 * so nothing that must not leave the machine can reach a question state by
 * accident (issue #47 Scope: "never the full diff").
 */
export interface EvidenceGapInput {
  readonly taskId: string;
  readonly taskGoal: string;
  readonly riskClass: RiskClass;
  readonly acceptanceCriteria: readonly CriterionRef[];
  readonly checks: readonly LinkedCheck[];
  readonly tests: readonly LinkedTest[];
  /** Evidence items, already summarised and attributed to a criterion. */
  readonly evidence: readonly (EvidenceSummary & { readonly requirementId: string })[];
  /** The worker's completion summary. Untrusted text, judged never trusted. */
  readonly claim: string;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** A semantic dimension either has an answer, or explicitly has none. */
export type Evaluated<TValue> =
  | { readonly evaluated: true; readonly value: TValue; readonly source: "jev" }
  | { readonly evaluated: false; readonly reason: "jev_disabled" | "abstained" | "not_asked" };

/** Why a criterion was flagged. A closed set, so a refusal is machine-readable. */
export const GAP_REASONS = [
  "no_linked_check",
  "no_passing_check",
  "no_passing_evidence",
  "claim_unsupported",
  "claim_unknown",
  "jev_reports_gap",
  "jev_abstained",
  "no_exercising_test",
] as const;
export type GapReason = (typeof GAP_REASONS)[number];

/** Per-(test, criterion) verdict. */
export interface TestExercisesFinding {
  readonly criterionId: string;
  readonly checkId: string;
  readonly testPath: string;
  readonly level: Evaluated<number>;
  /** `true` only when a Jev level cleared this risk class's floor. */
  readonly exercises: boolean;
}

/** Everything known about one acceptance criterion after evaluation. */
export interface CriterionFinding {
  readonly criterionId: string;
  readonly criterionText: string;
  /** `true` when this criterion is a gap. Conjunction of the parts, in code. */
  readonly gap: boolean;
  /** Every reason, in `GAP_REASONS` order; empty only when `gap` is false. */
  readonly reasons: readonly GapReason[];
  /** The mapping rule: ≥1 linked passing check AND ≥1 passing evidence row. */
  readonly mapped: boolean;
  readonly claim: Evaluated<ClaimVerdict>;
  readonly semanticGap: Evaluated<boolean>;
  readonly tests: readonly TestExercisesFinding[];
  /** Decision ids written for this criterion, for `/korwf why`. */
  readonly decisionIds: readonly string[];
}

/** The whole-task result. `action` is what the gate's C2 Decision records. */
export interface EvidenceGapEvaluation {
  readonly taskId: string;
  /** `true` when no criterion is a gap AND there is at least one criterion. */
  readonly noGap: boolean;
  /** `"no_gap"` | `"gap"`; exactly the vocabulary task-gate.ts C2 matches on. */
  readonly action: "no_gap" | "gap";
  /** Criterion ids with a gap, in input order (issue #47 Scope). */
  readonly gapCriterionIds: readonly string[];
  readonly findings: readonly CriterionFinding[];
  /** `true` when any part came from a deterministic fallback. */
  readonly degraded: boolean;
  /** Composition rule recorded alongside the parts. */
  readonly rule: string;
  /** Lowest confidence across the answers that decided the outcome; `null` with none. */
  readonly confidence: number | null;
  readonly thresholds: EvaluatorThresholds;
}

// ---------------------------------------------------------------------------
// The deterministic mapping rule — the whole of condition 2 with no Jev key
// ---------------------------------------------------------------------------

/** Checks that claim to cover this criterion. */
export function checksFor(input: EvidenceGapInput, criterionId: string): readonly LinkedCheck[] {
  return input.checks.filter((c) => c.coversCriteria.includes(criterionId));
}

/** Tests linked to this criterion. */
export function testsFor(input: EvidenceGapInput, criterionId: string): readonly LinkedTest[] {
  return input.tests.filter((t) => t.coversCriteria.includes(criterionId));
}

/** Evidence items attributed to this criterion. */
export function evidenceFor(
  input: EvidenceGapInput,
  criterionId: string,
): readonly (EvidenceSummary & { readonly requirementId: string })[] {
  return input.evidence.filter((e) => e.requirementId === criterionId);
}

/** The `EvidenceGapState` for one criterion. One place builds it, so the
 *  question and the fallback always see the same facts. */
export function gapStateFor(input: EvidenceGapInput, criterion: CriterionRef): EvidenceGapState {
  return {
    criterionId: criterion.id,
    criterionText: criterion.text,
    linkedChecks: checksFor(input, criterion.id).map((c) => ({
      checkId: c.checkId,
      command: c.command,
      state: c.state,
    })),
    evidence: evidenceFor(input, criterion.id).map((e) => ({
      checkId: e.checkId,
      command: e.command,
      state: e.state,
      paths: e.paths,
      excerpt: e.excerpt,
    })),
  };
}

/**
 * The mapping rule, per criterion. This is what "meaningful with Jev
 * disabled" means concretely (issue #47 Scope: "each criterion must have ≥1
 * linked passing check"; and a passing evidence item, because a check
 * definition is a promise and an evidence row is an observation).
 *
 * It is deliberately the *same predicate* the question's fallback uses
 * (`evidenceGapFallback`), called on the *same state*, so disabled mode and
 * an abstaining Jev cannot disagree about structure.
 */
export function mappingReasons(input: EvidenceGapInput, criterion: CriterionRef): readonly GapReason[] {
  const out: GapReason[] = [];
  const linked = checksFor(input, criterion.id);
  if (linked.length === 0) out.push("no_linked_check");
  else if (!linked.some((c) => c.state === "pass")) out.push("no_passing_check");
  if (!evidenceFor(input, criterion.id).some((e) => e.state === "pass")) out.push("no_passing_evidence");
  return out;
}

/** `true` when the criterion satisfies the mapping rule outright. */
export function isMapped(input: EvidenceGapInput, criterion: CriterionRef): boolean {
  return mappingReasons(input, criterion).length === 0;
}

export { TEST_EXERCISES_MIN_LEVEL };
export type { ClaimVerdict, CriterionRef, EvidenceGapState, EvidenceSummary, RiskClass };
export { ask, claimSupportedQuestion, evidenceGapFallback, evidenceGapQuestion, testExercisesQuestion };
export type { AskContext, DecisionResult };
