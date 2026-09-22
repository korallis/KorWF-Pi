/**
 * ADR 0004 "Cancellation and process-tree termination": cancellation must
 * terminate the whole process **tree**, and the descendant list must be
 * snapshotted *before* the kill because SIGKILL orphans detached children.
 *
 * These tests spawn real processes with real detached grandchildren. A mocked
 * killer would pass even with the defect this ladder exists to prevent.
 * POSIX-only assertions are skipped on Windows, which uses `taskkill /T /F`.
 */
import { spawn as spawnReal } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { draftToContract, type ContractPolicy } from "../../src/workers/contract.ts";
import { spawnWorker, type WorkerHandle } from "../../src/workers/spawn.ts";
import {
  descendantsOf,
  realProcessOps,
  snapshotTree,
  sweepSnapshot,
  waitUntil,
} from "../../src/workers/process-tree.ts";
import type { ModelAllowlist, ModelRef } from "../../src/config/types.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const ALLOWED: ModelRef = "provider-a/model-one";
const allowlist: ModelAllowlist = { providers: [], models: [ALLOWED], pins: {} };
const policy: ContractPolicy = { allowlist };
const POSIX = process.platform !== "win32";

const live: WorkerHandle[] = [];

async function start(graceMs = 1_500): Promise<WorkerHandle> {
  const contract = draftToContract({
    workerId: "c1",
    role: "scout",
    task: "wait",
    cwd: process.cwd(),
    model: ALLOWED,
    termination: { graceMs },
  });
  const handle = await spawnWorker(contract, {
    policy,
    piBin: process.execPath,
    parentEnv: process.env,
    spawnFn: ((bin: string, args: readonly string[], opts: Record<string, unknown>) =>
      spawnReal(bin, [FAKE_PI, ...args], opts)) as never,
  });
  live.push(handle);
  await handle.call({ type: "get_state" }, 15_000);
  return handle;
}

/** Ask the fake worker for a detached grandchild, as Pi's bash tool creates. */
async function spawnGrandchild(handle: WorkerHandle): Promise<number> {
  const response = await handle.call({ type: "spawn_child" }, 15_000);
  const pid = (response.data as { pid: number }).pid;
  await waitUntil(() => realProcessOps.alive(pid), 2_000);
  return pid;
}

afterEach(async () => {
  for (const handle of live.splice(0)) {
    if (handle.exit === undefined) await handle.cancel("cleanup");
  }
});

describe.runIf(POSIX)("cancellation terminates the whole process tree", () => {
  it("tier 1 (cooperative): abort ends the worker and its children", async () => {
    const handle = await start();
    const child = await spawnGrandchild(handle);
    const result = await handle.cancel("done");
    expect(result.tier).toBe("cooperative");
    expect(handle.exit?.code).toBe(0);
    expect(await waitUntil(() => !realProcessOps.alive(child), 2_000)).toBe(true);
    expect(result.survivors).toEqual([]);
  });

  it("tier 2 (graceful): a worker ignoring abort is SIGTERMed and reaps its children", async () => {
    const handle = await start(700);
    await handle.call({ type: "ignore_abort" }, 15_000);
    const child = await spawnGrandchild(handle);
    const result = await handle.cancel("budget exceeded");
    expect(result.tier).toBe("graceful");
    expect(handle.exit?.code).toBe(143);
    expect(await waitUntil(() => !realProcessOps.alive(child), 2_000)).toBe(true);
    expect(result.survivors).toEqual([]);
  });

  it("tier 3 (hard): SIGKILL orphans the child, and the snapshot sweep still reaps it", async () => {
    const handle = await start(500);
    await handle.call({ type: "ignore_abort" }, 15_000);
    await handle.call({ type: "ignore_sigterm" }, 15_000);
    const child = await spawnGrandchild(handle);
    // The worker cannot clean up after SIGKILL; only the pre-kill snapshot
    // knows this pid exists (ADR 0004: it reparents to PID 1).
    const result = await handle.cancel("hung");
    expect(result.tier).toBe("hard");
    expect(result.snapshot.pids).toContain(child);
    expect(await waitUntil(() => !realProcessOps.alive(child), 2_000)).toBe(true);
    expect(result.survivors).toEqual([]);
  }, 20_000);

  it("snapshots descendants BEFORE signalling, which is the only way tier 3 can work", async () => {
    const handle = await start(500);
    const child = await spawnGrandchild(handle);
    const before = snapshotTree(handle.pid, realProcessOps);
    expect(before.pids).toContain(child);
    // After the worker dies the parent link is gone: a snapshot taken then
    // would be empty, and the orphan would survive forever.
    process.kill(handle.pid, "SIGKILL");
    await handle.waitForExit(3_000);
    const after = snapshotTree(handle.pid, realProcessOps);
    expect(after.pids).not.toContain(child);
    expect(realProcessOps.alive(child)).toBe(true);
    const sweep = await sweepSnapshot(before, 3_000, realProcessOps);
    expect(sweep.signalled).toContain(child);
    expect(sweep.survivors).toEqual([]);
  }, 20_000);

  it("cancelling an already-exited worker is safe and still sweeps", async () => {
    const handle = await start();
    await handle.cancel("first");
    const second = await handle.cancel("second");
    expect(second.survivors).toEqual([]);
  });

  it("does not report an intentional cancellation as a crash", async () => {
    const handle = await start(700);
    await handle.call({ type: "ignore_abort" }, 15_000);
    await handle.cancel("cancelled by user");
    expect(handle.exit?.crashed).toBe(false);
  });
});

describe("descendant enumeration", () => {
  it("walks the tree transitively and ignores unrelated processes", () => {
    const table = new Map<number, number>([
      [100, 1],
      [200, 100],
      [300, 200],
      [400, 999],
    ]);
    expect([...descendantsOf(100, table)].sort()).toEqual([200, 300]);
  });

  it("terminates on a cyclic table rather than looping forever", () => {
    const table = new Map<number, number>([
      [10, 20],
      [20, 10],
    ]);
    expect([...descendantsOf(10, table)]).toEqual([20]);
  });
});
