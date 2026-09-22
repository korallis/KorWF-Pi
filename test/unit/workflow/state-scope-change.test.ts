/**
 * `src/workflow/scope-change.ts` (issue #41).
 *
 * Acceptance criterion AC3: "Scope change without approval leaves the plan
 * untouched."
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { ApprovalId, WorkflowId } from "../../../src/storage/records.ts";
import { hashRecord } from "../../../src/storage/repos/base.ts";
import { persistPlan, readStoredPlan } from "../../../src/workflow/plan-store.ts";
import {
  ScopeChangeRejected,
  applyScopeChange,
  approvalRefusalFor,
  describeProposal,
  permittedActionFor,
  proposalIsNoop,
  proposeScopeChange,
} from "../../../src/workflow/scope-change.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makeApproval, makeWorkflow } from "../../helpers/records.ts";
import { minimalPlan, planPhase, planTask } from "../../helpers/plan.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;
let records = 0;

function idFactory(): (kind: "phase" | "task") => string {
  return (kind) => `${kind === "phase" ? "ph" : "tk"}-${(records += 1)}`;
}

function plannedStore(): Store {
  const dir = makeTempDir("korwf-scope-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `a-${(counter += 1)}` });
  open.push({ dir, store });
  records = 0;
  store.workflows.insert(makeWorkflow({ planRevision: 0, status: "planning" }));
  persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
  return store;
}

/** Hash of the whole stored plan; the AC3 witness that nothing moved. */
function planHash(store: Store): string {
  return hashRecord(readStoredPlan(store, WF));
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

/** The candidate plan that adds a second task — an expansion. */
function expandedPlan() {
  return minimalPlan({
    tasks: [
      planTask(),
      planTask({
        id: "t2",
        goal: "Add a second module nobody asked for",
        ownership: { paths: ["src/extra.ts"], components: ["extra"] },
      }),
    ],
  });
}

describe("AC3: a scope change without approval leaves the plan untouched", () => {
  it("proposing writes nothing at all", () => {
    const store = plannedStore();
    const before = planHash(store);
    const auditBefore = store.audit.count();
    const proposal = proposeScopeChange({ store, workflowId: WF, candidate: expandedPlan() });
    expect(proposal.expandsScope).toBe(true);
    expect(planHash(store)).toBe(before);
    expect(store.audit.count()).toBe(auditBefore);
    expect(store.workflows.require(WF).planRevision).toBe(1);
    expect(store.tasks.findBy("workflowId", WF)).toHaveLength(1);
  });

  it("applying with no approval row refuses and changes nothing", () => {
    const store = plannedStore();
    const before = planHash(store);
    const proposal = proposeScopeChange({ store, workflowId: WF, candidate: expandedPlan() });
    expect(() =>
      applyScopeChange({
        store,
        proposal,
        approvalId: "does-not-exist",
        actor: { kind: "user", identity: "owner" },
        now: () => AT,
        newId: idFactory(),
      }),
    ).toThrow(ScopeChangeRejected);
    expect(planHash(store)).toBe(before);
  });

  it("applying with an approval for a *different* change refuses", () => {
    const store = plannedStore();
    const before = planHash(store);
    const proposal = proposeScopeChange({ store, workflowId: WF, candidate: expandedPlan() });
    store.approvals.insert(
      makeApproval({
        id: "ap-other" as ApprovalId,
        scope: { kind: "plan" },
        taskRevision: null,
        planRevision: 1,
        permittedAction: "scope_change:some-other-digest",
      }),
    );
    let error: ScopeChangeRejected | undefined;
    try {
      applyScopeChange({
        store,
        proposal,
        approvalId: "ap-other",
        actor: { kind: "user", identity: "owner" },
        now: () => AT,
        newId: idFactory(),
      });
    } catch (caught) {
      error = caught as ScopeChangeRejected;
    }
    expect(error?.refusal).toBe("approval_wrong_action");
    expect(planHash(store)).toBe(before);
  });

  it("applying with a policy-granted approval refuses: scope_change is never automatic", () => {
    const store = plannedStore();
    const before = planHash(store);
    const proposal = proposeScopeChange({ store, workflowId: WF, candidate: expandedPlan() });
    store.approvals.insert(
      makeApproval({
        id: "ap-policy" as ApprovalId,
        actor: { kind: "policy", identity: "unattended-policy" },
        scope: { kind: "plan" },
        taskRevision: null,
        planRevision: 1,
        permittedAction: permittedActionFor(proposal),
      }),
    );
    let error: ScopeChangeRejected | undefined;
    try {
      applyScopeChange({
        store,
        proposal,
        approvalId: "ap-policy",
        actor: { kind: "user", identity: "owner" },
        now: () => AT,
        newId: idFactory(),
      });
    } catch (caught) {
      error = caught as ScopeChangeRejected;
    }
    expect(error?.refusal).toBe("approval_not_from_user");
    expect(planHash(store)).toBe(before);
  });

  it("applying with an already-invalidated approval refuses", () => {
    const store = plannedStore();
    const before = planHash(store);
    const proposal = proposeScopeChange({ store, workflowId: WF, candidate: expandedPlan() });
    store.approvals.insert(
      makeApproval({
        id: "ap-dead" as ApprovalId,
        scope: { kind: "plan" },
        taskRevision: null,
        planRevision: 1,
        permittedAction: permittedActionFor(proposal),
      }),
    );
    store.approvals.invalidate("ap-dead", { reason: "revoked", at: AT, detail: "withdrawn" });
    let error: ScopeChangeRejected | undefined;
    try {
      applyScopeChange({
        store,
        proposal,
        approvalId: "ap-dead",
        actor: { kind: "user", identity: "owner" },
        now: () => AT,
        newId: idFactory(),
      });
    } catch (caught) {
      error = caught as ScopeChangeRejected;
    }
    expect(error?.refusal).toBe("approval_invalid");
    expect(planHash(store)).toBe(before);
  });
});
