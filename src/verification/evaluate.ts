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

// placeholder: thresholds, inputs, evaluation and recording are added below

export { TEST_EXERCISES_MIN_LEVEL };
export type { ClaimVerdict, CriterionRef, EvidenceGapState, EvidenceSummary, RiskClass };
export { ask, claimSupportedQuestion, evidenceGapFallback, evidenceGapQuestion, testExercisesQuestion };
export type { AskContext, DecisionResult };
