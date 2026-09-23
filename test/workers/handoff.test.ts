/**
 * Tests for src/workers/handoff.ts (issue #64; PLAN §3.D "Mid-task: hand off
 * with an explicit handoff packet and intact worktree (default), or restart
 * the task, per task-kind policy"; PLAN §7 high-risk classes).
 *
 * AC: "Handoff keeps the worktree's uncommitted changes (test)."
 * AC: "Restart discards them to the last checkpoint and says so in the audit."
 *
 * A restart is a `destructive_git` act (PLAN §7): `stop` in every mode,
 * grantable only by a `user` actor. These tests prove `applyRestart` never
 * discards without a live, user-granted approval — reused or superseded
 * proposals refuse exactly like any other rollback (#54).
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "../../src/storage/db.ts";
import { takeCheckpoint } from "../../src/workflow/checkpoint.ts";
import { grantApproval } from "../../src/workflow/approvals.ts";
import { worktreeIdentity } from "../../src/git/checkpoint.ts";
import { applyHandoff, applyRestart, midTaskPolicyFor, proposeRestart } from "../../src/workers/handoff.ts";
import { buildHandoffPacket } from "../../src/memory/handoff-packet.ts";
import { OutboundPolicy } from "../../src/security/outbound.ts";
import { defaultConfig } from "../../src/config/load.ts";
import { makeAttempt, makePhase, makeTask, makeWorkflow } from "../helpers/records.ts";
import { makeTestRepo, type TestRepo } from "../helpers/git-repo.ts";
import { makeTempDir, type TempDir } from "../helpers/temp-dir.ts";
import type { IsoTimestamp, TaskId, WorkflowId } from "../../src/storage/records.ts";

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
  const dir: TempDir = makeTempDir("korwf-handoff-store-");
  const { store } = openStore({ storageRoot: dir.path, now, newId });
  cleanups.push(() => {
    store.close();
    dir.cleanup();
  });
  store.workflows.insert(makeWorkflow({ id: WF, status: "running" }));
  store.phases.insert(makePhase({ gateStatus: "running" }));
  store.tasks.insert(makeTask({ id: TK, status: "running", revision: 1 }));
  return store;
}

function freshWorktree(): { main: TestRepo; worktree: string } {
  const main = makeTestRepo("korwf-handoff-main-");
  cleanups.push(main.cleanup);
  const dir = makeTempDir("korwf-handoff-wt-");
  cleanups.push(dir.cleanup);
  const worktree = join(dir.path, "task");
  main.git("worktree", "add", "-q", "-b", "korwf/handoff-task", worktree);
  cleanups.push(() => {
    try {
      main.git("worktree", "remove", "--force", worktree);
    } catch {
      /* temp dir is going away anyway */
    }
  });
  return { main, worktree };
}

/** Take a checkpoint of the task worktree, ready to propose restarting to. */
function checkpoint(store: Store, fx: { main: TestRepo; worktree: string }, attemptId: string) {
  return takeCheckpoint({
    store,
    workflowId: WF,
    cwd: fx.worktree,
    kind: "pre_attempt",
    attemptId,
    taskId: TK,
    now,
    newId,
    mainTree: worktreeIdentity(fx.main.path),
  });
}

describe("midTaskPolicyFor", () => {
  it("uses the task-kind-specific policy when set", () => {
    const policy = midTaskPolicyFor({ default: "handoff", test: "restart" }, "test");
    expect(policy).toBe("restart");
  });

  it("falls back to default when the task kind has no entry", () => {
    const policy = midTaskPolicyFor({ default: "handoff" }, "docs");
    expect(policy).toBe("handoff");
  });
});

