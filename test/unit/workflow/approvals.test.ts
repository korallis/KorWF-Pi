/**
 * Human-approval gates for high-risk classes (issue #49; PLAN §2.4 (3), §2.6, §7).
 *
 * AC1: "High-risk task cannot pass the gate without a valid Approval."
 * AC2: "Approval for revision N is rejected at revision N+1."
 * AC3: "Non-TTY run never blocks waiting for input" — `approvals-prompt.test.ts`.
 *
 * This file covers the record lifecycle: request, grant, single use, expiry,
 * and the invalidation events. The gate half of AC1 is in
 * `approvals-gate.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import {
  COMPLETE_TASK_ACTION,
  approvalQueue,
  consumeApproval,
  denyApproval,
  evaluatePolicyReview,
  grantApproval,
  invalidatePendingRequests,
  isActionApproved,
  isHighRiskClass,
  requestApproval,
  requestHumanCheckApproval,
  requestTaskCompletionApproval,
  requiresHumanApproval,
  revokeApproval,
  tierOf,
  validApprovalsFor,
} from "../../../src/workflow/approvals.ts";
import { HIGH_RISK_CLASSES, WORKFLOW_MODES } from "../../../src/workflow/approval-classes.ts";
import { requestKeyFor } from "../../../src/storage/approval-requests.ts";
import type { ApprovalId, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

const AT = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const TK = "tk-1" as TaskId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

function freshStore(overrides: { mode?: "shadow" | "advisory" | "supervised" | "bounded_autonomous" } = {}): Store {
  const dir = makeTempDir("korwf-approvals-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `id-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(
    makeWorkflow({ status: "running", mode: overrides.mode ?? "bounded_autonomous", policyVersion: "2026.1" }),
  );
  store.phases.insert(makePhase({ gateStatus: "running" }));
  store.tasks.insert(makeTask({ status: "review", revision: 1 }));
  return store;
}

const newId = () => `id-${(counter += 1)}`;

/** Queue a high-risk `publishing` request against the fixture task. */
function queuePublish(store: Store, summary = "publish release v1.2.0") {
  return requestApproval({
    store,
    workflowId: WF,
    classId: "publishing",
    scope: { kind: "task", taskId: TK },
    permittedAction: "publish:v1.2.0",
    summary,
    taskRevision: store.tasks.require(TK).revision,
    now: AT,
    newId,
  });
}

// ---------------------------------------------------------------------------
// The tier is code, not config
// ---------------------------------------------------------------------------

