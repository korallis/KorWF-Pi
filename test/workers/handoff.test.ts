/**
 * Tests for src/workers/handoff.ts (issue #64; PLAN §3.D "Mid-task: hand off
 * with an explicit handoff packet and intact worktree (default), or restart
 * the task, per task-kind policy").
 *
 * AC: "Handoff keeps the worktree's uncommitted changes (test)."
 * AC: "Restart discards them to the last checkpoint and says so in the audit."
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "../../src/storage/db.ts";
import { takeCheckpoint } from "../../src/workflow/checkpoint.ts";
import { worktreeIdentity } from "../../src/git/checkpoint.ts";
import { applyHandoff, applyRestart, midTaskPolicyFor } from "../../src/workers/handoff.ts";
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

describe("AC: restart discards uncommitted work to the last checkpoint and audits it", () => {
  it("restores the worktree to the checkpoint and drops files created after it", () => {
    const store = freshStore();
    const fx = freshWorktree();
    const oldAttempt = store.attempts.insert(makeAttempt({ taskId: TK }));

    const taken = takeCheckpoint({
      store,
      workflowId: WF,
      cwd: fx.worktree,
      kind: "pre_attempt",
      attemptId: oldAttempt.id,
      taskId: TK,
      now,
      newId,
      mainTree: worktreeIdentity(fx.main.path),
    });

    // Work done after the checkpoint that a restart must discard.
    writeFileSync(join(fx.worktree, "after-checkpoint.ts"), "export const late = true;\n");

    const result = applyRestart({
      store,
      now,
      newId,
      workflowId: WF,
      oldAttempt,
      sessionId: "session-1",
      role: oldAttempt.role,
      workerId: "worker-2",
      substituteModel: "acme/substitute",
      lastCheckpointCommit: taken.row.commitSha,
      worktreeCwd: fx.worktree,
      mainTree: worktreeIdentity(fx.main.path),
    });

    expect(result.discard.kind).toBe("discarded");
    expect(existsSync(join(fx.worktree, "after-checkpoint.ts"))).toBe(false);
    expect(result.newAttempt.handedOffFromAttemptId).toBeNull();

    const audited = store.actions.forSubject("task" as never, TK);
    expect(audited.some((a) => a.summary.includes("discarded"))).toBe(true);
    expect(audited.some((a) => a.summary.includes("midTaskPolicy=restart"))).toBe(true);
  });

  it("never restarts into the user's main tree", () => {
    const store = freshStore();
    const fx = freshWorktree();
    const oldAttempt = store.attempts.insert(makeAttempt({ taskId: TK }));
    const taken = takeCheckpoint({
      store,
      workflowId: WF,
      cwd: fx.worktree,
      kind: "pre_attempt",
      attemptId: oldAttempt.id,
      taskId: TK,
      now,
      newId,
    });

    const result = applyRestart({
      store,
      now,
      newId,
      workflowId: WF,
      oldAttempt,
      sessionId: "session-1",
      role: oldAttempt.role,
      workerId: "worker-2",
      substituteModel: "acme/substitute",
      lastCheckpointCommit: taken.row.commitSha,
      worktreeCwd: fx.main.path,
      mainTree: worktreeIdentity(fx.main.path),
    });

    expect(result.discard).toEqual({ kind: "skipped", reason: "target_is_main_tree" });
  });
});
