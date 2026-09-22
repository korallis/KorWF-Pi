/**
 * Issue #47 — the Decision this evaluator writes is exactly the row the task
 * gate's condition 2 accepts (#46, `docs/gates.md` §5).
 *
 * This file exists because "the evaluator produces a verdict" and "the gate
 * acts on that verdict" are two different claims, and the second one is the
 * one that matters. Nothing here re-implements the gate: it imports
 * `evaluateTaskGate` and `gateStateHash` and feeds them the real row.
 *
 * AC3 ("every evaluation writes Decision records with raw distributions") and
 * the non-negotiable "Jev cannot waive a deterministic check" are both
 * exercised against the actual gate.
 */
import { describe, expect, it } from "vitest";
import {
  buildGateDecision,
  evaluateEvidenceGap,
  evaluateMappingOnly,
  recordGateDecision,
  type EvidenceGapEvaluation,
  type EvidenceGapInput,
} from "../../../src/verification/evaluate.ts";
import {
  evaluateTaskGate,
  freshEvidence,
  gateStateHash,
  type JevGateConfig,
  type PolicyReviewResult,
  type TaskGateInput,
} from "../../../src/verification/task-gate.ts";
import { MemoryDecisionSink } from "../../../src/decisions/record.ts";
import type { CheckDefinition, Decision, Evidence, TaskId } from "../../../src/storage/records.ts";
import { AT, SHA, makeAttempt, makeEvidence, makeTask, makeWorkflow } from "../../helpers/records.ts";

const TK = "tk-1" as TaskId;

const CHK1: CheckDefinition = {
  id: "chk1",
  kind: "command",
  command: "npm test -- a",
  cwd: ".",
  expectedExitCode: 0,
  coversCriteria: ["ac1"],
  required: true,
};

const JEV_ENABLED: JevGateConfig = {
  enabled: true,
  optional: false,
  confidenceThreshold: 0.7,
  questionVersion: "1",
};

const JEV_DISABLED: JevGateConfig = { ...JEV_ENABLED, enabled: false };

function policyNone(): PolicyReviewResult {
  return {
    modelReview: false,
    humanApproval: false,
    changeClass: "code_change",
    policyVersion: "1",
    revision: SHA,
    taskRevision: 1,
  };
}

function gateInput(overrides: Partial<TaskGateInput> = {}): TaskGateInput {
  const task = makeTask({
    id: TK,
    revision: 1,
    status: "review",
    riskClass: "low",
    acceptanceCriteria: [{ id: "ac1", text: "empty items => 400 empty_order" }],
    checks: [CHK1],
    ownership: { paths: ["src/routes", "test/routes"], components: [] },
  });
  const evidence: Evidence[] = [
    makeEvidence({
      id: "ev-1" as Evidence["id"],
      taskId: TK,
      taskRevision: 1,
      requirementId: "ac1",
      checkId: "chk1",
      revision: SHA,
      commandIdentity: { command: CHK1.command, cwd: CHK1.cwd, environmentHash: "c".repeat(64) },
      exitStatus: { kind: "exited", code: 0 },
      provenance: [
        {
          revision: SHA,
          path: "test/routes/orders.test.ts",
          range: null,
          retrievalMethod: "tool_output",
          contentHash: "d".repeat(64),
        },
      ],
    }),
  ];
  return {
    workflow: makeWorkflow({ policyVersion: "1" }),
    task,
    revision: SHA,
    evidence,
    decisions: [],
    approvals: [],
    attempts: [makeAttempt({ taskId: TK, taskRevision: 1, outcome: "succeeded" })],
    unresolvedBlockers: [],
    policy: policyNone(),
    jev: JEV_ENABLED,
    now: AT,
    ...overrides,
  };
}

/** The gate's own state hash for an input — the freshness key the row must carry. */
function stateHashFor(input: TaskGateInput): string {
  const revision = input.revision ?? SHA;
  const result = evaluateTaskGate(input);
  return gateStateHash({
    task: input.task,
    revision,
    checkStates: result.checkStates,
    fresh: freshEvidence(input, revision),
  });
}

function evaluationInput(overrides: Partial<EvidenceGapInput> = {}): EvidenceGapInput {
  return {
    taskId: "tk-1",
    taskGoal: "Reject POST /orders with an empty items array",
    riskClass: "low",
    acceptanceCriteria: [{ id: "ac1", text: "empty items => 400 empty_order" }],
    checks: [{ checkId: "chk1", command: CHK1.command, state: "pass", coversCriteria: ["ac1"] }],
    tests: [],
    evidence: [
      {
        requirementId: "ac1",
        checkId: "chk1",
        command: CHK1.command,
        state: "pass",
        paths: ["test/routes/orders.test.ts"],
        excerpt: "",
      },
    ],
    claim: "done",
    ...overrides,
  };
}

