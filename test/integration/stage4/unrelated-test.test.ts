/**
 * Stage 4 exit criterion, part 2 — **a test that passes without exercising
 * its acceptance criterion** (issue #55; `test/scenarios/03-wrong-test.md`).
 *
 * The attack: the worker implements the feature, writes a test that passes
 * and proves nothing about the criterion, and claims completion. Every
 * deterministic check is green, so C1 cannot help. The system must still
 * refuse, and must name `ac1` when it does.
 *
 * Variant A (Jev enabled, mocked) and variant B (Jev disabled → the
 * deterministic fallback plus the policy-required independent review) are both
 * covered, including variant B's **documented limitation**: the structural
 * fallback cannot see a wrong assertion, so with no review policy the wrong
 * patch completes — and the suite asserts the disclosure that must accompany
 * that, per 03-wrong-test.md §B4.
 *
 * Scope item covered: "Unrelated passing test (Scenario 3) → needs_changes
 * with criterion named."
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  evaluateEvidenceGap,
  evaluateMappingOnly,
  explainEvidenceGap,
  type EvidenceGapInput,
} from "../../../src/verification/evaluate.ts";
import { completeTask } from "../../../src/verification/task-gate.ts";
import { transitionTask } from "../../../src/workflow/state.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import { DecisionRecorder, MemoryDecisionSink } from "../../../src/decisions/record.ts";
import type { AskContext } from "../../../src/decisions/ask.ts";
import type { JevEvaluateResult, SystemOneRequest } from "../../../src/jev/transport.ts";
import {
  AT,
  CHK1,
  CHK2,
  JEV_DISABLED,
  TK,
  WF,
  claimAttempt,
  commitFiles,
  createFixture,
  policyNone,
  type Stage4Fixture,
} from "./fixture.ts";
import { gateInput, recordC2, runAndStore } from "./gate.ts";
import { ROUTE_WITH_VALIDATION, TEST_HAPPY_PATH_ONLY } from "./patches.ts";

const open: Stage4Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.cleanup();
});

/**
 * Patch #1 on disk, both checks really run and really pass, and a completion
 * claim on record. This is the state every test in this file starts from.
 */
async function wrongPatchAllGreen(riskClass: "low" | "medium" | "high" = "low"): Promise<Stage4Fixture> {
  const fixture = createFixture({ riskClass });
  open.push(fixture);
  commitFiles(
    fixture,
    { "src/routes/orders.js": ROUTE_WITH_VALIDATION, "test/routes/orders.test.js": TEST_HAPPY_PATH_ONLY },
    "patch #1: implemented, tested the wrong thing",
  );
  claimAttempt(fixture);
  const chk1 = await runAndStore(fixture, CHK1, { paths: ["test/routes/orders.test.js"] });
  const chk2 = await runAndStore(fixture, CHK2, { paths: ["src/routes/orders.js"] });
  // C1 holds: the refusal below has to be C2's, not C1's.
  expect(chk1.run.status).toBe("pass");
  expect(chk2.run.status).toBe("pass");
  return fixture;
}

/** The evaluator's view of patch #1: a passing check and an unrelated test. */
function patch1Input(overrides: Partial<EvidenceGapInput> = {}): EvidenceGapInput {
  return {
    taskId: TK as string,
    taskGoal: "Reject POST /orders with an empty items array",
    riskClass: "low",
    acceptanceCriteria: [{ id: "ac1", text: "empty items => 400 empty_order" }],
    checks: [
      { checkId: "chk1", command: CHK1.command, state: "pass", coversCriteria: ["ac1"] },
      { checkId: "chk2", command: CHK2.command, state: "pass", coversCriteria: ["ac1"] },
    ],
    tests: [
      {
        checkId: "chk1",
        command: CHK1.command,
        testPath: "test/routes/orders.test.js",
        excerpt: 'const ok = createOrder({ items: [{ id: 1 }] }); assert.strictEqual(ok.status, 201);',
        coversCriteria: ["ac1"],
      },
    ],
    evidence: [
      {
        requirementId: "ac1",
        checkId: "chk1",
        command: CHK1.command,
        state: "pass",
        paths: ["test/routes/orders.test.js"],
        excerpt: "1 passing",
      },
    ],
    claim: "Implemented and tested empty-order rejection.",
    ...overrides,
  };
}

