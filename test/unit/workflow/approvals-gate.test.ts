/**
 * Human approval and the task gate, end to end (issue #49; PLAN §2.4 (3)).
 *
 * AC1: "High-risk task cannot pass the gate without a valid Approval."
 * AC2: "Approval for revision N is rejected at revision N+1."
 *
 * Nothing here re-implements the gate: it drives `runTaskGate` from #46 over a
 * real store whose `Approval` rows were produced by `src/workflow/approvals.ts`.
 * Jev is disabled throughout (a recorded deterministic-fallback `Decision`), so
 * these tests also prove the human gate works with no Jev key.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import {
  evaluateTaskGate,
  freshEvidence,
  gateStateHash,
  runTaskGate,
  type JevGateConfig,
  type PolicyReviewResult,
  type TaskGateInput,
} from "../../../src/verification/task-gate.ts";
import {
  COMPLETE_TASK_ACTION,
  consumeApproval,
  grantApproval,
  requestTaskCompletionApproval,
} from "../../../src/workflow/approvals.ts";
import type { CheckDefinition, Decision, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import {
  AT,
  HASH,
  SHA,
  makeAttempt,
  makeDecision,
  makeEvidence,
  makePhase,
  makeTask,
  makeWorkflow,
} from "../../helpers/records.ts";

const WF = "wf-1" as WorkflowId;
const TK = "tk-1" as TaskId;
const CHK: CheckDefinition = {
  id: "chk1",
  kind: "command",
  command: "npm test",
  cwd: ".",
  expectedExitCode: 0,
  coversCriteria: ["ac-1"],
  required: true,
};

const JEV_DISABLED: JevGateConfig = {
  enabled: false,
  optional: true,
  confidenceThreshold: 0.8,
  questionVersion: "1.0.0",
};

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

const newId = () => `id-${(counter += 1)}`;

/** A `PolicyReviewResult` recorded for the current revision. */
function policy(overrides: Partial<PolicyReviewResult> = {}): PolicyReviewResult {
  return {
    modelReview: false,
    humanApproval: false,
    changeClass: "code",
    policyVersion: "2026.1",
    revision: SHA,
    taskRevision: 1,
    ...overrides,
  };
}

/**
 * Seed a store with a task in `review`, one passing check with evidence, a
 * succeeded attempt, and the recorded Jev-disabled fallback decision — i.e.
 * everything condition 3 does *not* cover, already satisfied.
 */
