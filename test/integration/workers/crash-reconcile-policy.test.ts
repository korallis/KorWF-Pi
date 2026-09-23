/**
 * Issue #72 policy: an interrupted attempt must not silently discard the
 * user's work, must not replay a completed action, and must leave the task
 * somewhere it can be resumed from.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { actionIdFor } from "../../../src/storage/action-log.ts";
import { guardAction } from "../../../src/workflow/reconcile.ts";
import { defaultConfig } from "../../../src/config/load.ts";
import { createAttemptWorktree } from "../../../src/workers/worktree.ts";
import {
  classifyInterruption,
  failInterruptedTask,
  markCancellationRequested,
  reconcileCrashedAttempts,
  writeAttemptRuntime,
  type AttemptLivenessEvidence,
} from "../../../src/workers/reconcile.ts";
import { makeAttempt, makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import { makeTestRepo, type TestRepo } from "../../helpers/git-repo.ts";
import type { AttemptId, TaskId, WorkflowId } from "../../../src/storage/records.ts";

const ATTEMPT = "at-1" as AttemptId;
const TASK = "tk-1" as TaskId;
const WORKFLOW = "wf-1" as WorkflowId;
const AT = "2026-01-01T00:00:00.000Z";

interface Fixture {
  readonly repo: TestRepo;
  readonly storageRoot: string;
  readonly store: Store;
  readonly worktreePath: string;
}

const open: { store: Store; repo: TestRepo }[] = [];

afterEach(() => {
  for (const entry of open.splice(0)) {
    try {
      entry.store.close();
    } catch {
      /* already closed */
    }
    entry.repo.cleanup();
  }
});

function makeFixture(): Fixture {
  const repo = makeTestRepo("korwf-crash-policy-");
  const storageRoot = join(repo.path, ".korwf");
  const { store } = openStore({ storageRoot, reconcile: false });
  open.push({ store, repo });
  store.write(() => {
    store.workflows.insert(makeWorkflow({ baseRevision: repo.head() }));
    store.phases.insert(makePhase());
    store.tasks.insert(makeTask({ status: "running" }));
    store.attempts.insert(makeAttempt({ id: ATTEMPT }));
  });
  const worktree = createAttemptWorktree({
    projectRoot: repo.path,
    attemptId: ATTEMPT,
    baseRevision: repo.head(),
  });
  writeAttemptRuntime(storageRoot, {
    attemptId: ATTEMPT,
    taskId: TASK,
    workflowId: WORKFLOW,
    sessionId: "session-crashed",
    // A pid that is not ours and is vanishingly unlikely to be alive; the
    // liveness probe is injected below so nothing depends on that guess.
    pid: 2_147_483_600,
    startedAt: AT,
    worktreePath: worktree.path,
    cancellationRequestedAt: null,
    exitObservedAt: null,
    exitCode: null,
  });
  return { repo, storageRoot, store, worktreePath: worktree.path };
}

const dead = (): boolean => false;

describe("#72: uncommitted work in an abandoned worktree is the user's work", () => {
  it("reconciliation reports the dirty worktree and removes nothing", () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.worktreePath, "user-edit.txt"), "mine\n");
    const report = reconcileCrashedAttempts({
      store: fixture.store,
      storageRoot: fixture.storageRoot,
      projectRoot: fixture.repo.path,
      isAlive: dead,
    });
    expect(report.preservedDirtyWorktrees).toHaveLength(1);
    expect(existsSync(join(fixture.worktreePath, "user-edit.txt"))).toBe(true);
    expect(report.interrupted[0]?.line).toContain("worktree preserved at");
  });
});

describe("#72: a completed action is never replayed on resume", () => {
  it("the receipt for the crashed attempt's action refuses a repeat (#42)", () => {
    const fixture = makeFixture();
    const actionId = actionIdFor({ workflowId: WORKFLOW, kind: "git_commit", subjectId: TASK });
    fixture.store.write(() =>
      fixture.store.actions.record({
        actionId,
        recordedAt: AT,
        workflowId: WORKFLOW,
        kind: "git_commit",
        subjectKind: "task",
        subjectId: TASK,
        sessionId: "session-crashed",
        gitRevision: fixture.repo.head(),
        approvalId: null,
        externalEffect: false,
        summary: "commit the half-finished work",
      }),
    );

    const report = reconcileCrashedAttempts({
      store: fixture.store,
      storageRoot: fixture.storageRoot,
      projectRoot: fixture.repo.path,
      isAlive: dead,
    });
    expect(report.interrupted[0]?.completedActionIds).toContain(actionId);

    const verdict = guardAction({
      store: fixture.store,
      workflowId: WORKFLOW,
      sessionId: "session-resumed",
      actionId,
      now: () => AT,
      newId: () => "replay-1",
    });
    expect(verdict.kind).toBe("refused");
  });
});

describe("#72: outcome — task failed with recovery options", () => {
  it("moves the task to failed and records a bounded recovery decision", () => {
    const fixture = makeFixture();
    const report = reconcileCrashedAttempts({
      store: fixture.store,
      storageRoot: fixture.storageRoot,
      projectRoot: fixture.repo.path,
      isAlive: dead,
    });
    const interrupted = report.interrupted[0];
    expect(interrupted).toBeDefined();

    let counter = 0;
    const disposition = failInterruptedTask({
      store: fixture.store,
      workflowId: WORKFLOW,
      taskId: TASK,
      report: interrupted!,
      verdict: classifyInterruption({
        pid: 1,
        pidAlive: false,
        lockPresent: false,
        cancellationRequested: false,
        exitRecorded: false,
      } satisfies AttemptLivenessEvidence),
      config: defaultConfig().recovery,
      attemptsUsed: 1,
      now: () => AT,
      newId: () => `r-${(counter += 1)}`,
    });
    expect(disposition?.status).toBe("failed");
    // `unknown` never gets acted on as a diagnosis: it gathers evidence.
    expect(disposition?.recovery.decision.failureCategory).toBe("unknown");
    expect(disposition?.recovery.decision.response).toBe("gather_evidence");
  });
});

describe("#72: cancellation is distinguished from a crash", () => {
  it("a recorded cancellation closes the attempt as cancelled, not interrupted", () => {
    const fixture = makeFixture();
    markCancellationRequested(fixture.storageRoot, ATTEMPT, AT);
    const report = reconcileCrashedAttempts({
      store: fixture.store,
      storageRoot: fixture.storageRoot,
      projectRoot: fixture.repo.path,
      isAlive: dead,
    });
    expect(report.interrupted[0]?.cause).toBe("process_killed");
    expect(fixture.store.attempts.require(ATTEMPT).outcome).toBe("cancelled");
  });
});
