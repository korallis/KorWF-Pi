/**
 * Issue #47 — completion-claim, evidence-gap and test-exercises-requirement
 * evaluators (PLAN §2.4 (2), §3.F, §6).
 *
 * Acceptance criteria under test, named in every `it`:
 *  - **AC1** Scenario 3 fixture (test passes but tests something unrelated)
 *    → gap flagged naming the criterion (mock Jev).
 *  - **AC2** Abstention/unknown is treated as a gap, never as pass.
 *  - **AC3** Every evaluation writes Decision records with raw distributions.
 *
 * No live Jev: `MockJevTransport` and `DisabledJevTransport` only.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVALUATOR_THRESHOLDS,
  buildGateDecision,
  evaluateCriterion,
  evaluateEvidenceGap,
  evaluateMappingOnly,
  explainEvidenceGap,
  recordGateDecision,
  thresholdsFor,
  type EvidenceGapInput,
} from "../../../src/verification/evaluate.ts";
import { DisabledJevTransport } from "../../../src/jev/disabled.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import type { JevEvaluateResult, SystemOneRequest } from "../../../src/jev/transport.ts";
import { DecisionRecorder, MemoryDecisionSink } from "../../../src/decisions/record.ts";
import type { AskContext } from "../../../src/decisions/ask.ts";
import type { WorkflowId } from "../../../src/storage/records.ts";

const MODEL = "jev-test";
const SHA = "a".repeat(40);

function recorderWith(sink: MemoryDecisionSink): DecisionRecorder {
  let n = 0;
  return new DecisionRecorder({
    sink,
    workflowId: "wf-1" as WorkflowId,
    revision: SHA,
    subject: null,
    now: () => "2026-01-01T00:00:00.000Z",
    newId: () => `dc-${(n += 1)}`,
  });
}

/**
 * Answer each question by its *type*, so a fixture can say "claim is
 * supported, gap is no, the test exercises nothing" without knowing the wire
 * keys `ask()` generates.
 */
type Answers = {
  claim?: unknown;
  gap?: unknown;
  test?: unknown;
};