/** A mock Jev that says "gap" and "this test exercises nothing" (variant A). */
function gapSayingCtx(): AskContext & { readonly sink: MemoryDecisionSink } {
  const sink = new MemoryDecisionSink();
  let n = 0;
  const respond = (request: SystemOneRequest): JevEvaluateResult => ({
    kind: "ok",
    response: {
      model: "jev-test",
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key) => [
          key,
          key.includes("claim_supported")
            ? { type: "choice", choice: "supported", confidence: 0.95, probabilities: { supported: 0.95, unsupported: 0.03, unknown: 0.02 } }
            : key.includes("evidence_gap")
              ? { type: "noul", noul: 0.92 }
              : { type: "score", score: 0, confidence: 0.9, legend: { "0": "none", "1": "adjacent", "2": "partial", "3": "full" }, probabilities: { "0": 0.85, "1": 0.05, "2": 0.05, "3": 0.05 } },
        ]),
      ),
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    requestId: "req-1",
    attempts: 1,
    elapsedMs: 1,
  });
  return {
    transport: new MockJevTransport({ responder: respond }),
    recorder: new DecisionRecorder({
      sink,
      workflowId: WF,
      revision: "a".repeat(40) as never,
      subject: null,
      now: () => AT,
      newId: () => `dc-ev-${(n += 1)}`,
    }),
    model: "jev-test",
    sink,
  };
}

