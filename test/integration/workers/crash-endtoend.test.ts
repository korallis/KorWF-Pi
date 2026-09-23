/**
 * Issue #72 AC1, end to end through the real supervisor:
 *
 * A real worker subprocess is started under `WorkerRun` with a crash marker,
 * it writes a file in its attempt worktree, and then it is SIGKILLed while
 * the coordinator is also treated as dead — `finish()` is never called, so
 * nothing is settled and the attempt row stays `running`, exactly as a
 * kill -9 of the whole session leaves it.
 *
 * Reconciliation then runs in a freshly opened store.
 */
import { spawn as spawnReal } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { draftToContract, type ContractPolicy } from "../../../src/workers/contract.ts";
import { spawnWorker, type WorkerHandle } from "../../../src/workers/spawn.ts";
import { WorkerRun } from "../../../src/workers/lifecycle.ts";
import { waitUntil } from "../../../src/workers/process-tree.ts";
import { createAttemptWorktree } from "../../../src/workers/worktree.ts";
import { reconcileCrashedAttempts } from "../../../src/workers/reconcile.ts";
import { makeRoute } from "../../../src/models/route.ts";
import { Ledger } from "../../../src/telemetry/ledger.ts";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { budgetsWith, estimatedUsage } from "../../helpers/ledger.ts";
import { makeAttempt, makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import { makeTestRepo, type TestRepo } from "../../helpers/git-repo.ts";
import type { ModelAllowlist, ModelRef } from "../../../src/config/types.ts";
import type { AttemptId, PhaseId, TaskId, WorkflowId } from "../../../src/storage/records.ts";

const FAKE_PI = fileURLToPath(new URL("../../workers/fixtures/fake-pi.mjs", import.meta.url));
const ALLOWED: ModelRef = "provider-a/model-one";
const policy: ContractPolicy = { allowlist: { providers: [], models: [ALLOWED], pins: {} } as ModelAllowlist };
const POSIX = process.platform !== "win32";
const ATTEMPT = "at-1" as AttemptId;
const scope = {
  workflowId: "wf-1" as WorkflowId,
  phaseId: "ph-1" as PhaseId,
  taskId: "tk-1" as TaskId,
  attemptId: ATTEMPT,
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe.runIf(POSIX)("#72 AC1 end to end: SIGKILL a supervised worker, restart, reconcile", () => {
  it("attempt is interrupted, worktree and its uncommitted file survive, reservation released", async () => {
    const repo: TestRepo = makeTestRepo("korwf-crash-e2e-");
    cleanups.push(repo.cleanup);
    const storageRoot = join(repo.path, ".korwf");
    let store: Store = openStore({ storageRoot, reconcile: false }).store;
    cleanups.push(() => {
      try {
        store.close();
      } catch {
        /* already closed */
      }
    });
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

    const ledger = new Ledger(store, { budgets: budgetsWith({}), sessionId: "session-1", newId: () => "res-1" });
    const contract = draftToContract({
      workerId: "w-crash",
      role: "scout",
      task: "wait",
      cwd: worktree.path,
      model: ALLOWED,
      budget: { wallClockMs: 60_000 },
      termination: { graceMs: 1_000, artifacts: [] },
    });
    const handle: WorkerHandle = await spawnWorker(contract, {
      policy,
      piBin: process.execPath,
      parentEnv: process.env,
      spawnFn: ((bin: string, args: readonly string[], opts: Record<string, unknown>) =>
        spawnReal(bin, [FAKE_PI, ...args], opts)) as never,
    });
    await handle.call({ type: "get_state" }, 15_000);

    const run = new WorkerRun({
      handle,
      ledger,
      scope,
      route: makeRoute("provider-a", "model-one"),
      estimate: estimatedUsage(0.25),
      crashMarker: {
        storageRoot,
        attemptId: ATTEMPT,
        taskId: "tk-1",
        workflowId: "wf-1",
        sessionId: "session-1",
        worktreePath: worktree.path,
      },
    });
    run.start();
    expect(store.ledger.openReservations()).toHaveLength(1);

    // The worker is mid-edit in its worktree when everything dies.
    repo.writeDirty(join(".korwf", "worktrees", ATTEMPT, "half-written.ts"), "export const partial = 1;\n");

    // kill -9: no cancellation was requested and `finish()` never runs, so
    // nothing marks the exit. That is a machine crash as far as the store knows.
    process.kill(handle.pid, "SIGKILL");
    expect(await waitUntil(() => handle.exit !== undefined, 5_000)).toBe(true);

    // Restart.
    store.close();
    store = openStore({ storageRoot, reconcile: false }).store;
    const report = reconcileCrashedAttempts({ store, storageRoot, projectRoot: repo.path });

    expect(report.interrupted).toHaveLength(1);
    expect(report.interrupted[0]?.outcome).toBe("interrupted");
    expect(report.interrupted[0]?.cause).toBe("machine_crashed");
    expect(store.attempts.require(ATTEMPT).outcome).toBe("interrupted");

    expect(existsSync(worktree.path)).toBe(true);
    expect(readFileSync(join(worktree.path, "half-written.ts"), "utf8")).toBe("export const partial = 1;\n");
    expect(report.preservedDirtyWorktrees.map((p) => realpathSync(p))).toContain(realpathSync(worktree.path));

    expect(store.ledger.openReservations()).toHaveLength(0);
  }, 30_000);
});
