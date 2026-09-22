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

describe("an approved scope change persists as plan revision N+1", () => {
  function approve(store: Store, proposal: ReturnType<typeof proposeScopeChange>): string {
    store.approvals.insert(
      makeApproval({
        id: "ap-scope" as ApprovalId,
        actor: { kind: "user", identity: "owner" },
        scope: { kind: "plan" },
        taskRevision: null,
        planRevision: proposal.fromPlanRevision,
        permittedAction: permittedActionFor(proposal),
        riskClass: "high",
      }),
    );
    return "ap-scope";
  }

  it("writes the new task and bumps the plan revision", () => {
    const store = plannedStore();
    const proposal = proposeScopeChange({ store, workflowId: WF, candidate: expandedPlan() });
    const result = applyScopeChange({
      store,
      proposal,
      approvalId: approve(store, proposal),
      actor: { kind: "user", identity: "owner" },
      now: () => AT,
      newId: idFactory(),
    });
    expect(result.planRevision).toBe(2);
    expect(store.workflows.require(WF).planRevision).toBe(2);
    expect(store.tasks.findBy("workflowId", WF)).toHaveLength(2);
  });

  it("consumes the approval so it cannot authorise a second change", () => {
    const store = plannedStore();
    const proposal = proposeScopeChange({ store, workflowId: WF, candidate: expandedPlan() });
    const approvalId = approve(store, proposal);
    applyScopeChange({
      store,
      proposal,
      approvalId,
      actor: { kind: "user", identity: "owner" },
      now: () => AT,
      newId: idFactory(),
    });
    expect(store.approvals.require(approvalId).invalidation).not.toBeNull();

    // Replaying the same proposal now fails on the stale plan revision.
    let error: ScopeChangeRejected | undefined;
    try {
      applyScopeChange({
        store,
        proposal,
        approvalId,
        actor: { kind: "user", identity: "owner" },
        now: () => AT,
        newId: idFactory(),
      });
    } catch (caught) {
      error = caught as ScopeChangeRejected;
    }
    expect(error?.refusal).toBe("approval_stale_plan_revision");
    expect(store.workflows.require(WF).planRevision).toBe(2);
  });

  it("invalidates the approvals pinned to the old plan revision", () => {
    const store = plannedStore();
    store.approvals.insert(
      makeApproval({ id: "ap-old" as ApprovalId, scope: { kind: "plan" }, taskRevision: null, planRevision: 1 }),
    );
    const proposal = proposeScopeChange({ store, workflowId: WF, candidate: expandedPlan() });
    applyScopeChange({
      store,
      proposal,
      approvalId: approve(store, proposal),
      actor: { kind: "user", identity: "owner" },
      now: () => AT,
      newId: idFactory(),
    });
    expect(store.approvals.require("ap-old").invalidation?.reason).toBe("plan_revision_changed");
  });

  it("refuses a proposal computed against a plan revision that has since moved", () => {
    const store = plannedStore();
    const proposal = proposeScopeChange({ store, workflowId: WF, candidate: expandedPlan() });
    const approvalId = approve(store, proposal);
    // Someone else revises the plan in between.
    const other = proposeScopeChange({
      store,
      workflowId: WF,
      candidate: minimalPlan({ tasks: [planTask({ goal: "Different goal entirely" })] }),
    });
    store.approvals.insert(
      makeApproval({
        id: "ap-other" as ApprovalId,
        scope: { kind: "plan" },
        taskRevision: null,
        planRevision: other.fromPlanRevision,
        permittedAction: permittedActionFor(other),
      }),
    );
    applyScopeChange({
      store,
      proposal: other,
      approvalId: "ap-other",
      actor: { kind: "user", identity: "owner" },
      now: () => AT,
      newId: idFactory(),
    });
    let error: ScopeChangeRejected | undefined;
    try {
      applyScopeChange({
        store,
        proposal,
        approvalId,
        actor: { kind: "user", identity: "owner" },
        now: () => AT,
        newId: idFactory(),
      });
    } catch (caught) {
      error = caught as ScopeChangeRejected;
    }
    expect(error?.refusal).toBe("approval_stale_plan_revision");
  });
});

