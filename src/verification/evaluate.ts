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
  evidenceGapQuestion,
  testExercisesQuestion,
  TEST_EXERCISES_MIN_LEVEL,
  type ClaimVerdict,
  type CriterionRef,
  type EvidenceGapState,
  type EvidenceSummary,
} from "../decisions/questions/verify.ts";
import { FALLBACK_USAGE, UNPRICED_JEV_USAGE } from "../decisions/record.ts";
import { RECORDS_SCHEMA_VERSION, type Decision, type RiskClass, type TaskId } from "../storage/records.ts";
// The gate owns the question id; importing it means the writer and the reader
// cannot drift apart into two rows that never match.
import { TASK_EVIDENCE_GAP_QUESTION } from "./task-gate.ts";

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
  /**
   * Lowest confidence across the Jev answers for this criterion; `null` when
   * nothing was answered by Jev. The *minimum*, because a conjunction is only
   * as trustworthy as its weakest part.
   */
  readonly confidence: number | null;
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

// ---------------------------------------------------------------------------
// Per-criterion evaluation: three bounded questions, conjunction in code
// ---------------------------------------------------------------------------

const NOT_ASKED = Object.freeze({ evaluated: false, reason: "not_asked" } as const);
const DISABLED = Object.freeze({ evaluated: false, reason: "jev_disabled" } as const);
const ABSTAINED = Object.freeze({ evaluated: false, reason: "abstained" } as const);

/**
 * A fallback result is never a semantic answer.
 *
 * `ask()` always returns a value (PLAN §2.4), but a value produced by the
 * deterministic fallback is not Jev's judgement, and presenting it as one is
 * how a "no gap" gets manufactured out of a missing key. `reason === null`
 * cannot occur on a fallback path, so `"jev_disabled"` covers disabled,
 * transport error and cancellation alike; an abstention keeps its own reason
 * because a caller may want to retry it and a disabled key is not retryable.
 */
function notEvaluated(result: DecisionResult<unknown>): Extract<Evaluated<never>, { evaluated: false }> {
  return result.reason === "abstained" ? ABSTAINED : DISABLED;
}

/** Options shared by every entry point here. */
export interface EvaluateOptions {
  /** Omit to run the deterministic mapping rule only (no key, no transport). */
  readonly ctx?: AskContext;
  /** Per-risk-class threshold overrides; may only make a floor stricter. */
  readonly thresholds?: Partial<Record<RiskClass, Partial<EvaluatorThresholds>>>;
  /** Recorded on every Decision this evaluation writes. */
  readonly subject?: { readonly taskId: string; readonly taskRevision: number };
}

/** Sort a reason set into the canonical `GAP_REASONS` order. */
function orderReasons(reasons: Iterable<GapReason>): readonly GapReason[] {
  const present = new Set(reasons);
  return GAP_REASONS.filter((r) => present.has(r));
}

/**
 * Evaluate ONE acceptance criterion. Never throws: every failure path is a
 * gap with a named reason.
 *
 * The conjunction is explicit and total — no early return skips a dimension,
 * so a criterion that is both unmapped and semantically unsupported reports
 * both, and `/korwf why` can say which.
 */
export async function evaluateCriterion(
  input: EvidenceGapInput,
  criterion: CriterionRef,
  options: EvaluateOptions = {},
): Promise<CriterionFinding> {
  const thresholds = thresholdsFor(input.riskClass, options.thresholds);
  const reasons = new Set<GapReason>(mappingReasons(input, criterion));
  const mapped = reasons.size === 0;
  const decisionIds: string[] = [];

  let claim: Evaluated<ClaimVerdict> = NOT_ASKED;
  let semanticGap: Evaluated<boolean> = NOT_ASKED;
  let confidence: number | null = null;
  const tests: TestExercisesFinding[] = [];

  if (options.ctx !== undefined) {
    const answers = await askCriterionQuestions(options.ctx, input, criterion, options.subject);
    for (const id of answers.decisionIds) decisionIds.push(id);
    confidence = answers.confidence;
    claim = answers.claim;
    semanticGap = answers.semanticGap;
    tests.push(...answers.tests.map((t) => creditTest(t, thresholds)));

    if (claim.evaluated) {
      if (claim.value === "unsupported") reasons.add("claim_unsupported");
      if (claim.value === "unknown") reasons.add("claim_unknown");
    } else if (claim.reason === "abstained") {
      // "Abstention/unknown is treated as a gap, never as pass" (issue #47 AC2).
      reasons.add("jev_abstained");
    }

    if (semanticGap.evaluated) {
      if (semanticGap.value) reasons.add("jev_reports_gap");
    } else if (semanticGap.reason === "abstained") {
      reasons.add("jev_abstained");
    }

    if (thresholds.requireExercisingTest && tests.length > 0 && !tests.some((t) => t.exercises)) {
      reasons.add("no_exercising_test");
    }
  } else {
    claim = DISABLED;
    semanticGap = DISABLED;
    for (const test of testsFor(input, criterion.id)) {
      tests.push({
        criterionId: criterion.id,
        checkId: test.checkId,
        testPath: test.testPath,
        level: DISABLED,
        exercises: false,
      });
    }
  }

  return {
    criterionId: criterion.id,
    criterionText: criterion.text,
    gap: reasons.size > 0,
    reasons: orderReasons(reasons),
    mapped,
    claim,
    semanticGap,
    tests,
    confidence,
    decisionIds,
  };
}

