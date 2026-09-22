/**
 * Completion-claim, evidence-gap and test-exercises-requirement questions
 * (issue #47; PLAN §2.4 (2), §3.F, §6; deliverable
 * `src/decisions/questions/verify.ts`).
 *
 * These are the Jev questions behind **condition 2** of the task gate
 * (`src/verification/task-gate.ts`, #46). This module supplies the
 * evaluators; it never re-implements the gate, and nothing here can waive a
 * deterministic check.
 *
 * `.pi/skills/jev-orchestration/SKILL.md` §2 records the lesson this file is
 * shaped by: a single existential "does this evidence support completion?"
 * **deflates as the scope is itemised**, independent of real completeness.
 * So there is no whole-task question here. Every question is asked about
 * exactly one acceptance criterion (or one (test, criterion) pair), and
 * `src/verification/evaluate.ts` takes the conjunction in code.
 *
 *  - `verify.claim_supported@1` (choice) — for ONE criterion: does the
 *    presented evidence support the worker's claim about it?
 *    `supported` / `unsupported` / `unknown`.
 *  - `verify.evidence_gap@1` (noul) — for ONE criterion: is there a gap,
 *    i.e. does this criterion lack an evidence item that actually
 *    demonstrates it?
 *  - `verify.test_exercises@1` (score) — for ONE (test, criterion) pair: how
 *    much of the criterion does this test actually exercise? This is the
 *    semantic counterpart of #44's `isVerifyingCheck`: that one rejects a
 *    command that *cannot fail*; this one catches a test that runs, passes,
 *    and asserts nothing about the criterion it is linked to.
 *
 * Every fallback is deterministic and structural (PLAN §2.4 "the system must
 * work with no Jev key"). None of them ever invents a semantic pass: the
 * fallbacks answer `unknown` / "gap" / level 0 unless the *structure* itself
 * says otherwise, and `src/verification/evaluate.ts` treats abstention and
 * `unknown` as a gap in every case.
 */
import { defineChoice, defineNoul, defineScore, type QuestionDefinition } from "../question.ts";
import { QuestionRegistry } from "../registry.ts";

// placeholder: question definitions are added below

/** Hashes as reviewed; editing prompt/options/levels without a version bump fails registration. */
export const VERIFY_QUESTION_HASHES: Readonly<Record<string, string>> = Object.freeze({});

export const verifyQuestionRegistry = new QuestionRegistry();

export { defineChoice, defineNoul, defineScore };
export type { QuestionDefinition };