describe("AC2 variant A: Jev flags the gap; the passing-but-wrong test does not complete the task", () => {
  it("the evaluator returns action=gap naming ac1, with every check passing", async () => {
    const fixture = await wrongPatchAllGreen();
    const ctx = gapSayingCtx();
    const evaluation = await evaluateEvidenceGap(patch1Input(), { ctx, subject: { taskId: TK, taskRevision: 1 } });

    expect(evaluation.action).toBe("gap");
    expect(evaluation.gapCriterionIds).toEqual(["ac1"]);
    expect(evaluation.findings[0]?.reasons).toContain("jev_reports_gap");
    // The deterministic mapping rule is satisfied — proof that C1 is green and
    // the refusal comes from the semantic evaluation alone.
    expect(evaluation.findings[0]?.mapped).toBe(true);
    expect(explainEvidenceGap(evaluation)[0]).toContain("ac1");
    expect(fixture.store.tasks.require(TK).status).toBe("review");
  }, 30_000);

  it("the gap Decision refuses C2 at the gate: jev_gap, and the task stays put", async () => {
    const fixture = await wrongPatchAllGreen();
    const ctx = { policy: policyNone(fixture) };
    const evaluation = {
      ...(await evaluateEvidenceGap(patch1Input(), { ctx: gapSayingCtx() })),
      confidence: 0.92,
    };
    expect(evaluation.action).toBe("gap");
    recordC2(fixture, evaluation, ctx);

    const outcome = completeTask(fixture.store, TK, {
      policy: ctx.policy,
      jev: gateInput(fixture, ctx).jev,
      now: AT,
      newId: () => fixture.nextId("rc"),
      worktreePath: fixture.repo.path,
      actor: { kind: "engine", identity: "engine" },
      evidenceRefs: ["ev:checks", "ev:gap"],
    });

    expect(outcome.result.pass).toBe(false);
    expect(outcome.result.reasons.map((r) => r.reasonCode)).toContain("jev_gap");
    // C1 is satisfied: no check reason appears at all.
    expect(outcome.result.conditions.find((c) => c.id === "C1")?.satisfied).toBe(true);
    expect(fixture.store.tasks.require(TK).status).toBe("review");
  }, 30_000);

  it("the task moves review → needs_changes with the criterion id in the transition evidence", async () => {
    const fixture = await wrongPatchAllGreen();
    const evaluation = await evaluateEvidenceGap(patch1Input(), { ctx: gapSayingCtx() });
    const findings = explainEvidenceGap(evaluation);
    expect(findings.join(" ")).toContain("ac1");

    const result = transitionTask({
      store: fixture.store,
      taskId: TK,
      to: "needs_changes",
      trigger: "gap_or_review_changes",
      actor: { kind: "engine", identity: "engine" },
      guards: { changes_required: () => true },
      // The criterion id travels with the transition, as state-machine.md's
      // `task-changes` row requires ("gap/review findings with criterion ids").
      evidenceRefs: [`gap:ac1`, ...evaluation.gapCriterionIds.map((id) => `criterion:${id}`)],
      gitRevision: fixture.head(),
      now: () => AT,
      newId: () => fixture.nextId("e"),
    });

    expect(result.subject.status).toBe("needs_changes");
    expect(result.subject.blocker).toBeNull();
    expect(result.subject.revision).toBe(1);
    expect(result.event.evidenceRefs).toContain("criterion:ac1");
    // Nothing ever evaluated the task gate, so there is no receipt at all.
    expect(fixture.store.gateReceipts.latestForSubject("task", TK)).toBeUndefined();
  }, 30_000);

  it("a medium-risk task is a gap on the test-exercises answer alone, even with no semantic gap", async () => {
    await wrongPatchAllGreen("medium");
    const sink = new MemoryDecisionSink();
    let n = 0;
    const ctx: AskContext = {
      transport: new MockJevTransport({
        responder: (request: SystemOneRequest): JevEvaluateResult => ({
          kind: "ok",
          response: {
            model: "jev-test",
            answers: Object.fromEntries(
              Object.keys(request.questions).map((key) => [
                key,
                key.includes("claim_supported")
                  ? { type: "choice", choice: "supported", confidence: 0.95, probabilities: { supported: 0.95, unsupported: 0.03, unknown: 0.02 } }
                  : key.includes("evidence_gap")
                    ? { type: "noul", noul: 0.05 }
                    : { type: "score", score: 0, confidence: 0.9, legend: { "0": "none", "1": "adjacent", "2": "partial", "3": "full" }, probabilities: { "0": 0.85, "1": 0.05, "2": 0.05, "3": 0.05 } },
              ]),
            ),
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          requestId: "req-1",
          attempts: 1,
          elapsedMs: 1,
        }),
      }),
      recorder: new DecisionRecorder({
        sink,
        workflowId: WF,
        revision: "a".repeat(40) as never,
        subject: null,
        now: () => AT,
        newId: () => `dc-m-${(n += 1)}`,
      }),
      model: "jev-test",
    };
    const evaluation = await evaluateEvidenceGap(patch1Input({ riskClass: "medium" }), { ctx });
    expect(evaluation.action).toBe("gap");
    expect(evaluation.findings[0]?.reasons).toContain("no_exercising_test");
  }, 30_000);
});

describe("AC2 variant B: with Jev disabled the fallback is structural, and review catches the wrong test", () => {
  it("B1 the structural fallback is satisfied by the wrong patch — the documented limitation", async () => {
    const fixture = await wrongPatchAllGreen();
    // The mapping rule cannot see a wrong assertion: the test file *is* owned
    // and the check *did* pass. 03-wrong-test.md §B1 says so explicitly.
    const evaluation = await evaluateMappingOnly(patch1Input());
    expect(evaluation.action).toBe("no_gap");
    // …but it says so *honestly*: `degraded` records that no semantic question
    // was answered, so "no gap" here is never mistaken for Jev's judgement.
    expect(evaluation.degraded).toBe(true);
    expect(evaluation.rule).toBe("verify.evidence_gap:mapping_only:no_gap");

    const ctx = { policy: policyNone(fixture), jev: JEV_DISABLED };
    recordC2(fixture, evaluation, ctx, { fallbackReason: "jev_no_key" });
    const input = gateInput(fixture, ctx);
    const decision = input.decisions.find((d) => d.questionId === "task_evidence_gap");
    // The fallback is never presented as Jev's judgement.
    expect(decision?.action).toBe("deterministic_fallback");
    expect(decision?.jevModelVersion).toBeNull();
    expect(decision?.usage.requests).toBe(0);
    expect(decision?.override?.reason).toBe("jev_no_key");
    // And no row anywhere claims Jev said "no gap" for this task.
    const forged = fixture.store.decisions
      .findBy("workflowId", WF)
      .filter((d) => d.action === "no_gap" && d.override === null);
    expect(forged).toEqual([]);
  }, 30_000);

  it("B2 with a review policy in force, the gate refuses C3 until an independent review lands", async () => {
    const fixture = await wrongPatchAllGreen();
    const evaluation = await evaluateMappingOnly(patch1Input());
    const ctx = {
      policy: policyNone(fixture, { modelReview: true, changeClass: "test_change" }),
      jev: JEV_DISABLED,
    };
    recordC2(fixture, evaluation, ctx, { fallbackReason: "jev_no_key" });

    const outcome = completeTask(fixture.store, TK, {
      policy: ctx.policy,
      jev: JEV_DISABLED,
      now: AT,
      newId: () => fixture.nextId("rc"),
      worktreePath: fixture.repo.path,
      actor: { kind: "engine", identity: "engine" },
      evidenceRefs: ["ev:checks", "ev:fallback"],
    });

    expect(outcome.result.pass).toBe(false);
    expect(outcome.result.reasons.map((r) => r.reasonCode)).toContain("review_missing");
    // C1 and C2 were both satisfied: only the review is missing.
    expect(outcome.result.conditions.find((c) => c.id === "C1")?.satisfied).toBe(true);
    expect(outcome.result.conditions.find((c) => c.id === "C2")?.satisfied).toBe(true);
    expect(outcome.result.c2Branch).toBe("deterministic_fallback");
    expect(fixture.store.tasks.require(TK).status).toBe("review");
  }, 30_000);
});