/**
 * Ask the three questions for one criterion.
 *
 * They are asked with `ask()` per question rather than one bulk request
 * because each has a *different* minimal state (PLAN §6 "minimal relevant
 * state per evaluation"): the claim question must see the claim, the gap
 * question must not be anchored by it, and the test question sees one test
 * file at a time. `askAll` would batch only states that are identical, so
 * nothing is lost and the independence is explicit.
 *
 * Every call writes a `Decision` — that is `ask()`'s contract, on every path
 * including disabled mode (issue #47 AC3: "every evaluation writes Decision
 * records with raw distributions").
 */
async function askCriterionQuestions(
  ctx: AskContext,
  input: EvidenceGapInput,
  criterion: CriterionRef,
  subject: EvaluateOptions["subject"],
): Promise<{
  readonly claim: Evaluated<ClaimVerdict>;
  readonly semanticGap: Evaluated<boolean>;
  readonly tests: readonly TestExercisesFinding[];
  readonly confidence: number | null;
  readonly decisionIds: readonly string[];
}> {
  const thresholds = thresholdsFor(input.riskClass);
  const where = subject === undefined ? {} : { subject: { taskId: subject.taskId as never, taskRevision: subject.taskRevision } };
  const summaries = evidenceFor(input, criterion.id);
  const linkedTests = testsFor(input, criterion.id);

  const [claimResult, gapResult, ...testResults] = await Promise.all([
    ask(
      ctx,
      claimSupportedQuestion,
      {
        criterionId: criterion.id,
        criterionText: criterion.text,
        claim: input.claim,
        evidence: summaries,
      },
      where,
    ),
    ask(ctx, evidenceGapQuestion, gapStateFor(input, criterion), where),
    ...linkedTests.map((test) =>
      ask(
        ctx,
        testExercisesQuestion,
        {
          criterionId: criterion.id,
          criterionText: criterion.text,
          checkId: test.checkId,
          command: test.command,
          testPath: test.testPath,
          testExcerpt: test.excerpt,
        },
        where,
      ),
    ),
  ]);

  const decisionIds: string[] = [];
  for (const result of [claimResult, gapResult, ...testResults]) {
    if (result.decisionId !== null) decisionIds.push(result.decisionId);
  }

  // A `supported` below this risk class's floor is not `supported`. The
  // question's own `minConfidence` is the shipped floor; this is the
  // per-risk-class one on top of it, and it can only be stricter.
  const claimConfident = (claimResult.confidence ?? 0) >= thresholds.claimConfidence;
  const claim: Evaluated<ClaimVerdict> =
    claimResult.source !== "jev"
      ? notEvaluated(claimResult)
      : claimResult.value === "supported" && !claimConfident
        ? ABSTAINED
        : { evaluated: true, value: claimResult.value, source: "jev" };

  // The noul is recorded as `{true: p, false: 1-p}`; `true` is "there is a
  // gap". A `no_gap` answer must clear the *gap ceiling*, not merely 0.5.
  const gapProbability = Number(gapResult.distribution["true"] ?? (gapResult.value ? 1 : 0));
  const semanticGap: Evaluated<boolean> =
    gapResult.source !== "jev"
      ? notEvaluated(gapResult)
      : gapResult.value
        ? { evaluated: true, value: true, source: "jev" }
        : gapProbability <= thresholds.gapCeiling
          ? { evaluated: true, value: false, source: "jev" }
          : ABSTAINED;

  const tests: TestExercisesFinding[] = linkedTests.map((test, index) => {
    const result = testResults[index];
    const level: Evaluated<number> =
      result === undefined
        ? NOT_ASKED
        : result.source === "jev"
          ? { evaluated: true, value: result.value, source: "jev" }
          : notEvaluated(result);
    return { criterionId: criterion.id, checkId: test.checkId, testPath: test.testPath, level, exercises: false };
  });

  const confidences = [claimResult, ...testResults]
    .filter((r) => r.source === "jev" && r.confidence !== null)
    .map((r) => r.confidence as number);
  const confidence = confidences.length === 0 ? null : Math.min(...confidences);

  return { claim, semanticGap, tests, confidence, decisionIds };
}

