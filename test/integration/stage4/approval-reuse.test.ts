/**
 * Stage 4 exit criterion, part 4 — **an approval reused, or pinned to a
 * superseded revision** (issue #55; PLAN §2.4 condition 3; #49).
 *
 * An approval is a *record*: single-use, revision-pinned, and immutable. The
 * attacks here are the three ways a caller might try to spend one twice:
 *
 *  1. consume the same approval for a second completion,
 *  2. offer an approval granted at task revision N once the task is at N+1,
 *  3. rewrite the approval row so it claims the current revision.
 *
 * A `high` risk class is used throughout, because PLAN §7 makes human
 * approval mandatory there regardless of what the policy result says — so
 * the test cannot accidentally pass by the policy not asking for one.
 */
import { describe, it, expect, afterEach } from "vitest";
import { completeTask, runTaskGate } from "../../../src/verification/task-gate.ts";
import { consumeApproval, isActionApproved, validApprovalsFor } from "../../../src/workflow/approvals.ts";
import { evaluateMappingOnly } from "../../../src/verification/evaluate.ts";
import { approvalInvalidReason, type Approval, type ApprovalId } from "../../../src/storage/records.ts";
import { makeApproval } from "../../helpers/records.ts";
import {
  AT,
  CHK1,
  TK,
  WF,
  claimAttempt,
  commitFiles,
  createFixture,
  policyNone,
  type Stage4Fixture,
} from "./fixture.ts";
import { gateInput, recordC2, runAndStore } from "./gate.ts";
import { ROUTE_WITH_VALIDATION, TEST_EXERCISES_CRITERION } from "./patches.ts";

const open: Stage4Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.cleanup();
});

/**
 * A high-risk task with real passing evidence and a recorded C2 fallback:
 * every condition but C3 is satisfied, so C3 is what the assertions are about.
 */
async function readyExceptApproval(): Promise<Stage4Fixture> {
  const fixture = createFixture({ checks: [CHK1], riskClass: "high" });
  open.push(fixture);
  commitFiles(
    fixture,
    { "src/routes/orders.js": ROUTE_WITH_VALIDATION, "test/routes/orders.test.js": TEST_EXERCISES_CRITERION },
    "patch",
  );
  claimAttempt(fixture);
  const run = await runAndStore(fixture, CHK1, { paths: ["test/routes/orders.test.js"] });
  expect(run.run.status).toBe("pass");
  const ctx = { policy: policyNone(fixture) };
  recordC2(fixture, { ...(await evaluateMappingOnly(mappingInput())), confidence: 0.95 }, ctx);
  return fixture;
}

function options(fixture: Stage4Fixture) {
  const ctx = { policy: policyNone(fixture) };
  return {
    policy: ctx.policy,
    jev: gateInput(fixture, ctx).jev,
    now: AT,
    newId: () => fixture.nextId("rc"),
    worktreePath: fixture.repo.path,
    actor: { kind: "engine" as const, identity: "engine" },
    evidenceRefs: ["ev:checks", "ev:gap", "ev:approval"],
  };
}

/** A user-granted `complete_task` approval for the task's current revision. */
function grantCompletionApproval(fixture: Stage4Fixture, overrides: Partial<Approval> = {}): Approval {
  const task = fixture.store.tasks.require(TK);
  return fixture.store.approvals.insert(
    makeApproval({
      id: fixture.nextId("ap") as ApprovalId,
      workflowId: WF,
      actor: { kind: "user", identity: "owner" },
      scope: { kind: "task", taskId: TK },
      taskRevision: task.revision,
      planRevision: fixture.store.workflows.require(WF).planRevision,
      permittedAction: "complete_task",
      riskClass: "high",
      expiresAt: null,
      invalidation: null,
      ...overrides,
    }),
  );
}

describe("AC5 a high-risk task without a valid user approval never completes", () => {
  it("no approval at all: C3 approval_missing, everything else satisfied", async () => {
    const fixture = await readyExceptApproval();
    const outcome = completeTask(fixture.store, TK, options(fixture));
    expect(outcome.result.pass).toBe(false);
    expect(outcome.result.reasons.map((r) => r.reasonCode)).toEqual(["approval_missing"]);
    expect(outcome.result.conditions.filter((c) => !c.satisfied).map((c) => c.id)).toEqual(["C3"]);
    expect(fixture.store.tasks.require(TK).status).toBe("review");
  }, 30_000);

  it("a policy-granted approval does not satisfy a human approval", async () => {
    const fixture = await readyExceptApproval();
    grantCompletionApproval(fixture, { actor: { kind: "policy", identity: "auto" } });
    const outcome = completeTask(fixture.store, TK, options(fixture));
    expect(outcome.result.reasons.map((r) => r.reasonCode)).toContain("approval_actor_not_user");
    expect(fixture.store.tasks.require(TK).status).toBe("review");
    expect(isActionApproved({ store: fixture.store, workflowId: WF, permittedAction: "complete_task", taskId: TK, now: AT })).toBe(false);
  }, 30_000);
});