describe("AC: handoff keeps the worktree's uncommitted changes", () => {
  it("applyHandoff never touches the filesystem; uncommitted work is still there afterwards", () => {
    const store = freshStore();
    const fx = freshWorktree();
    const oldAttempt = store.attempts.insert(makeAttempt({ taskId: TK }));

    // Uncommitted work in flight.
    const scratchPath = join(fx.worktree, "in-progress.ts");
    writeFileSync(scratchPath, "export const wip = true;\n");

    const packet = buildHandoffPacket({
      attempt: oldAttempt,
      progressNotes: [{ at: AT, text: "wrote the wip module" }],
      remaining: ["finish the wip module"],
      decisions: [],
      openQuestions: [],
      evidence: [],
      task: { goal: "goal", acceptanceCriteria: [] },
      substituteModel: "acme/substitute",
      now,
    });

    const outboundPolicy = new OutboundPolicy(defaultConfig());
    const result = applyHandoff({
      store,
      now,
      newId,
      workflowId: WF,
      oldAttempt,
      packet,
      outboundPolicy,
      role: oldAttempt.role,
      workerId: "worker-2",
    });

    expect(result.newAttempt.handedOffFromAttemptId).toBe(oldAttempt.id);
    expect(result.newAttempt.usedModel).toBe("acme/substitute");
    expect(existsSync(scratchPath)).toBe(true);
    expect(readFileSync(scratchPath, "utf8")).toContain("wip = true");
  });
});

