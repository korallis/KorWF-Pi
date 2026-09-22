/**
 * Checkpoints and rollback proposals (issue #54; PLAN §3.G "Checkpoints and
 * approval policy for rollback; preserve uncommitted user work"; PLAN §10
 * "worktrees remain recoverable; dirty user changes preserved").
 *
 * AC1: "User's uncommitted change in main tree survives a rollback of a task
 *       worktree."
 * AC2: "Rollback without Approval is refused."
 * AC3: "Checkpoints are listed in `/korwf review` output."
 *
 * These drive a real git repository with a real linked worktree, because the
 * property under test is about what is on disk afterwards. A stubbed runner
 * could be made to "pass" while deleting the user's files.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "../../../src/storage/db.ts";
import {
  ROLLBACK_APPROVAL_CLASS,
  ROLLBACK_REFUSALS,
  applyRollback,
  computeRollbackImpact,
  describeImpact,
  inspectTree,
  isMainTree,
  listCheckpoints,
  proposeRollback,
  takeCheckpoint,
  wouldRiskUserWork,
} from "../../../src/workflow/checkpoint.ts";
import { grantApproval, isHighRiskClass, requiresHumanApproval, tierOf } from "../../../src/workflow/approvals.ts";
import { WORKFLOW_MODES } from "../../../src/workflow/approval-classes.ts";
import { worktreeIdentity } from "../../../src/git/checkpoint.ts";
import type { IsoTimestamp, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import { makeTestRepo, type TestRepo } from "../../helpers/git-repo.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

const AT = "2026-01-01T00:00:00.000Z" as IsoTimestamp;
const WF = "wf-1" as WorkflowId;
const TK = "tk-1" as TaskId;
const SESSION = "session-1";

let counter = 0;
const newId = () => `id-${(counter += 1)}`;
const now = () => AT;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function freshStore(): Store {
  const dir: TempDir = makeTempDir("korwf-checkpoint-store-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId });
  cleanups.push(() => {
    store.close();
    dir.cleanup();
  });
  store.workflows.insert(makeWorkflow({ status: "running", mode: "bounded_autonomous" }));
  store.phases.insert(makePhase({ gateStatus: "running" }));
  store.tasks.insert(makeTask({ status: "running", revision: 1 }));
  return store;
}

/** The user's repository plus a linked worktree standing in for a task tree. */
interface Fixture {
  readonly main: TestRepo;
  readonly worktree: string;
}

function freshRepoWithWorktree(): Fixture {
  const main = makeTestRepo("korwf-main-");
  cleanups.push(main.cleanup);
  const dir = makeTempDir("korwf-worktree-");
  cleanups.push(dir.cleanup);
  const worktree = join(dir.path, "task");
  main.git("worktree", "add", "-q", "-b", "korwf/task", worktree);
  cleanups.push(() => {
    try {
      main.git("worktree", "remove", "--force", worktree);
    } catch {
      /* the temp dir is going away anyway */
    }
  });
  return { main, worktree };
}

function writeIn(root: string, relative: string, contents: string): void {
  writeFileSync(join(root, relative), contents);
}

function readIn(root: string, relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

function commitIn(root: string, relative: string, contents: string, message: string): void {
  writeIn(root, relative, contents);
  execFileSync("git", ["add", relative], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: root, stdio: "ignore" });
}

/** Take a checkpoint of the task worktree and propose rolling back to it. */
function checkpointAndPropose(store: Store, fx: Fixture) {
  const taken = takeCheckpoint({
    store,
    workflowId: WF,
    cwd: fx.worktree,
    kind: "pre_attempt",
    attemptId: "at-1",
    taskId: TK,
    now,
    newId,
    mainTree: worktreeIdentity(fx.main.path),
  });
  return { taken };
}

// ---------------------------------------------------------------------------
// AC1 — the whole point of the issue
// ---------------------------------------------------------------------------

