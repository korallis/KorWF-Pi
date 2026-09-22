/**
 * Issue #47 — the three verify questions exist, are registered at
 * `id@version` with a pinned content hash, send minimal state, and every one
 * of them has a deterministic fallback that never invents a semantic pass.
 *
 * AC2 ("abstention/unknown is treated as a gap, never as pass") is enforced
 * partly here, at the definition level: an out-of-band answer coerces to
 * `unknown`, and the abstention policy is part of each question's content
 * hash so it cannot be relaxed without a version bump.
 */
import { describe, expect, it } from "vitest";
import {
  VERIFY_QUESTIONS,
  VERIFY_QUESTION_HASHES,
  VERIFY_EXCERPT_BYTES,
  TEST_EXERCISES_LEVELS,
  claimFallbackVerdict,
  claimSupportedQuestion,
  clampExcerpt,
  evidenceGapFallback,
  evidenceGapQuestion,
  testExercisesQuestion,
  verifyQuestionRegistry,
  type ClaimSupportedState,
  type EvidenceGapState,
  type TestExercisesState,
} from "../../../src/decisions/questions/verify.ts";
import { assertBoundaries, type AnyQuestionDefinition } from "../../../src/decisions/question.ts";

const CLAIM_STATE: ClaimSupportedState = {
  criterionId: "ac1",
  criterionText: "empty items => 400 empty_order",
  claim: "Implemented and tested empty-order rejection.",
  evidence: [{ checkId: "chk1", command: "npm test", state: "pass", paths: ["test/a.test.ts"], excerpt: "1 passing" }],
};

const GAP_STATE: EvidenceGapState = {
  criterionId: "ac1",
  criterionText: "empty items => 400 empty_order",
  linkedChecks: [{ checkId: "chk1", command: "npm test", state: "pass" }],
  evidence: [{ checkId: "chk1", command: "npm test", state: "pass", paths: [], excerpt: "" }],
};

const TEST_STATE: TestExercisesState = {
  criterionId: "ac1",
  criterionText: "empty items => 400 empty_order",
  checkId: "chk1",
  command: "npm test",
  testPath: "test/routes/orders.test.ts",
  testExcerpt: "it('creates an order', () => expect(post({items:[{id:1}]}).status).toBe(201))",
};

describe("AC1/AC2 the verify question family is registered and versioned", () => {
  it("AC1 all three questions are registered at id@version with their reviewed hash", () => {
    expect(VERIFY_QUESTIONS.map((q) => q.key)).toEqual([
      "verify.claim_supported@1",
      "verify.evidence_gap@1",
      "verify.test_exercises@1",
    ]);
    for (const question of VERIFY_QUESTIONS) {
      expect(VERIFY_QUESTION_HASHES[question.key]).toBe(question.contentHash);
      expect(verifyQuestionRegistry.get(question.key)).toBe(question);
    }
  });

  it("AC2 every question declares boundary cases its own fallback satisfies", () => {
    for (const question of VERIFY_QUESTIONS) {
      expect(question.boundaries.length).toBeGreaterThan(0);
      expect(() => assertBoundaries(question as AnyQuestionDefinition)).not.toThrow();
    }
  });

  it("AC2 every question is revision-sensitive, so an answer is never cached across a change", () => {
    for (const question of VERIFY_QUESTIONS) expect(question.revisionSensitive).toBe(true);
  });

  it("AC2 the abstention policy is declared, not left to the caller", () => {
    expect(claimSupportedQuestion.minConfidence).toBeGreaterThanOrEqual(0.6);
    expect(evidenceGapQuestion.abstainBand).toEqual([0.35, 0.65]);
    expect(testExercisesQuestion.minConfidence).toBeGreaterThanOrEqual(0.6);
  });
});