function seed(riskClass: "low" | "medium" | "high"): Store {
  const dir = makeTempDir("korwf-approvals-gate-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId });
  open.push({ dir, store });
  store.workflows.insert(
    makeWorkflow({ status: "running", mode: "bounded_autonomous", policyVersion: "2026.1", planRevision: 1 }),
  );
  store.phases.insert(makePhase({ gateStatus: "running" }));
  store.tasks.insert(makeTask({ status: "review", revision: 1, riskClass, checks: [CHK] }));
  store.attempts.insert(makeAttempt({ taskRevision: 1, outcome: "succeeded" }));
  store.evidence.insert(
    makeEvidence({
      taskRevision: 1,
      checkId: CHK.id,
      requirementId: "ac-1",
      revision: SHA,
      commandIdentity: { command: CHK.command, cwd: CHK.cwd, environmentHash: HASH },
      exitStatus: { kind: "exited", code: 0 },
    }),
  );
  store.decisions.insert(fallbackDecision(store));
  return store;
}

/** Build the gate input the runtime entry point would build. */
function inputFor(store: Store, overrides: Partial<TaskGateInput> = {}): TaskGateInput {
  const task = store.tasks.require(TK);
  return {
    workflow: store.workflows.require(WF),
    task,
    revision: SHA,
    evidence: store.evidence.findBy("taskId", TK),
    decisions: store.decisions.findBy("workflowId", WF),
    approvals: store.approvals.findBy("workflowId", WF),
    attempts: store.attempts.forTask(TK),
    unresolvedBlockers: [],
    policy: policy({ taskRevision: task.revision }),
    jev: JEV_DISABLED,
    now: AT,
    ...overrides,
  };
}

/** The recorded "Jev is off, use the deterministic predicate" decision. */
function fallbackDecision(store: Store): Decision {
  const task = store.tasks.require(TK);
  const probe: TaskGateInput = {
    workflow: store.workflows.require(WF),
    task,
    revision: SHA,
    evidence: store.evidence.findBy("taskId", TK),
    decisions: [],
    approvals: [],
    attempts: store.attempts.forTask(TK),
    unresolvedBlockers: [],
    policy: policy({ taskRevision: task.revision }),
    jev: JEV_DISABLED,
    now: AT,
  };
  const result = evaluateTaskGate(probe);
  const stateHash = gateStateHash({
    task,
    revision: SHA,
    checkStates: result.checkStates,
    fresh: freshEvidence(probe, SHA),
  });
  return makeDecision({
    id: `dc-${(counter += 1)}` as Decision["id"],
    subject: { taskId: TK, taskRevision: task.revision },
    questionId: "task_evidence_gap",
    questionVersion: "1.0.0",
    stateHash,
    action: "deterministic_fallback",
    confidence: null,
    policyRule: "fallback",
    override: { actor: "policy", action: "deterministic_fallback", reason: "jev_disabled", at: AT },
    freshness: { revision: SHA, decidedAt: AT, expiresAt: null },
  });
}

const codes = (result: { reasons: readonly { reasonCode: string }[] }): string[] =>
  result.reasons.map((r) => r.reasonCode);

/** Grant the queued completion approval as the user. */
function approveCompletion(store: Store, requestId: string) {
  return grantApproval({ store, requestId, actor: { kind: "user", identity: "owner" }, now: AT, newId });
}

describe("AC1: a high-risk task cannot pass the gate without a valid Approval", () => {
  it("a low-risk task with everything else satisfied passes", () => {
    const store = seed("low");
    const result = evaluateTaskGate(inputFor(store));
    expect(codes(result)).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it("the same task at riskClass high is refused with approval_missing", () => {
    const store = seed("high");
    const result = evaluateTaskGate(inputFor(store));
    expect(codes(result)).toContain("approval_missing");
    expect(result.pass).toBe(false);
  });

  it("a queued, unanswered request does not satisfy the gate", () => {
    const store = seed("high");
    const queued = requestTaskCompletionApproval({
      store,
      workflowId: WF,
      taskId: TK,
      classId: "publishing",
      summary: "complete the release task",
      now: AT,
      newId,
    });
    expect(queued.request?.status).toBe("pending");
    const result = evaluateTaskGate(inputFor(store));
    expect(codes(result)).toContain("approval_missing");
  });

  it("granting the request makes the gate pass, and only then", () => {
    const store = seed("high");
    const queued = requestTaskCompletionApproval({
      store,
      workflowId: WF,
      taskId: TK,
      classId: "publishing",
      summary: "complete the release task",
      now: AT,
      newId,
    });
    expect(evaluateTaskGate(inputFor(store)).pass).toBe(false);
    const grant = approveCompletion(store, queued.request!.requestId);
    expect(grant.granted).toBe(true);
    if (!grant.granted) return;
    expect(grant.approval.permittedAction).toBe(COMPLETE_TASK_ACTION);
    const result = evaluateTaskGate(inputFor(store));
    expect(codes(result)).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it("an approval granted by a policy actor is refused as approval_actor_not_user", () => {
    const store = seed("high");
    // `scope_change` is not high risk, so `grantApproval` lets a policy actor
    // answer it — and the gate still refuses to accept that as human approval.
    const queued = requestTaskCompletionApproval({
      store,
      workflowId: WF,
      taskId: TK,
      classId: "scope_change",
      summary: "complete the task",
      now: AT,
      newId,
    });
    const grant = grantApproval({
      store,
      requestId: queued.request!.requestId,
      actor: { kind: "policy", identity: "unattended" },
      now: AT,
      newId,
    });
    expect(grant.granted).toBe(true);
    const result = evaluateTaskGate(inputFor(store));
    expect(codes(result)).toContain("approval_actor_not_user");
  });

  it("a consumed approval cannot certify a second completion", () => {
    const store = seed("high");
    const queued = requestTaskCompletionApproval({
      store,
      workflowId: WF,
      taskId: TK,
      classId: "publishing",
      summary: "complete the release task",
      now: AT,
      newId,
    });
    const grant = approveCompletion(store, queued.request!.requestId);
    if (!grant.granted) throw new Error("expected a grant");
    expect(evaluateTaskGate(inputFor(store)).pass).toBe(true);
    consumeApproval({ store, approvalId: grant.approval.id, now: AT });
    const result = evaluateTaskGate(inputFor(store));
    expect(codes(result)).toContain("approval_invalid:consumed");
  });

  it("a passing gate writes a receipt and a refusal writes one naming C3", () => {
    const store = seed("high");
    const { result, receipt } = runTaskGate(store, TK, {
      policy: policy({ taskRevision: 1 }),
      jev: JEV_DISABLED,
      now: AT,
      newId,
      worktreePath: "/unused",
      resolveRevision: () => SHA,
    });
    expect(result.pass).toBe(false);
    expect(receipt.disposition).toBe("reject");
    expect(receipt.conditions.find((c) => c.id === "C3")?.reasonCode).toBe("approval_missing");
  });
});

describe("AC2: an approval for revision N is rejected at revision N+1", () => {
  it("bumping the task revision turns a passing gate into approval_invalid", () => {
    const store = seed("high");
    const queued = requestTaskCompletionApproval({
      store,
      workflowId: WF,
      taskId: TK,
      classId: "publishing",
      summary: "complete the release task",
      now: AT,
      newId,
    });
    approveCompletion(store, queued.request!.requestId);
    expect(evaluateTaskGate(inputFor(store)).pass).toBe(true);

    const task = store.tasks.require(TK);
    store.tasks.update(TK, { revision: task.revision + 1, goal: `${task.goal} (edited)` });
    const after = evaluateTaskGate(inputFor(store, { policy: policy({ taskRevision: 2 }) }));
    expect(after.pass).toBe(false);
    expect(codes(after)).toContain("approval_invalid:task_revision_changed");
  });

  it("bumping the plan revision invalidates the approval", () => {
    const store = seed("high");
    const queued = requestTaskCompletionApproval({
      store,
      workflowId: WF,
      taskId: TK,
      classId: "publishing",
      summary: "complete the release task",
      now: AT,
      newId,
    });
    approveCompletion(store, queued.request!.requestId);
    store.workflows.update(WF, { planRevision: 2 });
    const after = evaluateTaskGate(inputFor(store));
    expect(codes(after)).toContain("approval_invalid:plan_revision_changed");
  });
});
