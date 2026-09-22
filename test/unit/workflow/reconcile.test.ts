/**
 * `src/workflow/reconcile.ts` (issue #42): session resume / reload / fork /
 * tree reconciliation against **live** repository state.
 *
 * PLAN §5: "Pi conversation branching does not undo Git changes or external
 * effects. Fork/resume reconciles live repository state and never resurrects
 * obsolete approvals or replays completed actions."
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { ApprovalId, PhaseId, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import {
  RECONCILE_CODES,
  computeDrift,
  describeReconciliation,
  reconcileSession,
  shouldInvalidate,
  statusLine,
  UnknownWorkflowError,
} from "../../../src/workflow/reconcile.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makeApproval, makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import { makeTestRepo, type TestRepo } from "../../helpers/git-repo.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const PH = "ph-1" as PhaseId;
const TK = "tk-1" as TaskId;

const open: { dir: TempDir; store: Store }[] = [];
const repos: TestRepo[] = [];
let counter = 0;

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
  while (repos.length > 0) repos.pop()?.cleanup();
});

/** A store whose workflow was planned against `baseRevision`, with one running task. */
function freshStore(baseRevision: string): Store {
  const dir = makeTempDir("korwf-recon-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `a-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ baseRevision, planRevision: 1, status: "running" }));
  store.phases.insert(makePhase({ gateStatus: "running" }));
  store.tasks.insert(makeTask({ status: "running" }));
  return store;
}

function freshRepo(): TestRepo {
  const repo = makeTestRepo();
  repos.push(repo);
  return repo;
}

function reconcile(store: Store, repo: TestRepo, event: Parameters<typeof reconcileSession>[0]["event"]) {
  return reconcileSession({
    store,
    workflowId: WF,
    event,
    sessionId: "session-forked",
    cwd: repo.path,
    now: () => AT,
    newId: () => `id-${(counter += 1)}`,
  });
}

describe("AC1: fork the session, mutate the repo, resume — status shows the drift", () => {
  it("reports no drift and touches nothing when HEAD is still the plan base", () => {
    const repo = freshRepo();
    const store = freshStore(repo.head());
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId }));

    const report = reconcile(store, repo, "resume");

    expect(report.drift.relation).toBe("same");
    expect(report.findings).toEqual([]);
    expect(report.invalidatedApprovals).toEqual([]);
    expect(store.approvals.require("ap-1").invalidation).toBeNull();
    expect(store.tasks.require(TK).status).toBe("running");
    expect(statusLine(report)).toContain("working tree clean");
  });

  it("surfaces revision drift after a commit lands while the session was away", () => {
    const repo = freshRepo();
    const base = repo.head();
    const store = freshStore(base);
    const moved = repo.commitFile("feature.ts", "export const x = 1;\n", "work landed outside the session");

    const report = reconcile(store, repo, "resume");

    expect(report.drift.relation).toBe("advanced");
    expect(report.findings.map((f) => f.code)).toContain(RECONCILE_CODES.revisionDrift);
    expect(statusLine(report)).toContain(moved.slice(0, 12));
    expect(statusLine(report)).toContain(base.slice(0, 12));
  });

  it("surfaces a dirty working tree as its own finding, with the changed paths", () => {
    const repo = freshRepo();
    const store = freshStore(repo.head());
    repo.writeDirty("scratch.ts", "// uncommitted\n");

    const report = reconcile(store, repo, "fork");

    expect(report.drift.dirty).toBe(true);
    const dirty = report.findings.find((f) => f.code === RECONCILE_CODES.workingTreeDirty);
    expect(dirty?.detail).toContain("scratch.ts");
  });

  it("reports a rewound HEAD as drift rather than agreement", () => {
    const repo = freshRepo();
    const base = repo.head();
    const later = repo.commitFile("a.ts", "a\n", "later");
    const store = freshStore(later);
    repo.git("reset", "-q", "--hard", base);

    const report = reconcile(store, repo, "tree");

    expect(report.drift.relation).toBe("rewound");
    expect(report.findings.map((f) => f.code)).toContain(RECONCILE_CODES.revisionDrift);
  });

  it("reports a base revision that no longer exists as an identity mismatch, not as drift-free", () => {
    const repo = freshRepo();
    const store = freshStore("f".repeat(40));

    const report = reconcile(store, repo, "fork");

    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain(RECONCILE_CODES.revisionMissing);
    expect(codes).toContain(RECONCILE_CODES.repoIdentityMismatch);
  });

  it("reports repo_unavailable when the project is no longer a git repository", () => {
    const dir = makeTempDir("korwf-norepo-");
    const store = freshStore("a".repeat(40));
    try {
      const report = reconcileSession({
        store,
        workflowId: WF,
        event: "resume",
        sessionId: "s",
        cwd: dir.path,
        now: () => AT,
        newId: () => `id-${(counter += 1)}`,
      });
      expect(report.drift.live.kind).toBe("no_repo");
      expect(report.findings.map((f) => f.code)).toContain(RECONCILE_CODES.repoUnavailable);
      expect(statusLine(report)).toContain("no git repository");
    } finally {
      dir.cleanup();
    }
  });

  it("refuses to reconcile a workflow that is not in this store", () => {
    const repo = freshRepo();
    const store = freshStore(repo.head());
    expect(() =>
      reconcileSession({
        store,
        workflowId: "wf-absent" as WorkflowId,
        event: "resume",
        sessionId: "s",
        cwd: repo.path,
        now: () => AT,
        newId: () => "x",
      }),
    ).toThrow(UnknownWorkflowError);
  });

  it("computeDrift reads live state and never the stored copy of it", () => {
    const repo = freshRepo();
    const base = repo.head();
    const workflow = makeWorkflow({ baseRevision: base });
    expect(computeDrift(workflow, repo.path).relation).toBe("same");
    repo.commitFile("b.ts", "b\n", "moved");
    // Same persisted workflow object, different answer: the repository moved.
    expect(computeDrift(workflow, repo.path).relation).toBe("advanced");
  });
});