describe("AC1: uncommitted user work survives a checkpoint/restore cycle", () => {
  it("the user's uncommitted main-tree change is untouched by a task-worktree rollback", () => {
    const store = freshStore();
    const fx = freshRepoWithWorktree();

    // The user is midway through an edit, and has a brand-new untracked file.
    fx.main.writeDirty("README.md", "root\nUSER EDIT, NOT COMMITTED\n");
    fx.main.writeDirty("user-scratch.txt", "notes the user has not saved anywhere else\n");
    const mainHeadBefore = fx.main.head();

    // The worker checkpoints its own worktree, then changes it.
    const { taken } = checkpointAndPropose(store, fx);
    commitIn(fx.worktree, "worker.ts", "export const v = 2;\n", "worker work");
    writeIn(fx.worktree, "worker-scratch.txt", "worker scratch\n");

    const proposed = proposeRollback({
      store,
      workflowId: WF,
      checkpointId: taken.row.checkpointId,
      taskId: TK,
      attemptId: "at-1",
      now,
      newId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    expect(proposed.refused).toBe(false);
    expect(proposed.requestId).not.toBeNull();

    const grant = grantApproval({
      store,
      requestId: proposed.requestId as string,
      actor: { kind: "user", identity: "lee" },
      now: AT,
      newId,
    });
    expect(grant.granted).toBe(true);

    const result = applyRollback({
      store,
      workflowId: WF,
      proposalId: proposed.proposal.proposalId,
      sessionId: SESSION,
      now,
      newId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    expect(result.applied).toBe(true);

    // The task worktree really was rolled back…
    expect(existsSync(join(fx.worktree, "worker-scratch.txt"))).toBe(false);

    // …and the user's tree is byte-for-byte what it was: same HEAD, same
    // uncommitted edit, same untracked file.
    expect(fx.main.head()).toBe(mainHeadBefore);
    expect(readIn(fx.main.path, "README.md")).toBe("root\nUSER EDIT, NOT COMMITTED\n");
    expect(readIn(fx.main.path, "user-scratch.txt")).toBe("notes the user has not saved anywhere else\n");
    const after = inspectTree(fx.main.path);
    expect(after.dirty).toBe(true);
    expect(after.paths).toContain("user-scratch.txt");
  });

  it("capturing a checkpoint of the user's own dirty tree changes nothing in it", () => {
    const store = freshStore();
    const main = makeTestRepo("korwf-capture-");
    cleanups.push(main.cleanup);
    main.writeDirty("README.md", "root\nedited\n");
    main.writeDirty("untracked.txt", "new\n");
    const headBefore = main.head();
    const statusBefore = main.git("status", "--porcelain");

    const taken = takeCheckpoint({
      store,
      workflowId: WF,
      cwd: main.path,
      kind: "manual",
      now,
      newId,
      mainTree: worktreeIdentity(main.path),
    });

    expect(taken.row.isMainTree).toBe(true);
    expect(taken.row.dirty).toBe(true);
    expect(main.head()).toBe(headBefore);
    expect(main.git("status", "--porcelain")).toBe(statusBefore);
    expect(readIn(main.path, "untracked.txt")).toBe("new\n");
    // The untracked file is *inside* the snapshot, which `git stash create`
    // would have missed (ADR 0001 row 5).
    expect(main.git("ls-tree", "-r", "--name-only", taken.row.commitSha)).toContain("untracked.txt");
  });

  it("the preservation checkpoint makes an approved rollback itself reversible", () => {
    const store = freshStore();
    const fx = freshRepoWithWorktree();
    const { taken } = checkpointAndPropose(store, fx);
    writeIn(fx.worktree, "discarded.txt", "work the rollback throws away\n");

    const proposed = proposeRollback({
      store,
      workflowId: WF,
      checkpointId: taken.row.checkpointId,
      taskId: TK,
      now,
      newId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    grantApproval({
      store,
      requestId: proposed.requestId as string,
      actor: { kind: "user", identity: "lee" },
      now: AT,
      newId,
    });
    const result = applyRollback({
      store,
      workflowId: WF,
      proposalId: proposed.proposal.proposalId,
      sessionId: SESSION,
      now,
      newId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    expect(result.applied).toBe(true);
    if (!result.applied) return;

    expect(existsSync(join(fx.worktree, "discarded.txt"))).toBe(false);
    // The discarded file is still addressable through the preservation commit.
    const listed = fx.main.git("ls-tree", "-r", "--name-only", result.preservation.row.commitSha);
    expect(listed).toContain("discarded.txt");
    expect(result.preservation.row.kind).toBe("pre_rollback_preservation");
  });
});

// ---------------------------------------------------------------------------
// AC2 — a rollback is a proposal, and needs a real approval record
// ---------------------------------------------------------------------------

describe("AC2: rollback without Approval is refused", () => {
  it("refuses to apply a proposal that has no approval record", () => {
    const store = freshStore();
    const fx = freshRepoWithWorktree();
    const { taken } = checkpointAndPropose(store, fx);
    writeIn(fx.worktree, "later.txt", "added after the checkpoint\n");

    const proposed = proposeRollback({
      store,
      workflowId: WF,
      checkpointId: taken.row.checkpointId,
      taskId: TK,
      now,
      newId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    const result = applyRollback({
      store,
      workflowId: WF,
      proposalId: proposed.proposal.proposalId,
      sessionId: SESSION,
      now,
      newId,
      mainTree: worktreeIdentity(fx.main.path),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe(ROLLBACK_REFUSALS.noApproval);
    expect(result.proposal?.status).toBe("refused");
    // Refused means nothing happened: the file added after the checkpoint stays.
    expect(existsSync(join(fx.worktree, "later.txt"))).toBe(true);
  });

  it("destructive_git is high risk and stops in every mode, so a proposal is queued not auto-approved", () => {
    expect(isHighRiskClass(ROLLBACK_APPROVAL_CLASS)).toBe(true);
    expect(tierOf(ROLLBACK_APPROVAL_CLASS)).toBe("high_risk");
    for (const mode of WORKFLOW_MODES) {
      expect(requiresHumanApproval(ROLLBACK_APPROVAL_CLASS, mode)).toBe(true);
    }
    const store = freshStore();
    const fx = freshRepoWithWorktree();
    const { taken } = checkpointAndPropose(store, fx);
    writeIn(fx.worktree, "later.txt", "x\n");
    const proposed = proposeRollback({
      store,
      workflowId: WF,
      checkpointId: taken.row.checkpointId,
      taskId: TK,
      now,
      newId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    const request = store.approvalRequests.find(proposed.requestId as string);
    expect(request?.classId).toBe(ROLLBACK_APPROVAL_CLASS);
    expect(request?.tier).toBe("high_risk");
    expect(request?.decision).toBe("stop");
    expect(request?.status).toBe("pending");
    expect(proposed.proposal.status).toBe("proposed");
  });

  it("a non-user actor cannot grant the approval a rollback needs", () => {
    const store = freshStore();
    const fx = freshRepoWithWorktree();
    const { taken } = checkpointAndPropose(store, fx);
    writeIn(fx.worktree, "later.txt", "x\n");
    const proposed = proposeRollback({
      store,
      workflowId: WF,
      checkpointId: taken.row.checkpointId,
      taskId: TK,
      now,
      newId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    const grant = grantApproval({
      store,
      requestId: proposed.requestId as string,
      actor: { kind: "policy", identity: "auto" },
      now: AT,
      newId,
    });
    expect(grant.granted).toBe(false);

    const result = applyRollback({
      store,
      workflowId: WF,
      proposalId: proposed.proposal.proposalId,
      sessionId: SESSION,
      now,
      newId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe(ROLLBACK_REFUSALS.noApproval);
  });

  it("refuses a proposal whose target is the user's main tree, without even asking", () => {
    const store = freshStore();
    const main = makeTestRepo("korwf-maintree-");
    cleanups.push(main.cleanup);
    main.writeDirty("README.md", "root\nuser edit\n");
    const taken = takeCheckpoint({
      store,
      workflowId: WF,
      cwd: main.path,
      kind: "manual",
      now,
      newId,
      mainTree: worktreeIdentity(main.path),
    });
    main.writeDirty("later.txt", "more user work\n");

    const proposed = proposeRollback({
      store,
      workflowId: WF,
      checkpointId: taken.row.checkpointId,
      now,
      newId,
      mainTree: worktreeIdentity(main.path),
    });

    expect(proposed.refused).toBe(true);
    expect(proposed.requestId).toBeNull();
    expect(proposed.proposal.status).toBe("refused");
    expect(proposed.proposal.reasonCode).toBe(ROLLBACK_REFUSALS.targetIsMainTree);
    // No question was queued: the user is never offered the chance to
    // mis-click away their own uncommitted work.
    expect(store.approvalRequests.forWorkflow(WF)).toHaveLength(0);
    expect(existsSync(join(main.path, "later.txt"))).toBe(true);
  });

  it("does not replay an already-applied rollback in a forked session", () => {
    const store = freshStore();
    const fx = freshRepoWithWorktree();
    const { taken } = checkpointAndPropose(store, fx);
    writeIn(fx.worktree, "later.txt", "x\n");
    const proposed = proposeRollback({
      store,
      workflowId: WF,
      checkpointId: taken.row.checkpointId,
      taskId: TK,
      now,
      newId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    grantApproval({
      store,
      requestId: proposed.requestId as string,
      actor: { kind: "user", identity: "lee" },
      now: AT,
      newId,
    });
    const first = applyRollback({
      store,
      workflowId: WF,
      proposalId: proposed.proposal.proposalId,
      sessionId: SESSION,
      now,
      newId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    expect(first.applied).toBe(true);

    const second = applyRollback({
      store,
      workflowId: WF,
      proposalId: proposed.proposal.proposalId,
      sessionId: "session-forked",
      now,
      newId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    expect(second.applied).toBe(false);
    if (second.applied) return;
    expect(second.reason).toBe(ROLLBACK_REFUSALS.notOpen);
  });
});

// ---------------------------------------------------------------------------
// Dirty-tree guard and impact reporting
// ---------------------------------------------------------------------------

describe("dirty-tree guard reports facts and never reads 'nothing to lose' when unsure", () => {
  it("a non-repository is not reported as clean", () => {
    const dir = makeTempDir("korwf-norepo-");
    cleanups.push(dir.cleanup);
    const report = inspectTree(dir.path);
    expect(report.isRepository).toBe(false);
    expect(wouldRiskUserWork(report)).toBe(true);
  });

  it("a dirty tree risks user work; a clean one does not", () => {
    const main = makeTestRepo("korwf-dirty-");
    cleanups.push(main.cleanup);
    expect(wouldRiskUserWork(inspectTree(main.path))).toBe(false);
    main.writeDirty("scratch.txt", "unsaved\n");
    const dirty = inspectTree(main.path);
    expect(dirty.dirty).toBe(true);
    expect(dirty.paths).toContain("scratch.txt");
    expect(wouldRiskUserWork(dirty)).toBe(true);
  });

  it("a linked worktree is not the main tree; an unknown tree defaults to 'main'", () => {
    const fx = freshRepoWithWorktree();
    const mainIdentity = worktreeIdentity(fx.main.path);
    const taskIdentity = worktreeIdentity(fx.worktree);
    expect(mainIdentity).not.toBeNull();
    expect(taskIdentity).not.toBeNull();
    if (mainIdentity === null || taskIdentity === null) return;
    expect(isMainTree(taskIdentity, mainIdentity)).toBe(false);
    expect(isMainTree(mainIdentity, mainIdentity)).toBe(true);
    // With no declared main tree, the structural answer errs towards refusing.
    expect(isMainTree(mainIdentity, null)).toBe(true);
  });

  it("the impact names what would be deleted and flags uncommitted work", () => {
    const store = freshStore();
    const fx = freshRepoWithWorktree();
    const { taken } = checkpointAndPropose(store, fx);
    writeIn(fx.worktree, "new-untracked.txt", "would be deleted\n");
    writeIn(fx.worktree, "README.md", "root\nchanged after checkpoint\n");

    const impact = computeRollbackImpact({
      store,
      checkpointId: taken.row.checkpointId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    expect(impact.targetIsMainTree).toBe(false);
    expect(impact.wouldDelete).toContain("new-untracked.txt");
    expect(impact.wouldOverwrite).toContain("README.md");
    expect(impact.wouldLoseUncommitted).toBe(true);
    const text = describeImpact(impact);
    expect(text).toContain("DELETED");
    expect(text).toContain("UNCOMMITTED WORK IS AFFECTED");
  });
});

// ---------------------------------------------------------------------------
// AC3 — the Stage 8 review hook
// ---------------------------------------------------------------------------

describe("AC3: checkpoints are listed for /korwf review", () => {
  it("lists every checkpoint oldest-first with its open rollback proposals", () => {
    const store = freshStore();
    const fx = freshRepoWithWorktree();
    const { taken } = checkpointAndPropose(store, fx);
    writeIn(fx.worktree, "later.txt", "x\n");
    takeCheckpoint({
      store,
      workflowId: WF,
      cwd: fx.worktree,
      kind: "post_step",
      attemptId: "at-1",
      taskId: TK,
      now,
      newId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    const proposed = proposeRollback({
      store,
      workflowId: WF,
      checkpointId: taken.row.checkpointId,
      taskId: TK,
      now,
      newId,
      mainTree: worktreeIdentity(fx.main.path),
    });

    const listing = listCheckpoints(store, WF);
    expect(listing).toHaveLength(2);
    expect(listing.map((l) => l.kind)).toEqual(["pre_attempt", "post_step"]);
    expect(listing[0]?.attemptId).toBe("at-1");
    const first = listing[0];
    expect(first?.openProposals.map((p) => p.proposalId)).toEqual([proposed.proposal.proposalId]);
    expect(first?.line).toContain("rollback proposal(s) awaiting approval");
    expect(listing[1]?.openProposals).toHaveLength(0);
    expect(first?.line).toContain(first?.commitSha.slice(0, 8) as string);
  });
});