/** Apply the risk class's level floor. The comparison is code, never Jev. */
function creditTest(finding: TestExercisesFinding, thresholds: EvaluatorThresholds): TestExercisesFinding {
  const exercises = finding.level.evaluated && finding.level.value >= thresholds.testExercisesMinLevel;
  return { ...finding, exercises };
}

// ---------------------------------------------------------------------------
// Whole-task composition — the conjunction, in code
// ---------------------------------------------------------------------------

/**
 * Evaluate every acceptance criterion and take the conjunction.
 *
 * This function is where the decomposition lesson pays off: there is no
 * question anywhere that sees the whole task, so adding a criterion cannot
 * lower the score of the others. The whole-task verdict is `AND` over the
 * per-criterion verdicts, computed here — arithmetic and quantification in
 * code (PLAN §6).
 *
 * **A task with no acceptance criteria is a gap.** `allTrue` over zero parts
 * is false by design (docs/questions.md §4), and the same rule applies here:
 * "nothing to check" is not "nothing wrong".
 */
export async function evaluateEvidenceGap(
  input: EvidenceGapInput,
  options: EvaluateOptions = {},
): Promise<EvidenceGapEvaluation> {
  const thresholds = thresholdsFor(input.riskClass, options.thresholds);
  const findings: CriterionFinding[] = [];
  for (const criterion of input.acceptanceCriteria) {
    findings.push(await evaluateCriterion(input, criterion, options));
  }

  const gapCriterionIds = findings.filter((f) => f.gap).map((f) => f.criterionId);
  const noGap = findings.length > 0 && gapCriterionIds.length === 0;
  const degraded = findings.some(
    (f) => !f.claim.evaluated || !f.semanticGap.evaluated || f.tests.some((t) => !t.level.evaluated),
  );

  const rule =
    findings.length === 0
      ? "verify.evidence_gap:no_criteria"
      : options.ctx === undefined
        ? `verify.evidence_gap:mapping_only:${noGap ? "no_gap" : "gap"}`
        : `verify.evidence_gap:conjunction:${noGap ? "no_gap" : "gap"}`;

  return {
    taskId: input.taskId,
    noGap,
    action: noGap ? "no_gap" : "gap",
    gapCriterionIds,
    findings,
    degraded,
    rule,
    confidence: minConfidence(findings),
    thresholds,
  };
}

/**
 * Lowest per-criterion confidence, or `null` when Jev answered nothing.
 * A conjunction is as confident as its least confident part; taking a mean
 * here would let a pile of easy criteria carry a doubtful one.
 */
function minConfidence(findings: readonly CriterionFinding[]): number | null {
  const values = findings.map((f) => f.confidence).filter((c): c is number => c !== null);
  return values.length === 0 ? null : Math.min(...values);
}

/**
 * The mapping-only evaluation: no transport, no key, no questions asked.
 *
 * This is what condition 2 becomes with Jev disabled, and it is deliberately
 * *meaningful*: every acceptance criterion still needs at least one linked
 * passing check and one passing evidence item, so a criterion nobody checked
 * is still a gap. What it cannot do is notice a passing test that observes
 * the wrong thing — `test/scenarios/03-wrong-test.md` variant B documents
 * that limitation and the independent model review (#48) that covers it.
 */
export async function evaluateMappingOnly(
  input: EvidenceGapInput,
  options: Omit<EvaluateOptions, "ctx"> = {},
): Promise<EvidenceGapEvaluation> {
  return evaluateEvidenceGap(input, options);
}

/**
 * One-line explanation per gap, naming the criterion. Used for the
 * `needs_changes` blocker detail so a worker is told *which* criterion and
 * *why*, never just "evidence gap".
 */
export function explainEvidenceGap(evaluation: EvidenceGapEvaluation): readonly string[] {
  return evaluation.findings
    .filter((f) => f.gap)
    .map((f) => `${f.criterionId}: ${f.reasons.join(", ")} — ${f.criterionText}`);
}

// ---------------------------------------------------------------------------
// The gate-facing Decision (docs/gates.md §5; task-gate.ts C2)
// ---------------------------------------------------------------------------