function respond(answers: Answers): (request: SystemOneRequest) => JevEvaluateResult {
  return (request) => ({
    kind: "ok",
    response: {
      model: MODEL,
      answers: Object.fromEntries(
        Object.entries(request.questions)
          .map(([key]) => {
            const picked = key.includes("claim_supported")
              ? answers.claim
              : key.includes("evidence_gap")
                ? answers.gap
                : answers.test;
            return [key, picked] as const;
          })
          .filter(([, value]) => value !== undefined),
      ),
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    requestId: "req-1",
    attempts: 1,
    elapsedMs: 1,
  });
}

function ctxWith(answers: Answers, sink = new MemoryDecisionSink()): AskContext & { sink: MemoryDecisionSink } {
  return {
    transport: new MockJevTransport({ responder: respond(answers) }),
    recorder: recorderWith(sink),
    model: MODEL,
    sink,
  };
}

function disabledCtx(sink = new MemoryDecisionSink()): AskContext & { sink: MemoryDecisionSink } {
  return {
    transport: new DisabledJevTransport("Jev is disabled: no key configured."),
    recorder: recorderWith(sink),
    model: MODEL,
    sink,
  };
}

// ---------------------------------------------------------------------------
// The scenario 3 fixture (test/scenarios/03-wrong-test.md)
// ---------------------------------------------------------------------------

/**
 * Worker patch #1: the validation is implemented, the added test asserts a
 * *valid* order returns 201, and every check passes. The criterion it claims
 * to cover is about the empty-items rejection.
 */
function scenario3(overrides: Partial<EvidenceGapInput> = {}): EvidenceGapInput {
  return {
    taskId: "tk-1",
    taskGoal: "Reject POST /orders with an empty items array",
    riskClass: "low",
    acceptanceCriteria: [{ id: "ac1", text: "empty items => 400 empty_order" }],
    checks: [
      {
        checkId: "chk1",
        command: "npm test test/routes/orders.test.ts",
        state: "pass",
        coversCriteria: ["ac1"],
      },
      { checkId: "chk2", command: "npm run typecheck", state: "pass", coversCriteria: ["ac1"] },
    ],
    tests: [
      {
        checkId: "chk1",
        command: "npm test test/routes/orders.test.ts",
        testPath: "test/routes/orders.test.ts",
        excerpt: "it('creates an order', () => expect(post({items:[{id:1}]}).status).toBe(201))",
        coversCriteria: ["ac1"],
      },
    ],
    evidence: [
      {
        requirementId: "ac1",
        checkId: "chk1",
        command: "npm test test/routes/orders.test.ts",
        state: "pass",
        paths: ["test/routes/orders.test.ts"],
        excerpt: "1 passing",
      },
    ],
    claim: "Implemented and tested empty-order rejection.",
    ...overrides,
  };
}

/** A well-formed choice answer: every option present, probabilities sum to 1. */
function claimAnswer(choice: "supported" | "unsupported" | "unknown", confidence: number): unknown {
  const rest = (1 - confidence) / 2;
  const probabilities: Record<string, number> = { supported: rest, unsupported: rest, unknown: rest };
  probabilities[choice] = confidence;
  const total = Object.values(probabilities).reduce((a, b) => a + b, 0);
  for (const key of Object.keys(probabilities)) probabilities[key] = probabilities[key]! / total;
  return { type: "choice", choice, confidence, probabilities };
}

/** A well-formed score answer: legend and probabilities over "0".."3". */
function testAnswer(level: 0 | 1 | 2 | 3, confidence = 0.9): unknown {
  const legend = { "0": "none", "1": "adjacent", "2": "partial", "3": "full" };
  const probabilities: Record<string, number> = { "0": 0.05, "1": 0.05, "2": 0.05, "3": 0.05 };
  probabilities[String(level)] = 0.85;
  return { type: "score", score: level, confidence, legend, probabilities };
}

const CLAIM_SUPPORTED = claimAnswer("supported", 0.95);
const CLAIM_UNKNOWN = claimAnswer("unknown", 0.9);
const GAP_YES = { type: "noul", noul: 0.92 };
const GAP_NO = { type: "noul", noul: 0.05 };
const TEST_EXERCISES_NONE = testAnswer(0);
const TEST_EXERCISES_FULL = testAnswer(3);

describe("AC1 scenario 3: a passing test that exercises something unrelated", () => {
  it("AC1 flags a gap naming the criterion (mock Jev)", async () => {
    const ctx = ctxWith({ claim: CLAIM_SUPPORTED, gap: GAP_YES, test: TEST_EXERCISES_NONE });
    const result = await evaluateEvidenceGap(scenario3(), { ctx });

    expect(result.action).toBe("gap");
    expect(result.noGap).toBe(false);
    expect(result.gapCriterionIds).toEqual(["ac1"]);
    const finding = result.findings[0]!;
    expect(finding.criterionId).toBe("ac1");
    expect(finding.reasons).toContain("jev_reports_gap");
    // C1 is untouched: every check passes and the mapping rule is satisfied.
    expect(finding.mapped).toBe(true);
    expect(explainEvidenceGap(result)[0]).toContain("ac1");
  });

  it("AC1 the test-exercises evaluator reports level 0 for the wrong test", async () => {
    const ctx = ctxWith({ claim: CLAIM_SUPPORTED, gap: GAP_NO, test: TEST_EXERCISES_NONE });
    const result = await evaluateEvidenceGap(scenario3(), { ctx });
    const test = result.findings[0]!.tests[0]!;
    expect(test.testPath).toBe("test/routes/orders.test.ts");
    expect(test.level).toEqual({ evaluated: true, value: 0, source: "jev" });
    expect(test.exercises).toBe(false);
  });

  it("AC1 a medium-risk task is a gap when no linked test exercises the criterion", async () => {
    const ctx = ctxWith({ claim: CLAIM_SUPPORTED, gap: GAP_NO, test: TEST_EXERCISES_NONE });
    const result = await evaluateEvidenceGap(scenario3({ riskClass: "medium" }), { ctx });
    expect(result.action).toBe("gap");
    expect(result.findings[0]!.reasons).toContain("no_exercising_test");
  });

  it("AC1 patch #2 (the right test) passes: no gap when every part agrees", async () => {
    const ctx = ctxWith({ claim: CLAIM_SUPPORTED, gap: GAP_NO, test: TEST_EXERCISES_FULL });
    const result = await evaluateEvidenceGap(scenario3({ riskClass: "medium" }), { ctx });
    expect(result.action).toBe("no_gap");
    expect(result.gapCriterionIds).toEqual([]);
    expect(result.findings[0]!.tests[0]!.exercises).toBe(true);
  });
});

describe("AC2 abstention and unknown are gaps, never passes", () => {
  it("AC2 an `unknown` claim verdict is a gap naming the criterion", async () => {
    const ctx = ctxWith({ claim: CLAIM_UNKNOWN, gap: GAP_NO, test: TEST_EXERCISES_FULL });
    const result = await evaluateEvidenceGap(scenario3(), { ctx });
    expect(result.action).toBe("gap");
    expect(result.findings[0]!.reasons).toContain("claim_unknown");
  });

  it("AC2 a noul inside the abstain band is a gap, not a no_gap", async () => {
    const ctx = ctxWith({ claim: CLAIM_SUPPORTED, gap: { type: "noul", noul: 0.5 }, test: TEST_EXERCISES_FULL });
    const result = await evaluateEvidenceGap(scenario3(), { ctx });
    expect(result.action).toBe("gap");
    expect(result.findings[0]!.semanticGap).toEqual({ evaluated: false, reason: "abstained" });
    expect(result.findings[0]!.reasons).toContain("jev_abstained");
  });

  it("AC2 a `no gap` answer that misses the risk class's gap ceiling abstains", async () => {
    // 0.3 is below 0.5 (so `no_gap`) but above the low class's 0.35? No: it
    // is below. 0.34 is under the ceiling, 0.4 is over it and abstains.
    const overCeiling = ctxWith({ claim: CLAIM_SUPPORTED, gap: { type: "noul", noul: 0.34 }, test: TEST_EXERCISES_FULL });
    const ok = await evaluateEvidenceGap(scenario3(), { ctx: overCeiling });
    expect(ok.action).toBe("no_gap");

    const marginal = ctxWith({ claim: CLAIM_SUPPORTED, gap: { type: "noul", noul: 0.2 }, test: TEST_EXERCISES_FULL });
    const high = await evaluateEvidenceGap(scenario3({ riskClass: "high" }), { ctx: marginal });
    // high's gapCeiling is 0.15, so 0.2 is not confident enough to be no_gap.
    expect(high.action).toBe("gap");
    expect(high.findings[0]!.reasons).toContain("jev_abstained");
  });

  it("AC2 a low-confidence `supported` claim abstains and is a gap", async () => {
    const ctx = ctxWith({ claim: claimAnswer("supported", 0.62), gap: GAP_NO, test: TEST_EXERCISES_FULL });
    const result = await evaluateEvidenceGap(scenario3({ riskClass: "high" }), { ctx });
    expect(result.action).toBe("gap");
    expect(result.findings[0]!.claim).toEqual({ evaluated: false, reason: "abstained" });
  });

  it("AC2 a transport error is a gap, never a pass", async () => {
    const ctx: AskContext = {
      transport: new MockJevTransport({
        responder: () => ({
          kind: "error",
          error: Object.assign(new Error("boom"), { code: "jev.unavailable", name: "JevTransportError" }) as never,
          attempts: 1,
          elapsedMs: 1,
        }),
      }),
      model: MODEL,
    };
    const result = await evaluateEvidenceGap(scenario3({ riskClass: "medium" }), { ctx });
    expect(result.action).toBe("gap");
    expect(result.degraded).toBe(true);
  });

  it("AC2 a task with no acceptance criteria is a gap, not vacuously fine", async () => {
    const ctx = ctxWith({ claim: CLAIM_SUPPORTED, gap: GAP_NO, test: TEST_EXERCISES_FULL });
    const result = await evaluateEvidenceGap(scenario3({ acceptanceCriteria: [] }), { ctx });
    expect(result.noGap).toBe(false);
    expect(result.action).toBe("gap");
    expect(result.rule).toBe("verify.evidence_gap:no_criteria");
  });
});

describe("AC3 every evaluation writes Decision records with raw distributions", () => {
  it("AC3 records one Decision per question, with the distribution as returned", async () => {
    const ctx = ctxWith({ claim: CLAIM_SUPPORTED, gap: GAP_YES, test: TEST_EXERCISES_NONE });
    await evaluateEvidenceGap(scenario3(), { ctx, subject: { taskId: "tk-1", taskRevision: 1 } });

    const rows = ctx.sink.rows;
    // one claim + one gap + one test question, for one criterion
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.questionId).sort()).toEqual([
      "verify.claim_supported",
      "verify.evidence_gap",
      "verify.test_exercises",
    ]);
    for (const row of rows) {
      expect(row.questionVersion).toBe("1");
      expect(row.jevModelVersion).toBe(MODEL);
      expect(Object.keys(row.rawDistribution).length).toBeGreaterThan(0);
      expect(row.subject).toEqual({ taskId: "tk-1", taskRevision: 1 });
      expect(row.override).toBeNull();
    }
    const gapRow = rows.find((r) => r.questionId === "verify.evidence_gap")!;
    expect(gapRow.rawDistribution["true"]).toBeCloseTo(0.92, 6);
    expect(gapRow.action).toBe("gap");
  });

  it("AC3 records a Decision in disabled mode too, with policyRule fallback", async () => {
    const ctx = disabledCtx();
    const result = await evaluateEvidenceGap(scenario3(), { ctx });
    expect(ctx.sink.rows).toHaveLength(3);
    for (const row of ctx.sink.rows) {
      expect(row.jevModelVersion).toBeNull();
      expect(row.policyRule.startsWith("fallback")).toBe(true);
      expect(row.usage.requests).toBe(0);
    }
    // A fallback answer is never presented as Jev's judgement.
    expect(result.findings[0]!.claim).toEqual({ evaluated: false, reason: "jev_disabled" });
    expect(result.findings[0]!.semanticGap).toEqual({ evaluated: false, reason: "jev_disabled" });
    expect(result.degraded).toBe(true);
  });

  it("AC3 the abstention itself is recorded, distribution included", async () => {
    const ctx = ctxWith({ claim: CLAIM_SUPPORTED, gap: { type: "noul", noul: 0.5 }, test: TEST_EXERCISES_FULL });
    await evaluateEvidenceGap(scenario3(), { ctx });
    const gapRow = ctx.sink.rows.find((r) => r.questionId === "verify.evidence_gap")!;
    expect(gapRow.rawDistribution).toEqual({ true: 0.5, false: 0.5 });
    expect(gapRow.jevModelVersion).toBeNull();
    expect(gapRow.policyRule).toBe("fallback:criterion_mapping");
  });
});
