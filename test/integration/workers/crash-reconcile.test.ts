/**
 * Issue #72 AC1, against a **real** crash:
 *
 * > Kill -9 during an attempt; restart; attempt is `interrupted`, worktree
 * > exists, ledger reservation released (integration test).
 *
 * Nothing here is mocked away: a real child process is started, really
 * SIGKILLed, and reconciliation then runs against a real SQLite store and a
 * real git worktree with real uncommitted work in it.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { Ledger } from "../../../src/telemetry/ledger.ts";
import { createAttemptWorktree } from "../../../src/workers/worktree.ts";
import {
  markExitObserved,
  reconcileCrashedAttempts,
  writeAttemptRuntime,
} from "../../../src/workers/reconcile.ts";
import { makeAttempt, makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import { budgetsWith, estimatedUsage } from "../../helpers/ledger.ts";
import { makeTestRepo, type TestRepo } from "../../helpers/git-repo.ts";
import type { AttemptId, PhaseId, TaskId, WorkflowId } from "../../../src/storage/records.ts";

const ATTEMPT = "at-1" as AttemptId;
const scope = {
  workflowId: "wf-1" as WorkflowId,
  phaseId: "ph-1" as PhaseId,
  taskId: "tk-1" as TaskId,
  attemptId: ATTEMPT,
};

interface Fixture {
  readonly repo: TestRepo;
  readonly storageRoot: string;
  store: Store;
  readonly worktreePath: string;
  readonly reopen: () => Store;
  readonly cleanup: () => void;
}

const fixtures: Fixture[] = [];
const children: number[] = [];

afterEach(() => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/** A repository, a store, an attempt worktree and a `running` attempt row. */
function makeFixture(): Fixture {
  const repo = makeTestRepo("korwf-crash-");
  const storageRoot = join(repo.path, ".korwf");
  let store = openStore({ storageRoot, reconcile: false }).store;
  store.write(() => {
    store.workflows.insert(makeWorkflow({ baseRevision: repo.head() }));
    store.phases.insert(makePhase());
    store.tasks.insert(makeTask({ status: "running" }));
    store.attempts.insert(makeAttempt({ id: ATTEMPT, taskRevision: 1 }));
  });
  const worktree = createAttemptWorktree({
    projectRoot: repo.path,
    attemptId: ATTEMPT,
    baseRevision: repo.head(),
  });
  const fixture: Fixture = {
    repo,
    storageRoot,
    get store() {
      return store;
    },
    set store(next: Store) {
      store = next;
    },
    worktreePath: worktree.path,
    reopen: () => {
      store.close();
      store = openStore({ storageRoot, reconcile: false }).store;
      return store;
    },
    cleanup: () => {
      try {
        store.close();
      } catch {
        /* already closed */
      }
      repo.cleanup();
    },
  };
  fixtures.push(fixture);
  return fixture;
}

/** Start a real, long-lived child process and return its pid. */
async function startVictim(cwd: string): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd,
    stdio: "ignore",
    detached: false,
  });
  const pid = child.pid ?? -1;
  children.push(pid);
  // Give the process a moment to actually exist before anything probes it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return pid;
}

async function waitForDeath(pid: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`pid ${pid} did not die`);
}

describe("#72 AC1: kill -9 during an attempt, restart, reconcile", () => {
  it("marks the attempt interrupted, keeps the worktree, and releases the reservation", async () => {
    const fixture = makeFixture();
    const ledger = new Ledger(fixture.store, {
      budgets: budgetsWith({}),
      sessionId: "session-crashed",
      newId: () => "res-1",
    });
    ledger.reserve({ scope, estimate: estimatedUsage(0.5), label: "attempt" });
    expect(fixture.store.ledger.openReservations()).toHaveLength(1);

    const pid = await startVictim(fixture.worktreePath);
    writeAttemptRuntime(fixture.storageRoot, {
      attemptId: ATTEMPT,
      taskId: "tk-1",
      workflowId: "wf-1",
      sessionId: "session-crashed",
      pid,
      startedAt: new Date().toISOString(),
      worktreePath: fixture.worktreePath,
      cancellationRequestedAt: null,
      exitObservedAt: null,
      exitCode: null,
    });

    // The worker is mid-edit when the machine goes down.
    writeFileSync(join(fixture.worktreePath, "half-written.ts"), "export const partial = 1;\n");

    process.kill(pid, "SIGKILL");
    await waitForDeath(pid);

    // Restart: a new process opens the same store and reconciles.
    const store = fixture.reopen();
    const report = reconcileCrashedAttempts({
      store,
      storageRoot: fixture.storageRoot,
      projectRoot: fixture.repo.path,
    });

    expect(report.interrupted).toHaveLength(1);
    const [interrupted] = report.interrupted;
    expect(interrupted?.outcome).toBe("interrupted");
    expect(interrupted?.cause).toBe("machine_crashed");
    expect(store.attempts.require(ATTEMPT).outcome).toBe("interrupted");

    // The worktree and the half-written file are still there, untouched.
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(readFileSync(join(fixture.worktreePath, "half-written.ts"), "utf8")).toBe(
      "export const partial = 1;\n",
    );
    expect(interrupted?.worktreeDirty).toBe(true);
    expect(realpathSync(interrupted?.worktreePath ?? "")).toBe(realpathSync(fixture.worktreePath));

    // The reservation the dead session held no longer counts as open.
    expect(store.ledger.openReservations()).toHaveLength(0);
    expect(report.store.reservations).toHaveLength(1);
  });

  it("an observed worker exit is `worker_died` (harness), not a machine crash", async () => {
    const fixture = makeFixture();
    const pid = await startVictim(fixture.worktreePath);
    writeAttemptRuntime(fixture.storageRoot, {
      attemptId: ATTEMPT,
      taskId: "tk-1",
      workflowId: "wf-1",
      sessionId: "session-crashed",
      pid,
      startedAt: new Date().toISOString(),
      worktreePath: fixture.worktreePath,
      cancellationRequestedAt: null,
      exitObservedAt: null,
      exitCode: null,
    });
    process.kill(pid, "SIGKILL");
    await waitForDeath(pid);
    markExitObserved(fixture.storageRoot, ATTEMPT, new Date().toISOString(), null);

    const store = fixture.reopen();
    const report = reconcileCrashedAttempts({
      store,
      storageRoot: fixture.storageRoot,
      projectRoot: fixture.repo.path,
    });
    expect(report.interrupted[0]?.cause).toBe("worker_died");
    expect(report.interrupted[0]?.failureCategory).toBe("harness");
    expect(store.attempts.require(ATTEMPT).outcome).toBe("interrupted");
  });

  it("a live worker is re-attached, never closed", async () => {
    const fixture = makeFixture();
    const pid = await startVictim(fixture.worktreePath);
    writeAttemptRuntime(fixture.storageRoot, {
      attemptId: ATTEMPT,
      taskId: "tk-1",
      workflowId: "wf-1",
      sessionId: "session-live",
      pid,
      startedAt: new Date().toISOString(),
      worktreePath: fixture.worktreePath,
      cancellationRequestedAt: null,
      exitObservedAt: null,
      exitCode: null,
    });

    const store = fixture.reopen();
    const report = reconcileCrashedAttempts({
      store,
      storageRoot: fixture.storageRoot,
      projectRoot: fixture.repo.path,
    });
    expect(report.stillRunning).toEqual([ATTEMPT]);
    expect(report.interrupted).toHaveLength(0);
    expect(store.attempts.require(ATTEMPT).outcome).toBeNull();
  });
});