/**
 * Condition 2 of the task gate reads exactly one thing: a fresh `Decision`
 * under `TASK_EVIDENCE_GAP_QUESTION` whose `stateHash` equals the gate's own
 * `gateStateHash(...)`. That row is what this function writes, from an
 * evaluation produced above.
 *
 * Three properties matter and are structural, not conventional:
 *
 * 1. **The gate hashes its own state.** The caller passes `stateHash` from
 *    `gateStateHash()`; nothing here computes it, so an evaluation cannot
 *    claim freshness the gate would not agree with. Change a check state and
 *    the hash changes and this row stops counting.
 * 2. **Disabled mode is a recorded branch, not a skip.** With no Jev the row
 *    carries `action: "deterministic_fallback"` and
 *    `override: {actor: "policy", reason}`, which is the branch the gate
 *    requires before it will even run `DET_COVERAGE`. Absence of a row is
 *    neither branch and the gate refuses with `jev_decision_missing`.
 * 3. **A gap is recorded as a gap.** `action` is `"gap"` whenever any
 *    criterion is a gap — including when the gap came from an abstention.
 */
export const TASK_EVIDENCE_GAP_QUESTION_ID: string = TASK_EVIDENCE_GAP_QUESTION;

/** Version pinned on the gate Decision; must match `Workflow.policyVersion`'s pin. */
export const TASK_EVIDENCE_GAP_QUESTION_VERSION = "1" as const;

/** Why Jev did not answer. Exactly the gate's `JEV_DISABLED_REASONS`. */
export type GateFallbackReason = "jev_disabled" | "jev_no_key" | "jev_unavailable";

/** The minimal sink this module needs: append one `Decision` row. */
export interface GateDecisionSink {
  insert(record: Decision): Decision;
}

export interface GateDecisionOptions {
  readonly workflowId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  /** Exact Git SHA, read by `src/git/`. Never taken from a worker record. */
  readonly revision: string;
  /** `gateStateHash(...)` from `src/verification/task-gate.ts`. */
  readonly stateHash: string;
  readonly now: string;
  readonly newId: () => string;
  /** Set when Jev did not answer; makes this the `deterministic_fallback` branch. */
  readonly fallbackReason?: GateFallbackReason;
  readonly jevModelVersion?: string | null;
  readonly latencyMs?: number | null;
}

/**
 * Build (do not insert) the `Decision` row for condition 2.
 *
 * Split from the insert so a caller can assert on the row in a test, and so
 * a dry-run mode can show what would be recorded without writing it.
 */
export function buildGateDecision(
  evaluation: EvidenceGapEvaluation,
  options: GateDecisionOptions,
): Decision {
  const fallback = options.fallbackReason !== undefined;
  const criteria = evaluation.findings.length;
  const gaps = evaluation.gapCriterionIds.length;
  // The raw distribution is preserved as a distribution over the *actions*
  // the gate matches on, derived from the per-criterion answers rather than
  // invented: this is the shape `/korwf why` prints (PLAN §6).
  const gapShare = criteria === 0 ? 1 : gaps / criteria;
  const rawDistribution = fallback ? {} : { gap: gapShare, no_gap: 1 - gapShare };
  return {
    id: options.newId() as Decision["id"],
    createdAt: options.now,
    updatedAt: options.now,
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "append_only",
    workflowId: options.workflowId as Decision["workflowId"],
    subject: { taskId: options.taskId as TaskId, taskRevision: options.taskRevision },
    stateHash: options.stateHash,
    questionId: TASK_EVIDENCE_GAP_QUESTION_ID,
    questionVersion: TASK_EVIDENCE_GAP_QUESTION_VERSION,
    jevModelVersion: fallback ? null : (options.jevModelVersion ?? null),
    rawDistribution,
    confidence: fallback ? null : evaluation.confidence,
    policyRule: evaluation.rule,
    action: fallback ? "deterministic_fallback" : evaluation.action,
    override: fallback
      ? {
          actor: "policy",
          action: "deterministic_fallback",
          reason: options.fallbackReason as string,
          at: options.now,
        }
      : null,
    freshness: { revision: options.revision as Decision["freshness"]["revision"], decidedAt: options.now, expiresAt: null },
    usage: fallback ? FALLBACK_USAGE : UNPRICED_JEV_USAGE,
    latencyMs: fallback ? null : (options.latencyMs ?? null),
  };
}

/** Build and append the condition-2 `Decision`. Returns it exactly as stored. */
export function recordGateDecision(
  sink: GateDecisionSink,
  evaluation: EvidenceGapEvaluation,
  options: GateDecisionOptions,
): Decision {
  return sink.insert(buildGateDecision(evaluation, options));
}

// ---------------------------------------------------------------------------
// Re-exports, so a caller needs one import for the whole evaluator surface
// ---------------------------------------------------------------------------

export { TEST_EXERCISES_MIN_LEVEL, claimSupportedQuestion, evidenceGapQuestion, testExercisesQuestion };
export type { ClaimVerdict, CriterionRef, EvidenceGapState, EvidenceSummary };
