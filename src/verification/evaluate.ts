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

export { TEST_EXERCISES_MIN_LEVEL };
export type { ClaimVerdict, CriterionRef, EvidenceGapState, EvidenceSummary, RiskClass };
export { ask, claimSupportedQuestion, evidenceGapFallback, evidenceGapQuestion, testExercisesQuestion };
export type { AskContext, DecisionResult };