describe("AC5 an approval is single-use and revision-pinned", () => {
  it("a consumed approval no longer covers the action, and cannot be consumed twice", async () => {
    const fixture = await readyExceptApproval();
    const approval = grantCompletionApproval(fixture);
    expect(validApprovalsFor({ store: fixture.store, workflowId: WF, permittedAction: "complete_task", taskId: TK, now: AT })).toHaveLength(1);

    const outcome = completeTask(fixture.store, TK, options(fixture));
    expect(outcome.result.pass).toBe(true);
    expect(fixture.store.tasks.require(TK).status).toBe("done");

    consumeApproval({ store: fixture.store, approvalId: approval.id, now: AT });
    // It is spent: no valid approval remains, and a second consumption is a
    // storage error rather than a silent no-op.
    expect(validApprovalsFor({ store: fixture.store, workflowId: WF, permittedAction: "complete_task", taskId: TK, now: AT })).toEqual([]);
    expect(() => consumeApproval({ store: fixture.store, approvalId: approval.id, now: AT })).toThrow();
    expect(fixture.store.approvals.require(approval.id).invalidation?.reason).toBe("consumed");
  }, 30_000);

  it("an approval pinned to a superseded task revision is refused with its own reason code", async () => {
    const fixture = await readyExceptApproval();
    grantCompletionApproval(fixture);
    // The task's criteria change, so its revision moves. The approval was
    // granted against the old one and is now about a question nobody asked.
    fixture.store.tasks.update(TK, {
      revision: 2,
      acceptanceCriteria: [
        { id: "ac1", text: "empty items => 400 empty_order" },
        { id: "ac2", text: "a single item still returns 201" },
      ],
    });
    claimAttempt(fixture, { taskRevision: 2 });

    const gate = runTaskGate(fixture.store, TK, {
      policy: policyNone(fixture, { taskRevision: 2 }),
      jev: gateInput(fixture, { policy: policyNone(fixture, { taskRevision: 2 }) }).jev,
      now: AT,
      newId: () => fixture.nextId("rc"),
      worktreePath: fixture.repo.path,
    });
    expect(gate.result.pass).toBe(false);
    expect(gate.result.reasons.map((r) => r.reasonCode)).toContain("approval_invalid:task_revision_changed");
    expect(fixture.store.tasks.require(TK).status).toBe("review");
  }, 30_000);

  it("rewriting the approval to claim the new revision is refused by the store", async () => {
    const fixture = await readyExceptApproval();
    const approval = grantCompletionApproval(fixture);
    fixture.store.tasks.update(TK, {
      revision: 2,
      acceptanceCriteria: [{ id: "ac1", text: "changed" }],
    });

    // Immutable fields are immutable, whatever the caller intends.
    expect(() => fixture.store.approvals.update(approval.id, { taskRevision: 2 })).toThrow();
    expect(() => fixture.store.approvals.update(approval.id, { riskClass: "low" })).toThrow();
    expect(() => fixture.store.approvals.update(approval.id, { actor: { kind: "user", identity: "somebody-else" } })).toThrow();
    expect(fixture.store.approvals.require(approval.id).taskRevision).toBe(1);
    expect(
      approvalInvalidReason(fixture.store.approvals.require(approval.id), {
        task: { id: TK, revision: 2 },
        planRevision: 1,
        now: AT,
      }),
    ).toBe("task_revision_changed");
  }, 30_000);

  it("a gate receipt authorises exactly one completion and stops at the next revision", async () => {
    const fixture = await readyExceptApproval();
    grantCompletionApproval(fixture);
    const { receipt, result } = runTaskGate(fixture.store, TK, {
      policy: policyNone(fixture),
      jev: gateInput(fixture, { policy: policyNone(fixture) }).jev,
      now: AT,
      newId: () => fixture.nextId("rc"),
      worktreePath: fixture.repo.path,
    });
    expect(result.pass).toBe(true);
    expect(fixture.store.tasks.authoriseDone(receipt.receiptId)).toBe(receipt.receiptId);
    expect(() => fixture.store.tasks.authoriseDone(receipt.receiptId)).toThrow(/already used/);
  }, 30_000);
});

function mappingInput() {
  return {
    taskId: TK as string,
    taskGoal: "Reject POST /orders with an empty items array",
    riskClass: "high" as const,
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
    claim: "done",
  };
}
