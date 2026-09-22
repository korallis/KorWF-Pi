/**
 * The approval-request table (issue #49; migration `0009-approval-requests.sql`).
 *
 * These assert the *database* properties, so the single-use and immutability
 * guarantees survive a caller that bypasses `src/workflow/approvals.ts`
 * entirely — a resumed session, a migration, or a future module.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { requestKeyFor, type ApprovalRequest } from "../../../src/storage/approval-requests.ts";
import type { ApprovalId, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import { latestSchemaVersion, loadMigrations } from "../../../src/storage/migrations.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makeApproval, makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

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

function freshStore(): Store {
  const dir = makeTempDir("korwf-approval-requests-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `id-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ status: "running" }));
  store.phases.insert(makePhase({ gateStatus: "running" }));
  store.tasks.insert(makeTask({ status: "review", revision: 1 }));
  return store;
}

function row(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const scope = overrides.scope ?? { kind: "task" as const, taskId: TK };
  return {
    requestId: `req-${(counter += 1)}`,
    createdAt: AT,
    workflowId: WF,
    classId: "publishing",
    tier: "high_risk",
    decision: "stop",
    mode: "supervised",
    policyVersion: "1",
    scope,
    taskRevision: 1,
    planRevision: 1,
    permittedAction: "publish:v1",
    riskClass: "high",
    requestKey: requestKeyFor({
      classId: "publishing",
      scope,
      permittedAction: "publish:v1",
      taskRevision: 1,
      planRevision: 1,
      policyVersion: "1",
      mode: "supervised",
    }),
    summary: "publish v1",
    expiresAt: null,
    status: "pending",
    resolvedAt: null,
    resolvedBy: null,
    approvalId: null,
    invalidationReason: null,
    detail: null,
    ...overrides,
  };
}

describe("the migration is numbered and applied", () => {
  it("0009-approval-requests is the next consecutive migration", () => {
    const migrations = loadMigrations();
    const mine = migrations.find((m) => m.fileName.endsWith("-approval-requests.sql"));
    expect(mine).toBeDefined();
    expect(mine?.version).toBeLessThanOrEqual(latestSchemaVersion());
    // The loader already refuses a gap or a duplicate; this asserts it ran.
    expect(migrations.map((m) => m.version)).toEqual(migrations.map((_m, i) => i + 1));
  });

  it("a fresh store exposes the queue", () => {
    const store = freshStore();
    expect(store.approvalRequests.pendingForWorkflow(WF)).toEqual([]);
  });
});

describe("single use and immutability are database properties", () => {
  it("a resolved request cannot be resolved again", () => {
    const store = freshStore();
    const request = store.approvalRequests.insert(row());
    expect(
      store.approvalRequests.resolve(request.requestId, AT, {
        status: "denied",
        resolvedBy: "user:owner",
      }),
    ).toBe(true);
    expect(
      store.approvalRequests.resolve(request.requestId, LATER, {
        status: "granted",
        approvalId: "ap-1" as ApprovalId,
        resolvedBy: "user:owner",
      }),
    ).toBe(false);
    expect(store.approvalRequests.find(request.requestId)?.status).toBe("denied");
  });

  it("two pending rows for the same question are refused", () => {
    const store = freshStore();
    const first = row();
    store.approvalRequests.insert(first);
    expect(() => store.approvalRequests.insert(row({ requestKey: first.requestKey }))).toThrow();
  });

  it("a second question may be asked once the first is answered", () => {
    const store = freshStore();
    const first = store.approvalRequests.insert(row());
    store.approvalRequests.resolve(first.requestId, AT, { status: "denied", resolvedBy: "user:owner" });
    const second = store.approvalRequests.insert(row({ requestKey: first.requestKey }));
    expect(second.status).toBe("pending");
    expect(store.approvalRequests.pendingForWorkflow(WF)).toHaveLength(1);
  });

  it("a request is never deleted, even through raw SQL", () => {
    const store = freshStore();
    const request = store.approvalRequests.insert(row());
    expect(() => store.connection.exec("DELETE FROM approval_request")).toThrow(/never deleted/);
    expect(store.approvalRequests.find(request.requestId)).toBeDefined();
  });

  it("the question cannot be edited through raw SQL", () => {
    const store = freshStore();
    store.approvalRequests.insert(row());
    expect(() => store.connection.exec("UPDATE approval_request SET permittedAction = 'publish:v2'")).toThrow(
      /immutable/,
    );
    expect(() => store.connection.exec("UPDATE approval_request SET taskRevision = 99")).toThrow(/immutable/);
    expect(() => store.connection.exec("UPDATE approval_request SET tier = 'configurable'")).toThrow(/immutable/);
  });

  it("a granted request points at the Approval it produced", () => {
    const store = freshStore();
    const approval = store.approvals.insert(makeApproval({ permittedAction: "publish:v1", riskClass: "high" }));
    const request = store.approvalRequests.insert(row());
    store.approvalRequests.resolve(request.requestId, AT, {
      status: "granted",
      approvalId: approval.id,
      resolvedBy: "user:owner",
    });
    const stored = store.approvalRequests.find(request.requestId);
    expect(stored?.status).toBe("granted");
    expect(stored?.approvalId).toBe(approval.id);
    // The question itself is unchanged.
    expect(stored?.permittedAction).toBe("publish:v1");
    expect(stored?.taskRevision).toBe(1);
  });

  it("queries scope correctly by workflow and task", () => {
    const store = freshStore();
    store.approvalRequests.insert(row());
    store.approvalRequests.insert(row({ scope: { kind: "plan" }, requestKey: "plan-key" }));
    expect(store.approvalRequests.forWorkflow(WF)).toHaveLength(2);
    expect(store.approvalRequests.pendingForTask(TK)).toHaveLength(1);
  });
});
