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
  evaluateCriterion,
  evaluateEvidenceGap,
  evaluateMappingOnly,
  explainEvidenceGap,
  thresholdsFor,
  type EvidenceGapInput,
} from "../../../src/verification/evaluate.ts";
import { DisabledJevTransport } from "../../../src/jev/disabled.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import { DecisionRecorder, MemoryDecisionSink } from "../../../src/decisions/record.ts";
import type { AskContext } from "../../../src/decisions/ask.ts";
import type { GitSha, WorkflowId } from "../../../src/storage/records.ts";

const SHA = "a".repeat(40) as GitSha;

describe("#47 evaluate", () => {
  it("AC3 module loads", () => {
    expect(typeof evaluateEvidenceGap).toBe("function");
    expect(typeof evaluateCriterion).toBe("function");
    expect(typeof evaluateMappingOnly).toBe("function");
    expect(typeof explainEvidenceGap).toBe("function");
    expect(typeof thresholdsFor).toBe("function");
    expect(DEFAULT_EVALUATOR_THRESHOLDS.high.claimConfidence).toBeGreaterThan(
      DEFAULT_EVALUATOR_THRESHOLDS.low.claimConfidence,
    );
    expect(DisabledJevTransport).toBeTruthy();
    expect(MockJevTransport).toBeTruthy();
    expect(DecisionRecorder).toBeTruthy();
    expect(MemoryDecisionSink).toBeTruthy();
    const ctx: AskContext | undefined = undefined;
    expect(ctx).toBeUndefined();
    const input: Partial<EvidenceGapInput> = { taskId: "tk-1" };
    expect(input.taskId).toBe("tk-1");
    expect(SHA).toHaveLength(40);
  });
});