describe("AC2 verify.claim_supported@1 never guesses `supported`", () => {
  it("AC2 an out-of-band choice coerces to unknown, never to supported", () => {
    const interpreted = claimSupportedQuestion.interpret(
      { type: "choice", choice: "definitely", confidence: 0.99, probabilities: { definitely: 1 } },
      CLAIM_STATE,
    );
    expect(interpreted?.value).toBe("unknown");
  });

  it("AC2 the fallback returns unknown or unsupported, never supported, for any evidence", () => {
    for (const state of ["pass", "fail", "flaky", "missing", "unavailable", "timeout"]) {
      const verdict = claimFallbackVerdict([{ checkId: "c", command: "x", state, paths: [], excerpt: "" }]);
      expect(verdict).not.toBe("supported");
    }
    expect(claimFallbackVerdict([])).toBe("unsupported");
  });

  it("AC2 the fallback is the same for every fallback reason", () => {
    for (const reason of ["disabled", "transport_error", "cancelled", "abstained", "invalid_response"] as const) {
      expect(claimSupportedQuestion.fallback(CLAIM_STATE, reason).value).toBe("unknown");
    }
  });

  it("AC1 state sent outbound is minimal: only the declared fields", () => {
    expect(Object.keys(claimSupportedQuestion.buildState(CLAIM_STATE)).sort()).toEqual([
      "claim",
      "criterionId",
      "criterionText",
      "evidence",
    ]);
  });
});

describe("AC2 verify.evidence_gap@1 falls back to the mapping rule", () => {
  it("AC2 the structural fallback needs a linked passing check AND a passing evidence row", () => {
    expect(evidenceGapFallback(GAP_STATE)).toBe(false);
    expect(evidenceGapFallback({ ...GAP_STATE, evidence: [] })).toBe(true);
    expect(evidenceGapFallback({ ...GAP_STATE, linkedChecks: [] })).toBe(true);
  });

  it("AC2 flaky/missing/unavailable never close the gap (#51)", () => {
    for (const state of ["flaky", "missing", "unavailable", "timeout", "fail"]) {
      expect(
        evidenceGapFallback({
          ...GAP_STATE,
          linkedChecks: [{ checkId: "chk1", command: "npm test", state }],
          evidence: [{ checkId: "chk1", command: "npm test", state, paths: [], excerpt: "" }],
        }),
        `state ${state}`,
      ).toBe(true);
    }
  });

  it("AC2 a noul at the decision boundary maps to `gap`, not `no_gap`", () => {
    expect(evidenceGapQuestion.interpret({ type: "noul", noul: 0.5 }, GAP_STATE)?.action).toBe("gap");
    expect(evidenceGapQuestion.interpret({ type: "noul", noul: 0.49 }, GAP_STATE)?.action).toBe("no_gap");
  });
});

describe("AC1 verify.test_exercises@1 is the semantic counterpart of isVerifyingCheck", () => {
  it("AC1 the level scale names the counterfactual: would this test fail if the criterion were unimplemented", () => {
    expect(TEST_EXERCISES_LEVELS).toHaveLength(4);
    expect(TEST_EXERCISES_LEVELS[0]).toContain("would still pass if the criterion were unimplemented");
    expect(testExercisesQuestion.prompt).toContain("would this test fail");
  });

  it("AC1 the fallback credits nothing: with no key there is no semantic signal to read", () => {
    for (const reason of ["disabled", "transport_error", "abstained"] as const) {
      expect(testExercisesQuestion.fallback(TEST_STATE, reason).value).toBe(0);
    }
  });

  it("AC1 an out-of-range score is clamped into the level set, never trusted raw", () => {
    const legend = { "0": "a", "1": "b", "2": "c", "3": "d" };
    const probabilities = { "0": 0.25, "1": 0.25, "2": 0.25, "3": 0.25 };
    expect(
      testExercisesQuestion.interpret({ type: "score", score: 9, confidence: 0.9, legend, probabilities }, TEST_STATE)
        ?.value,
    ).toBe(3);
    expect(
      testExercisesQuestion.interpret({ type: "score", score: -2, confidence: 0.9, legend, probabilities }, TEST_STATE)
        ?.value,
    ).toBe(0);
  });

  it("AC1 state sent outbound is one test file excerpt, never the full diff", () => {
    const state = testExercisesQuestion.buildState({ ...TEST_STATE, testExcerpt: "x".repeat(VERIFY_EXCERPT_BYTES * 3) });
    expect(Object.keys(state).sort()).toEqual([
      "checkId",
      "command",
      "criterionId",
      "criterionText",
      "testExcerpt",
      "testPath",
    ]);
    expect(String((state as Record<string, unknown>)["testExcerpt"]).length).toBeLessThanOrEqual(
      VERIFY_EXCERPT_BYTES + 1,
    );
    expect(clampExcerpt("short")).toBe("short");
  });
});