describe("expansion is named, and a replan is distinguished from a scope change", () => {
  it("classifies a new task as scope_change and a same-scope edit as replan", () => {
    const store = plannedStore();
    const expansion = proposeScopeChange({ store, workflowId: WF, candidate: expandedPlan() });
    expect(expansion.changeKind).toBe("scope_change");
    expect(expansion.expansionReasons.join(" ")).toContain("new task");

    const replan = proposeScopeChange({
      store,
      workflowId: WF,
      candidate: minimalPlan({
        tasks: [planTask({ acceptanceCriteria: [{ id: "ac1", text: "The example module exports greet() twice." }] })],
      }),
    });
    expect(replan.changeKind).toBe("replan");
    expect(replan.expandsScope).toBe(false);
    expect(replan.tasks.find((t) => t.id === "t1")?.kind).toBe("redefined");
  });

  it("treats a newly claimed ownership path as an expansion", () => {
    const store = plannedStore();
    const proposal = proposeScopeChange({
      store,
      workflowId: WF,
      candidate: minimalPlan({
        tasks: [planTask({ ownership: { paths: ["src/example.ts", "src/new.ts"], components: ["example"] } })],
      }),
    });
    expect(proposal.expandsScope).toBe(true);
    expect(proposal.expansionReasons.join(" ")).toContain("src/new.ts");
    expect(proposal.tasks.find((t) => t.id === "t1")?.kind).toBe("reowned");
  });

  it("reports a dropped task as removed, and a new phase as an expansion", () => {
    const store = plannedStore();
    const proposal = proposeScopeChange({
      store,
      workflowId: WF,
      candidate: minimalPlan({
        phases: [planPhase(), planPhase({ id: "p2", order: 1, goal: "A whole new phase" })],
        // Different goal *and* disjoint ownership, so this is genuinely a new
        // piece of work rather than the old task redefined (docs/records.md
        // §5.1's identity rule, which `plan-store.ts` applies on the write).
        tasks: [
          planTask({
            id: "t9",
            goal: "Something else",
            phaseId: "p2",
            ownership: { paths: ["src/elsewhere.ts"], components: ["elsewhere"] },
          }),
        ],
      }),
    });
    expect(proposal.phases.some((p) => p.kind === "added")).toBe(true);
    expect(proposal.tasks.some((t) => t.kind === "removed")).toBe(true);
    expect(proposal.expandsScope).toBe(true);
  });

  it("an identical plan is a no-op and is refused rather than creating a revision", () => {
    const store = plannedStore();
    const proposal = proposeScopeChange({ store, workflowId: WF, candidate: minimalPlan() });
    expect(proposalIsNoop(proposal)).toBe(true);
    let error: ScopeChangeRejected | undefined;
    try {
      applyScopeChange({
        store,
        proposal,
        approvalId: "ap-none",
        actor: { kind: "user", identity: "owner" },
        now: () => AT,
        newId: idFactory(),
      });
    } catch (caught) {
      error = caught as ScopeChangeRejected;
    }
    expect(error?.refusal).toBe("noop");
    expect(store.workflows.require(WF).planRevision).toBe(1);
  });

  it("the digest changes when the diff changes, so an approval cannot be reused", () => {
    const store = plannedStore();
    const a = proposeScopeChange({ store, workflowId: WF, candidate: expandedPlan() });
    const b = proposeScopeChange({
      store,
      workflowId: WF,
      candidate: minimalPlan({
        tasks: [planTask(), planTask({ id: "t3", goal: "A different second task" })],
      }),
    });
    expect(a.digest).not.toBe(b.digest);
    expect(approvalRefusalFor(undefined, a, AT)).toBe("no_approval");
  });

  it("describeProposal names the expansion for the approval prompt", () => {
    const store = plannedStore();
    const text = describeProposal(proposeScopeChange({ store, workflowId: WF, candidate: expandedPlan() }));
    expect(text).toContain("EXPANDS SCOPE");
    expect(text).toContain("never automatic");
    expect(text).toContain("added task t2");
  });
});