describe("AC1: approvals are stale after a fork/resume that finds drift", () => {
  it("marks approvals stale with reason session_reconciled and blocks the task", () => {
    const repo = freshRepo();
    const store = freshStore(repo.head());
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId }));
    repo.commitFile("drift.ts", "drift\n", "repo moved under the session");

    const report = reconcile(store, repo, "resume");

    expect(report.invalidatedApprovals).toEqual(["ap-1"]);
    expect(store.approvals.require("ap-1").invalidation?.reason).toBe("session_reconciled");
    // `session_reconciled` is task=blocked, phase=paused in the #41 contract.
    expect(store.tasks.require(TK).status).toBe("blocked");
    expect(store.phases.require(PH).gateStatus).toBe("paused_approval");
  });

  it("records the invalidation detail so /korwf why can say which revisions disagreed", () => {
    const repo = freshRepo();
    const base = repo.head();
    const store = freshStore(base);
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId }));
    repo.commitFile("drift.ts", "drift\n", "moved");

    reconcile(store, repo, "fork");

    const detail = store.approvals.require("ap-1").invalidation?.detail ?? "";
    expect(detail).toContain("session fork");
    expect(detail).toContain(base.slice(0, 12));
    expect(detail).toContain(RECONCILE_CODES.revisionDrift);
  });

  it("marks a dirty tree at the recorded revision stale on a rewinding event", () => {
    const repo = freshRepo();
    const store = freshStore(repo.head());
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId }));
    repo.writeDirty("unstaged.ts", "// changed outside the session\n");

    const report = reconcile(store, repo, "fork");

    expect(report.invalidatedApprovals).toEqual(["ap-1"]);
    expect(store.approvals.require("ap-1").invalidation?.reason).toBe("session_reconciled");
  });

  it("does not invalidate on plain startup at the recorded revision with a clean tree", () => {
    const repo = freshRepo();
    const store = freshStore(repo.head());
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId }));

    const report = reconcile(store, repo, "startup");

    expect(report.invalidatedApprovals).toEqual([]);
    expect(store.approvals.require("ap-1").invalidation).toBeNull();
  });

  it("an approval invalidated by a revision change stays invalidated after a fork", () => {
    const repo = freshRepo();
    const store = freshStore(repo.head());
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId }));
    // The plan revision moved while the original conversation was live.
    store.approvals.invalidate("ap-1", {
      reason: "plan_revision_changed",
      at: AT,
      detail: "plan revised to 2",
    });

    // Forking rewinds the conversation to before the revision change.
    const report = reconcile(store, repo, "fork");

    expect(report.alreadyInvalidApprovals).toEqual(["ap-1"]);
    // Still the original reason: nothing overwrote or cleared it.
    expect(store.approvals.require("ap-1").invalidation?.reason).toBe("plan_revision_changed");
    expect(report.invalidatedApprovals).not.toContain("ap-1");
  });

  it("an approval pinned to a superseded plan revision is reported stale and then invalidated", () => {
    const repo = freshRepo();
    const store = freshStore(repo.head());
    // Approval granted at plan revision 1; the plan is now at revision 2.
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId, planRevision: 1 }));
    store.workflows.update(WF, { planRevision: 2 });

    const report = reconcile(store, repo, "resume");

    const stale = report.findings.filter((f) => f.code === RECONCILE_CODES.approvalStale);
    expect(stale.map((f) => f.subjects).flat()).toEqual(["ap-1"]);
    expect(stale[0]?.detail).toContain("plan_revision_changed");
    expect(store.approvals.require("ap-1").invalidation?.reason).toBe("session_reconciled");
  });

  it("an expired approval is never usable again after a resume", () => {
    const repo = freshRepo();
    const store = freshStore(repo.head());
    store.approvals.insert(
      makeApproval({ id: "ap-1" as ApprovalId, expiresAt: "2025-01-01T00:00:00.000Z" }),
    );

    const report = reconcile(store, repo, "resume");

    expect(report.findings.map((f) => f.code)).toContain(RECONCILE_CODES.approvalStale);
    expect(store.approvals.require("ap-1").invalidation).not.toBeNull();
  });

  it("shouldInvalidate is restrictive: any non-'same' relation invalidates regardless of event", () => {
    const repo = freshRepo();
    const base = repo.head();
    const drift = computeDrift(makeWorkflow({ baseRevision: base }), repo.path);
    expect(shouldInvalidate("startup", drift, false)).toBe(false);
    repo.commitFile("x.ts", "x\n", "moved");
    const moved = computeDrift(makeWorkflow({ baseRevision: base }), repo.path);
    for (const event of ["startup", "reload", "new", "resume", "fork", "tree"] as const) {
      expect(shouldInvalidate(event, moved, false)).toBe(true);
    }
  });

  it("describeReconciliation names the applied invalidation and its consequences", () => {
    const repo = freshRepo();
    const store = freshStore(repo.head());
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId }));
    repo.commitFile("drift.ts", "drift\n", "moved");

    const text = describeReconciliation(reconcile(store, repo, "resume"));

    expect(text).toContain("session_reconciled applied");
    expect(text).toContain("1 task(s) blocked");
    expect(text).toContain("1 phase(s) paused");
  });
});
