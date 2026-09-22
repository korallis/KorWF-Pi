/**
 * Stage 4 exit criterion, part 1 — **unsupported completion is rejected**
 * (issue #55; PLAN §8 Stage 4 Exit; `test/scenarios/03-wrong-test.md`).
 *
 * Every test in this file is an *attack*: a worker that has done no verified
 * work tries to get `Task.status = "done"`, by each route the system exposes.
 * The assertion is always the same shape — the task is still not `done`, and
 * the refusal names a machine-readable reason.
 *
 * Scope item covered: "False claim: worker summary says done, no evidence →
 * rejected."
 *
 * Real git, real command execution, real store. No Jev key, no network.
 */
import { describe, it, expect, afterEach } from "vitest";
import { completeTask, runTaskGate, explainTaskGate } from "../../../src/verification/task-gate.ts";
import { TransitionRejected, transitionTask } from "../../../src/workflow/state.ts";
import { whyMessage } from "../../../src/extension/commands/why.ts";
import { evaluateMappingOnly } from "../../../src/verification/evaluate.ts";
import {
  AT,
  CHK1,
  CHK2,
  TK,
  claimAttempt,
  commitFiles,
  createFixture,
  policyNone,
  type Stage4Fixture,
} from "./fixture.ts";
import { gateInput, recordC2, runAndStore } from "./gate.ts";
import { ROUTE_WITH_VALIDATION, TEST_EXERCISES_CRITERION } from "./patches.ts";

const open: Stage4Fixture[] = [];

function fresh(): Stage4Fixture {
  const fixture = createFixture();
  open.push(fixture);
  return fixture;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.cleanup();
});

/** Gate options for `completeTask`/`runTaskGate` against the fixture repo. */
function options(fixture: Stage4Fixture) {
  return {
    policy: policyNone(fixture),
    jev: gateInput(fixture, { policy: policyNone(fixture) }).jev,
    now: AT,
    newId: () => fixture.nextId("rc"),
    worktreePath: fixture.repo.path,
  };
}

describe("AC1 a worker claiming success with no passing check cannot reach done", () => {
  it("the claim alone is refused: C1 check_missing, C2 jev_decision_missing", () => {
    const fixture = fresh();
    commitFiles(
      fixture,
      { "src/routes/orders.js": ROUTE_WITH_VALIDATION, "test/routes/orders.test.js": TEST_EXERCISES_CRITERION },
      "patch",
    );
    // The worker asserts completion, in the only way it can: an attempt whose
    // outcome requests completion, with a markdown summary artefact.
    claimAttempt(fixture, {
      artifacts: [
        {
          relativePath: "claim.md",
          mediaType: "text/markdown",
          sizeBytes: 64,
          contentHash: "e".repeat(64),
        },
      ],
    });

    const outcome = completeTask(fixture.store, TK, {
      ...options(fixture),
      actor: { kind: "engine", identity: "engine" },
      evidenceRefs: ["ev:claim"],
    });

    expect(outcome.result.pass).toBe(false);
    expect(outcome.transition).toBeNull();
    expect(fixture.store.tasks.require(TK).status).toBe("review");
    const codes = outcome.result.reasons.map((r) => r.reasonCode);
    expect(codes).toContain("check_missing");
    expect(codes).toContain("jev_decision_missing");
    // The refusal is durable and explains itself from recorded fields.
    expect(outcome.receipt.disposition).toBe("reject");
    expect(whyMessage(fixture.store, TK)).toContain("REFUSED");
  });

  it("the claim's text is never read: a summary saying 'all checks pass' changes nothing", () => {
    const fixture = fresh();
    commitFiles(fixture, { "src/routes/orders.js": ROUTE_WITH_VALIDATION }, "patch");
    claimAttempt(fixture, {
      id: "at-liar" as never,
      artifacts: [
        {
          relativePath: "summary.md",
          mediaType: "text/markdown",
          sizeBytes: 128,
          contentHash: "f".repeat(64),
        },
      ],
    });

    const honest = runTaskGate(fixture.store, TK, options(fixture));
    expect(honest.result.pass).toBe(false);
    // Nothing in the gate result derives from the artefact at all: the only
    // thing the claim contributed is C0's "there is something to gate".
    const c0 = honest.result.conditions.find((c) => c.id === "C0");
    expect(c0?.satisfied).toBe(true);
    expect(honest.result.reasons.every((r) => r.condition !== "C0")).toBe(true);
    expect(fixture.store.tasks.require(TK).status).toBe("review");
  });

  it("a worker-triggered transition to done is refused as unauthorized_actor", () => {
    const fixture = fresh();
    commitFiles(fixture, { "src/routes/orders.js": ROUTE_WITH_VALIDATION }, "patch");
    claimAttempt(fixture);

    let error: TransitionRejected | undefined;
    try {
      transitionTask({
        store: fixture.store,
        taskId: TK,
        to: "done",
        trigger: "task_gate_passed",
        actor: { kind: "worker", identity: "worker-1" },
        guards: {
          checks_registered: () => true,
          all_checks_pass_exact_revision: () => true,
          no_jev_gap_or_disabled: () => true,
          policy_review_satisfied: () => true,
        },
        evidenceRefs: ["ev:claim"],
        now: () => AT,
        newId: () => fixture.nextId("e"),
      });
    } catch (caught) {
      error = caught as TransitionRejected;
    }
    expect(error?.code).toBe("unauthorized_actor");
    expect(fixture.store.tasks.require(TK).status).toBe("review");
  });

  it("a direct status patch to done is refused by the store itself", () => {
    const fixture = fresh();
    commitFiles(fixture, { "src/routes/orders.js": ROUTE_WITH_VALIDATION }, "patch");
    expect(() => fixture.store.tasks.update(TK, { status: "done" })).toThrow(/status_write_forbidden/);
    expect(fixture.store.tasks.require(TK).status).toBe("review");
  });

  it("a rejecting receipt cannot be replayed as authorisation", () => {
    const fixture = fresh();
    commitFiles(fixture, { "src/routes/orders.js": ROUTE_WITH_VALIDATION }, "patch");
    claimAttempt(fixture);
    const { receipt, result } = runTaskGate(fixture.store, TK, options(fixture));
    expect(result.pass).toBe(false);
    expect(() => fixture.store.tasks.authoriseDone(receipt.receiptId)).toThrow(/status_write_forbidden/);
    expect(fixture.store.tasks.require(TK).status).toBe("review");
  });
});