function decisionFor(
  evaluation: EvidenceGapEvaluation,
  input: TaskGateInput,
  extra: Partial<Parameters<typeof buildGateDecision>[1]> = {},
): Decision {
  return buildGateDecision(evaluation, {
    workflowId: "wf-1",
    taskId: "tk-1",
    taskRevision: input.task.revision,
    revision: input.revision ?? SHA,
    stateHash: stateHashFor(input),
    now: AT,
    newId: () => "dc-gate",
    jevModelVersion: "jev-test",
    ...extra,
  });
}

describe("AC3 the evaluator's Decision is the row the task gate's C2 accepts", () => {
  it("AC3 a `no_gap` evaluation satisfies C2 and the gate passes", async () => {
    const input = gateInput();
    const evaluation = { ...(await evaluateMappingOnly(evaluationInput())), confidence: 0.95 };
    const decision = decisionFor(evaluation, input);
    const result = evaluateTaskGate({ ...input, decisions: [decision] });
    expect(result.reasons).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.c2Branch).toBe("jev_no_gap");
  });

  it("AC1 a `gap` evaluation refuses C2 with reason jev_gap", async () => {
    const input = gateInput();
    const evaluation = {
      ...(await evaluateMappingOnly(evaluationInput({ evidence: [] }))),
      confidence: 0.95,
    };
    expect(evaluation.action).toBe("gap");
    const result = evaluateTaskGate({ ...input, decisions: [decisionFor(evaluation, input)] });
    expect(result.pass).toBe(false);
    expect(result.reasons.map((r) => r.reasonCode)).toContain("jev_gap");
  });

  it("AC3 a disabled-mode evaluation records the deterministic_fallback branch", async () => {
    const input = gateInput({ jev: JEV_DISABLED });
    const evaluation = await evaluateMappingOnly(evaluationInput());
    const decision = decisionFor(evaluation, input, { fallbackReason: "jev_no_key" });
    expect(decision.action).toBe("deterministic_fallback");
    expect(decision.override).toEqual({
      actor: "policy",
      action: "deterministic_fallback",
      reason: "jev_no_key",
      at: AT,
    });
    expect(decision.jevModelVersion).toBeNull();
    expect(decision.usage.requests).toBe(0);
    const result = evaluateTaskGate({ ...input, decisions: [decision] });
    expect(result.pass).toBe(true);
    expect(result.c2Branch).toBe("deterministic_fallback");
  });

  it("AC2 a no_gap evaluation cannot waive a failing deterministic check", async () => {
    const failing = gateInput({
      evidence: [
        makeEvidence({
          id: "ev-fail" as Evidence["id"],
          taskId: TK,
          taskRevision: 1,
          requirementId: "ac1",
          checkId: "chk1",
          revision: SHA,
          commandIdentity: { command: CHK1.command, cwd: CHK1.cwd, environmentHash: "c".repeat(64) },
          exitStatus: { kind: "exited", code: 1 },
        }),
      ],
    });
    const evaluation = { ...(await evaluateMappingOnly(evaluationInput())), confidence: 0.99 };
    const result = evaluateTaskGate({ ...failing, decisions: [decisionFor(evaluation, failing)] });
    expect(result.pass).toBe(false);
    expect(result.reasons.map((r) => r.reasonCode)).toContain("check_fail");
  });

  it("AC3 recordGateDecision appends exactly one row, preserving the distribution", async () => {
    const sink = new MemoryDecisionSink();
    const input = gateInput();
    const evaluation = { ...(await evaluateMappingOnly(evaluationInput())), confidence: 0.9 };
    const row = recordGateDecision(sink, evaluation, {
      workflowId: "wf-1",
      taskId: "tk-1",
      taskRevision: 1,
      revision: SHA,
      stateHash: stateHashFor(input),
      now: AT,
      newId: () => "dc-gate",
    });
    expect(sink.rows).toEqual([row]);
    expect(row.questionId).toBe("task_evidence_gap");
    expect(row.rawDistribution).toEqual({ gap: 0, no_gap: 1 });
    expect(row.confidence).toBe(0.9);
  });

  it("AC3 the gap share in the distribution reflects the itemised criteria", async () => {
    const two = evaluationInput({
      acceptanceCriteria: [
        { id: "ac1", text: "empty items => 400" },
        { id: "ac2", text: "unknown sku => 422" },
      ],
    });
    const evaluation = await evaluateEvidenceGap(two);
    expect(evaluation.gapCriterionIds).toEqual(["ac2"]);
    const row = decisionFor({ ...evaluation, confidence: 0.8 }, gateInput());
    expect(row.rawDistribution).toEqual({ gap: 0.5, no_gap: 0.5 });
    expect(row.action).toBe("gap");
  });
});