describe("AC1: the high-risk tier is fixed in code", () => {
  it("the seven PLAN \u00a77 classes are high risk in every mode", () => {
    for (const classId of HIGH_RISK_CLASSES) {
      expect(isHighRiskClass(classId)).toBe(true);
      expect(tierOf(classId)).toBe("high_risk");
      for (const mode of WORKFLOW_MODES) {
        expect(requiresHumanApproval(classId, mode)).toBe(true);
      }
    }
  });

  it("a config trying to set a high-risk class to auto is not honoured here either", () => {
    // V10 already rejects such a config. This asserts defence in depth: even
    // if one reached this module, the disposition is still `stop`.
    const table = {
      ...Object.fromEntries(
        HIGH_RISK_CLASSES.map((id) => [
          id,
          { shadow: "auto", advisory: "auto", supervised: "auto", bounded_autonomous: "auto" },
        ]),
      ),
    } as never;
    const store = freshStore();
    const result = requestApproval({
      store,
      workflowId: WF,
      classId: "destructive_git",
      scope: { kind: "task", taskId: TK },
      permittedAction: "force_push:main",
      summary: "force-push main",
      taskRevision: 1,
      now: AT,
      newId,
      table,
    });
    expect(result.outcome).toBe("stop");
    expect(result.disposition.decision).toBe("stop");
    expect(result.request?.tier).toBe("high_risk");
  });

  it("a Jev escalation cannot de-escalate a high-risk class", () => {
    const store = freshStore();
    const result = requestApproval({
      store,
      workflowId: WF,
      classId: "credential_access",
      scope: { kind: "task", taskId: TK },
      permittedAction: "read_env",
      summary: "read a credential store",
      taskRevision: 1,
      now: AT,
      newId,
      jev: { questionId: "q", proposed: "auto", probability: 0.99 },
    });
    expect(result.outcome).toBe("stop");
    expect(result.disposition.jevEscalation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Request lifecycle
// ---------------------------------------------------------------------------

describe("AC3 (queue half): requesting records a row and returns immediately", () => {
  it("a high-risk request is queued as pending and stops the phase", () => {
    const store = freshStore();
    const result = queuePublish(store);
    expect(result.outcome).toBe("stop");
    expect(result.request?.status).toBe("pending");
    expect(store.approvalRequests.pendingForWorkflow(WF)).toHaveLength(1);
  });

  it("an auto class in a permissive mode writes no request at all", () => {
    const store = freshStore({ mode: "bounded_autonomous" });
    const result = requestApproval({
      store,
      workflowId: WF,
      classId: "read_repository",
      scope: { kind: "task", taskId: TK },
      permittedAction: "read:src",
      summary: "read files",
      taskRevision: 1,
      now: AT,
      newId,
    });
    expect(result.outcome).toBe("auto");
    expect(result.request).toBeNull();
    expect(store.approvalRequests.pendingForWorkflow(WF)).toHaveLength(0);
  });

  it("the identical question is not queued twice", () => {
    const store = freshStore();
    const first = queuePublish(store);
    const second = queuePublish(store);
    expect(second.outcome).toBe("already_pending");
    expect(second.request?.requestId).toBe(first.request?.requestId);
    expect(store.approvalRequests.pendingForWorkflow(WF)).toHaveLength(1);
  });

  it("two different acts of the same class are two questions", () => {
    const store = freshStore();
    queuePublish(store);
    const other = requestApproval({
      store,
      workflowId: WF,
      classId: "publishing",
      scope: { kind: "task", taskId: TK },
      permittedAction: "publish:v1.3.0",
      summary: "publish release v1.3.0",
      taskRevision: 1,
      now: AT,
      newId,
    });
    expect(other.outcome).toBe("stop");
    expect(store.approvalRequests.pendingForWorkflow(WF)).toHaveLength(2);
  });

  it("the request key pins class, act, revisions, policy and mode", () => {
    const base = {
      classId: "publishing",
      scope: { kind: "task" as const, taskId: TK },
      permittedAction: "publish:v1",
      taskRevision: 1,
      planRevision: 1,
      policyVersion: "2026.1",
      mode: "supervised",
    };
    expect(requestKeyFor(base)).toBe(requestKeyFor({ ...base }));
    expect(requestKeyFor({ ...base, taskRevision: 2 })).not.toBe(requestKeyFor(base));
    expect(requestKeyFor({ ...base, planRevision: 2 })).not.toBe(requestKeyFor(base));
    expect(requestKeyFor({ ...base, mode: "bounded_autonomous" })).not.toBe(requestKeyFor(base));
    expect(requestKeyFor({ ...base, policyVersion: "2026.2" })).not.toBe(requestKeyFor(base));
  });
});

// ---------------------------------------------------------------------------
// Granting: a record, from a user, once
// ---------------------------------------------------------------------------

describe("AC1: only a granted record authorises a high-risk act", () => {
  it("a pending request authorises nothing", () => {
    const store = freshStore();
    queuePublish(store);
    expect(isActionApproved({ store, workflowId: WF, permittedAction: "publish:v1.2.0", taskId: TK, now: AT })).toBe(
      false,
    );
    expect(store.approvals.findBy("workflowId", WF)).toHaveLength(0);
  });

  it("granting writes an Approval pinned to the request's revisions", () => {
    const store = freshStore();
    const request = queuePublish(store).request;
    const grant = grantApproval({
      store,
      requestId: request!.requestId,
      actor: { kind: "user", identity: "owner" },
      now: AT,
      newId,
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) return;
    expect(grant.approval.actor.kind).toBe("user");
    expect(grant.approval.permittedAction).toBe("publish:v1.2.0");
    expect(grant.approval.taskRevision).toBe(1);
    expect(grant.approval.planRevision).toBe(1);
    expect(grant.approval.riskClass).toBe("high");
    expect(grant.request.status).toBe("granted");
    expect(isActionApproved({ store, workflowId: WF, permittedAction: "publish:v1.2.0", taskId: TK, now: AT })).toBe(
      true,
    );
  });

  it("a policy actor cannot grant a high-risk class (PLAN \u00a77, gates.md B8)", () => {
    const store = freshStore();
    const request = queuePublish(store).request;
    const grant = grantApproval({
      store,
      requestId: request!.requestId,
      actor: { kind: "policy", identity: "unattended" },
      now: AT,
      newId,
    });
    expect(grant.granted).toBe(false);
    if (grant.granted) return;
    expect(grant.reason).toBe("actor_not_user");
    expect(store.approvals.findBy("workflowId", WF)).toHaveLength(0);
    expect(store.approvalRequests.find(request!.requestId)?.status).toBe("pending");
  });

  it("a request is single-use: the same request cannot be granted twice", () => {
    const store = freshStore();
    const request = queuePublish(store).request;
    const actor = { kind: "user" as const, identity: "owner" };
    expect(grantApproval({ store, requestId: request!.requestId, actor, now: AT, newId }).granted).toBe(true);
    const second = grantApproval({ store, requestId: request!.requestId, actor, now: AT, newId });
    expect(second.granted).toBe(false);
    if (second.granted) return;
    expect(second.reason).toBe("request_not_pending");
    expect(store.approvals.findBy("workflowId", WF)).toHaveLength(1);
  });

  it("a denied request is answered and cannot then be granted", () => {
    const store = freshStore();
    const request = queuePublish(store).request;
    const actor = { kind: "user" as const, identity: "owner" };
    const denied = denyApproval({ store, requestId: request!.requestId, actor, now: AT });
    expect(denied?.status).toBe("denied");
    const grant = grantApproval({ store, requestId: request!.requestId, actor, now: AT, newId });
    expect(grant.granted).toBe(false);
    expect(store.approvals.findBy("workflowId", WF)).toHaveLength(0);
  });

  it("a consumed approval no longer authorises the act", () => {
    const store = freshStore();
    const request = queuePublish(store).request;
    const grant = grantApproval({
      store,
      requestId: request!.requestId,
      actor: { kind: "user", identity: "owner" },
      now: AT,
      newId,
    });
    if (!grant.granted) throw new Error("expected a grant");
    consumeApproval({ store, approvalId: grant.approval.id, now: LATER });
    expect(isActionApproved({ store, workflowId: WF, permittedAction: "publish:v1.2.0", taskId: TK, now: LATER })).toBe(
      false,
    );
    expect(store.approvals.require(grant.approval.id).invalidation?.reason).toBe("consumed");
  });

  it("a revoked approval no longer authorises the act", () => {
    const store = freshStore();
    const request = queuePublish(store).request;
    const grant = grantApproval({
      store,
      requestId: request!.requestId,
      actor: { kind: "user", identity: "owner" },
      now: AT,
      newId,
    });
    if (!grant.granted) throw new Error("expected a grant");
    revokeApproval({ store, approvalId: grant.approval.id, now: LATER });
    expect(validApprovalsFor({ store, workflowId: WF, permittedAction: "publish:v1.2.0", taskId: TK, now: LATER })).toHaveLength(
      0,
    );
  });

  it("an approval granted by a policy actor never satisfies requireUserActor", () => {
    const store = freshStore();
    // A non-high-risk class a policy actor may legitimately answer.
    const request = requestApproval({
      store,
      workflowId: WF,
      classId: "scope_change",
      scope: { kind: "task", taskId: TK },
      permittedAction: "scope_change:tk-1",
      summary: "widen the task",
      taskRevision: 1,
      now: AT,
      newId,
    }).request;
    const grant = grantApproval({
      store,
      requestId: request!.requestId,
      actor: { kind: "policy", identity: "unattended" },
      now: AT,
      newId,
    });
    expect(grant.granted).toBe(true);
    expect(
      isActionApproved({ store, workflowId: WF, permittedAction: "scope_change:tk-1", taskId: TK, now: AT }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2: revision pinning
// ---------------------------------------------------------------------------

/** Bump the task's revision the way a content edit does (#41 \u00a75.1). */
function bumpTaskRevision(store: Store): void {
  const task = store.tasks.require(TK);
  store.tasks.update(TK, { revision: task.revision + 1, goal: `${task.goal} (edited)` });
}

describe("AC2: an approval for revision N is rejected at revision N+1", () => {
  it("a granted approval stops being valid when the task revision moves", () => {
    const store = freshStore();
    const request = queuePublish(store).request;
    const grant = grantApproval({
      store,
      requestId: request!.requestId,
      actor: { kind: "user", identity: "owner" },
      now: AT,
      newId,
    });
    if (!grant.granted) throw new Error("expected a grant");
    expect(isActionApproved({ store, workflowId: WF, permittedAction: "publish:v1.2.0", taskId: TK, now: AT })).toBe(
      true,
    );
    bumpTaskRevision(store);
    expect(store.tasks.require(TK).revision).toBe(2);
    expect(isActionApproved({ store, workflowId: WF, permittedAction: "publish:v1.2.0", taskId: TK, now: AT })).toBe(
      false,
    );
  });

  it("a pending request asked at revision N cannot be granted at revision N+1", () => {
    const store = freshStore();
    const request = queuePublish(store).request;
    bumpTaskRevision(store);
    const grant = grantApproval({
      store,
      requestId: request!.requestId,
      actor: { kind: "user", identity: "owner" },
      now: AT,
      newId,
    });
    expect(grant.granted).toBe(false);
    if (grant.granted) return;
    expect(grant.reason).toBe("task_revision_changed");
    expect(store.approvals.findBy("workflowId", WF)).toHaveLength(0);
    expect(store.approvalRequests.find(request!.requestId)?.status).toBe("invalidated");
  });

  it("a pending request is invalidated when the plan revision moves", () => {
    const store = freshStore();
    const request = queuePublish(store).request;
    store.workflows.update(WF, { planRevision: 2 });
    const swept = invalidatePendingRequests({ store, workflowId: WF, now: LATER });
    expect(swept).toHaveLength(1);
    expect(swept[0]?.invalidationReason).toBe("plan_revision_changed");
    const grant = grantApproval({
      store,
      requestId: request!.requestId,
      actor: { kind: "user", identity: "owner" },
      now: LATER,
      newId,
    });
    expect(grant.granted).toBe(false);
  });

  it("a mode change invalidates the pending question", () => {
    const store = freshStore({ mode: "supervised" });
    queuePublish(store);
    store.workflows.update(WF, { mode: "bounded_autonomous" });
    const swept = invalidatePendingRequests({ store, workflowId: WF, now: LATER });
    expect(swept.map((r) => r.invalidationReason)).toEqual(["mode_changed"]);
  });

  it("a policy-version change invalidates the pending question", () => {
    const store = freshStore();
    queuePublish(store);
    store.workflows.update(WF, { policyVersion: "2026.2" });
    const swept = invalidatePendingRequests({ store, workflowId: WF, now: LATER });
    expect(swept.map((r) => r.invalidationReason)).toEqual(["policy_version_changed"]);
  });

  it("an expired request cannot be granted and an expired approval does not authorise", () => {
    const store = freshStore();
    const queued = requestApproval({
      store,
      workflowId: WF,
      classId: "publishing",
      scope: { kind: "task", taskId: TK },
      permittedAction: "publish:v1.2.0",
      summary: "publish",
      taskRevision: 1,
      now: AT,
      newId,
      ttlMs: 60_000,
    });
    expect(queued.request?.expiresAt).toBe("2026-01-01T00:01:00.000Z");
    const grant = grantApproval({
      store,
      requestId: queued.request!.requestId,
      actor: { kind: "user", identity: "owner" },
      now: LATER,
      newId,
    });
    expect(grant.granted).toBe(false);
    if (grant.granted) return;
    expect(grant.reason).toBe("request_expired");
  });

  it("an approval with a TTL stops authorising after it passes", () => {
    const store = freshStore();
    const request = queuePublish(store).request;
    const grant = grantApproval({
      store,
      requestId: request!.requestId,
      actor: { kind: "user", identity: "owner" },
      now: AT,
      newId,
      ttlMs: 60_000,
    });
    if (!grant.granted) throw new Error("expected a grant");
    expect(isActionApproved({ store, workflowId: WF, permittedAction: "publish:v1.2.0", taskId: TK, now: AT })).toBe(
      true,
    );
    expect(isActionApproved({ store, workflowId: WF, permittedAction: "publish:v1.2.0", taskId: TK, now: LATER })).toBe(
      false,
    );
  });

  it("an approval for one task never covers another", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ id: "tk-2" as TaskId, status: "review", revision: 1 }));
    const request = queuePublish(store).request;
    grantApproval({
      store,
      requestId: request!.requestId,
      actor: { kind: "user", identity: "owner" },
      now: AT,
      newId,
    });
    expect(
      isActionApproved({
        store,
        workflowId: WF,
        permittedAction: "publish:v1.2.0",
        taskId: "tk-2" as TaskId,
        now: AT,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Queue view and policy review
// ---------------------------------------------------------------------------

describe("AC3 (continue half): the queue is readable and says what stops a phase", () => {
  it("the queue marks high risk and phase-stopping requests", () => {
    const store = freshStore({ mode: "supervised" });
    queuePublish(store);
    requestApproval({
      store,
      workflowId: WF,
      classId: "add_dependency",
      scope: { kind: "task", taskId: TK },
      permittedAction: "add_dependency:left-pad",
      summary: "add a dependency",
      taskRevision: 1,
      now: AT,
      newId,
    });
    const rows = approvalQueue(store, WF, AT);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.highRisk).toBe(true);
    expect(rows[0]?.stopsPhase).toBe(true);
    expect(rows[1]?.highRisk).toBe(false);
    expect(rows[1]?.stopsPhase).toBe(false);
    expect(rows.every((r) => r.staleReason === null)).toBe(true);
  });

  it("the queue reports staleness without mutating anything", () => {
    const store = freshStore();
    queuePublish(store);
    bumpTaskRevision(store);
    const rows = approvalQueue(store, WF, AT);
    expect(rows[0]?.staleReason).toBe("task_revision_changed");
    expect(rows[0]?.request.status).toBe("pending");
  });

  it("evaluatePolicyReview demands a human whenever a high-risk class is present", () => {
    const high = evaluatePolicyReview({
      classes: ["edit_worktree", "deployment"],
      taskRiskClass: "low",
      policyVersion: "2026.1",
      revision: "a".repeat(40),
      taskRevision: 1,
    });
    expect(high.humanApproval).toBe(true);
    expect(high.changeClass).toBe("deployment");

    const low = evaluatePolicyReview({
      classes: ["edit_worktree"],
      taskRiskClass: "low",
      policyVersion: "2026.1",
      revision: "a".repeat(40),
      taskRevision: 1,
    });
    expect(low.humanApproval).toBe(false);

    const highTask = evaluatePolicyReview({
      classes: ["edit_worktree"],
      taskRiskClass: "high",
      policyVersion: "2026.1",
      revision: "a".repeat(40),
      taskRevision: 1,
    });
    expect(highTask.humanApproval).toBe(true);
  });

  it("requestTaskCompletionApproval queues the exact action the gate looks for", () => {
    const store = freshStore({ mode: "supervised" });
    const result = requestTaskCompletionApproval({
      store,
      workflowId: WF,
      taskId: TK,
      classId: "publishing",
      summary: "complete the release task",
      now: AT,
      newId,
    });
    expect(result.request?.permittedAction).toBe(COMPLETE_TASK_ACTION);
    expect(result.outcome).toBe("stop");
  });

  it("requestHumanCheckApproval turns a #45 pending check into a durable row", () => {
    const store = freshStore({ mode: "supervised" });
    const result = requestHumanCheckApproval({
      store,
      pending: {
        workflowId: WF,
        taskId: TK,
        taskRevision: 1,
        permittedAction: "verify_check:chk-migrate",
        instruction: "A human must confirm the migration is reversible.",
      },
      now: AT,
      newId,
    });
    expect(result.request?.permittedAction).toBe("verify_check:chk-migrate");
    expect(store.approvalRequests.pendingForTask(TK)).toHaveLength(1);
  });
});