describe("AC1 the honest path still works: real passing checks reach done", () => {
  it("checks that really ran, a recorded C2 decision, and the gate passes", async () => {
    const fixture = fresh();
    commitFiles(
      fixture,
      { "src/routes/orders.js": ROUTE_WITH_VALIDATION, "test/routes/orders.test.js": TEST_EXERCISES_CRITERION },
      "patch #2",
    );
    claimAttempt(fixture);

    const chk1 = await runAndStore(fixture, CHK1, { paths: ["test/routes/orders.test.js"] });
    const chk2 = await runAndStore(fixture, CHK2, { paths: ["src/routes/orders.js"] });
    expect(chk1.run.status).toBe("pass");
    expect(chk2.run.status).toBe("pass");
    // Evidence is pinned to the exact revision the commands ran at.
    expect(chk1.evidence?.revision).toBe(fixture.head());

    const ctx = { policy: policyNone(fixture) };
    const evaluation = { ...(await evaluateMappingOnly(mappingInput())), confidence: 0.95 };
    recordC2(fixture, evaluation, ctx);

    const outcome = completeTask(fixture.store, TK, {
      ...options(fixture),
      actor: { kind: "engine", identity: "engine" },
      evidenceRefs: ["ev:checks", "ev:gap", "ev:policy"],
    });
    expect(explainTaskGate(outcome.result)).toContain("passed");
    expect(outcome.result.pass).toBe(true);
    expect(fixture.store.tasks.require(TK).status).toBe("done");
  }, 30_000);
});

/** The evaluator input for the honest path: one criterion, one passing check. */
function mappingInput() {
  return {
    taskId: TK as string,
    taskGoal: "Reject POST /orders with an empty items array",
    riskClass: "low" as const,
    acceptanceCriteria: [{ id: "ac1", text: "empty items => 400 empty_order" }],
    checks: [{ checkId: "chk1", command: CHK1.command, state: "pass", coversCriteria: ["ac1"] }],
    tests: [],
    evidence: [
      {
        requirementId: "ac1",
        checkId: "chk1",
        command: CHK1.command,
        state: "pass",
        paths: ["test/routes/orders.test.js"],
        excerpt: "2 passing",
      },
    ],
    claim: "Implemented and tested empty-order rejection.",
  };
}