describe("AC: restart discards uncommitted work to the last checkpoint, only with an approval, and audits it", () => {
  it("(a) with no approval, applyRestart discards nothing — every uncommitted file survives", () => {
    const store = freshStore();
    const fx = freshWorktree();
    const oldAttempt = store.attempts.insert(makeAttempt({ taskId: TK }));
    const taken = checkpoint(store, fx, oldAttempt.id);

    // Work done after the checkpoint that an *approved* restart would discard.
    const latePath = join(fx.worktree, "after-checkpoint.ts");
    writeFileSync(latePath, "export const late = true;\n");

    const proposed = proposeRestart({
      store,
      now,
      newId,
      workflowId: WF,
      oldAttempt,
      checkpointId: taken.row.checkpointId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    expect(proposed.refused).toBe(false);

    const result = applyRestart({
      store,
      now,
      newId,
      workflowId: WF,
      oldAttempt,
      proposalId: proposed.proposal.proposalId,
      sessionId: SESSION,
      role: oldAttempt.role,
      workerId: "worker-2",
      substituteModel: "acme/substitute",
      mainTree: worktreeIdentity(fx.main.path),
    });

    expect(result.kind).toBe("pending_approval");
    // Nothing was touched: the file created after the checkpoint is untouched.
    expect(existsSync(latePath)).toBe(true);
    expect(readFileSync(latePath, "utf8")).toContain("late = true");
    // No new attempt was opened either — the restart is proposed, not performed.
    expect(store.attempts.forTask(TK)).toHaveLength(1);
  });

  it("(b) with a granted approval, applyRestart discards to the checkpoint and records the action", () => {
    const store = freshStore();
    const fx = freshWorktree();
    const oldAttempt = store.attempts.insert(makeAttempt({ taskId: TK }));
    const taken = checkpoint(store, fx, oldAttempt.id);

    const latePath = join(fx.worktree, "after-checkpoint.ts");
    writeFileSync(latePath, "export const late = true;\n");

    const proposed = proposeRestart({
      store,
      now,
      newId,
      workflowId: WF,
      oldAttempt,
      checkpointId: taken.row.checkpointId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    const grant = grantApproval({
      store,
      requestId: proposed.requestId as string,
      actor: { kind: "user", identity: "lee" },
      now: AT,
      newId,
    });
    expect(grant.granted).toBe(true);

    const result = applyRestart({
      store,
      now,
      newId,
      workflowId: WF,
      oldAttempt,
      proposalId: proposed.proposal.proposalId,
      sessionId: SESSION,
      role: oldAttempt.role,
      workerId: "worker-2",
      substituteModel: "acme/substitute",
      mainTree: worktreeIdentity(fx.main.path),
    });

    expect(result.kind).toBe("restarted");
    if (result.kind !== "restarted") return;
    expect(existsSync(latePath)).toBe(false);
    expect(result.newAttempt.handedOffFromAttemptId).toBeNull();
    expect(result.newAttempt.usedModel).toBe("acme/substitute");

    const audited = store.actions.forSubject("task", TK);
    expect(audited.some((a) => a.summary.includes("discarded"))).toBe(true);
    expect(audited.some((a) => a.summary.includes("midTaskPolicy=restart"))).toBe(true);
    expect(audited.some((a) => a.approvalId !== null)).toBe(true);
  });

  it("(c) a reused (already-applied) approval proposal is refused; a second restart cannot replay it", () => {
    const store = freshStore();
    const fx = freshWorktree();
    const oldAttempt = store.attempts.insert(makeAttempt({ taskId: TK }));
    const taken = checkpoint(store, fx, oldAttempt.id);

    const proposed = proposeRestart({
      store,
      now,
      newId,
      workflowId: WF,
      oldAttempt,
      checkpointId: taken.row.checkpointId,
      mainTree: worktreeIdentity(fx.main.path),
    });
    grantApproval({
      store,
      requestId: proposed.requestId as string,
      actor: { kind: "user", identity: "lee" },
      now: AT,
      newId,
    });

    const first = applyRestart({
      store,
      now,
      newId,
      workflowId: WF,
      oldAttempt,
      proposalId: proposed.proposal.proposalId,
      sessionId: SESSION,
      role: oldAttempt.role,
      workerId: "worker-2",
      substituteModel: "acme/substitute",
      mainTree: worktreeIdentity(fx.main.path),
    });
    expect(first.kind).toBe("restarted");

    // A second call against the same (now-applied) proposal must not replay.
    const second = applyRestart({
      store,
      now,
      newId,
      workflowId: WF,
      oldAttempt,
      proposalId: proposed.proposal.proposalId,
      sessionId: "session-forked",
      role: oldAttempt.role,
      workerId: "worker-3",
      substituteModel: "acme/substitute",
      mainTree: worktreeIdentity(fx.main.path),
    });
    expect(second.kind).toBe("pending_approval");
    if (second.kind !== "pending_approval") return;
    expect(second.reason).toBe("proposal_not_open");
  });

  it("a non-user actor cannot grant the approval a restart needs", () => {
    const store = freshStore();
    const fx = freshWorktree();
    const oldAttempt = store.attempts.insert(makeAttempt({ taskId: TK }));
    const taken = checkpoint(store, fx, oldAttempt.id);

    const proposed = proposeRestart({
      store,
      now,
      newId,
      workflowId: WF,
      oldAttempt,
      checkpointId: taken.row.checkpointId,
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

    const result = applyRestart({
      store,
      now,
      newId,
      workflowId: WF,
      oldAttempt,
      proposalId: proposed.proposal.proposalId,
      sessionId: SESSION,
      role: oldAttempt.role,
      workerId: "worker-2",
      substituteModel: "acme/substitute",
      mainTree: worktreeIdentity(fx.main.path),
    });
    expect(result.kind).toBe("pending_approval");
    if (result.kind !== "pending_approval") return;
    expect(result.reason).toBe("no_approval");
  });

  it("never restarts into the user's main tree, even with an approval", () => {
    const store = freshStore();
    const fx = freshWorktree();
    const oldAttempt = store.attempts.insert(makeAttempt({ taskId: TK }));
    // Checkpoint the main tree itself, so `targetIsMainTree` is real, not simulated.
    const taken = takeCheckpoint({
      store,
      workflowId: WF,
      cwd: fx.main.path,
      kind: "pre_attempt",
      attemptId: oldAttempt.id,
      taskId: TK,
      now,
      newId,
    });

    const proposed = proposeRestart({
      store,
      now,
      newId,
      workflowId: WF,
      oldAttempt,
      checkpointId: taken.row.checkpointId,
      worktreeCwd: fx.main.path,
      mainTree: worktreeIdentity(fx.main.path),
    });
    // Refused at birth: never even queued for approval (PLAN §3.G). The
    // proposal row itself already carries `target_is_main_tree`.
    expect(proposed.refused).toBe(true);
    expect(proposed.proposal.status).toBe("refused");
    expect(proposed.proposal.reasonCode).toBe("target_is_main_tree");

    const result = applyRestart({
      store,
      now,
      newId,
      workflowId: WF,
      oldAttempt,
      proposalId: proposed.proposal.proposalId,
      sessionId: SESSION,
      role: oldAttempt.role,
      workerId: "worker-2",
      substituteModel: "acme/substitute",
      mainTree: worktreeIdentity(fx.main.path),
    });
    // Already refused (not `proposed`/`approved`): applyRestart cannot open
    // it either, so nothing is discarded via this path.
    expect(result.kind).toBe("pending_approval");
  });
});
