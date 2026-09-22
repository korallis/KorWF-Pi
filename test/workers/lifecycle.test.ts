/**
 * Issue #71 acceptance criteria, exercised against **real subprocesses** and
 * the real SQLite ledger:
 *
 * - "Cancel leaves no processes in the worker's group (pgrep test)."
 * - "Elapsed limit terminates a sleeping worker and records `outcome: timeout`."
 * - "Usage settles against the ledger within the reservation."
 *
 * Mocking the killer or the store would pass even with the defects these
 * exist to prevent, so neither is mocked. POSIX-only assertions are skipped
 * on Windows, which has no process groups and uses `taskkill /T /F`.
 */
import { execFileSync, spawn as spawnReal } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { draftToContract, type ContractPolicy } from "../../src/workers/contract.ts";
import { spawnWorker, type WorkerHandle } from "../../src/workers/spawn.ts";
import { WorkerRegistry, WorkerRun } from "../../src/workers/lifecycle.ts";
import { realProcessOps, waitUntil } from "../../src/workers/process-tree.ts";
import { makeRoute } from "../../src/models/route.ts";
import { routeLabel } from "../../src/telemetry/usage.ts";
import { budgetsWith, makeLedgerFixture, type LedgerFixture } from "../helpers/ledger.ts";
import type { ModelAllowlist, ModelRef } from "../../src/config/types.ts";
import type { AttemptId, WorkflowId, TaskId, PhaseId } from "../../src/storage/records.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const ALLOWED: ModelRef = "provider-a/model-one";
const allowlist: ModelAllowlist = { providers: [], models: [ALLOWED], pins: {} };
const policy: ContractPolicy = { allowlist };
const POSIX = process.platform !== "win32";

const route = makeRoute("provider-a", "model-one");
const scope = {
  workflowId: "wf-1" as WorkflowId,
  phaseId: "ph-1" as PhaseId,
  taskId: "tk-1" as TaskId,
  attemptId: "at-1" as AttemptId,
};

const live: WorkerHandle[] = [];
const fixtures: LedgerFixture[] = [];

function newFixture(): LedgerFixture {
  const fixture = makeLedgerFixture({ budgets: budgetsWith({}), prefix: "korwf-lifecycle-" });
  fixtures.push(fixture);
  return fixture;
}

async function startHandle(options: { wallClockMs?: number; graceMs?: number; artifacts?: readonly string[]; cwd?: string } = {}): Promise<WorkerHandle> {
  const contract = draftToContract({
    workerId: `w-${live.length + 1}`,
    role: "scout",
    task: "wait",
    cwd: options.cwd ?? process.cwd(),
    model: ALLOWED,
    budget: { wallClockMs: options.wallClockMs ?? 60_000 },
    termination: { graceMs: options.graceMs ?? 1_500, artifacts: options.artifacts ?? [] },
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

afterEach(async () => {
  for (const handle of live.splice(0)) {
    if (handle.exit === undefined) await handle.cancel("cleanup");
  }
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/** pgrep-style check: does any process still name this pid as its group? */
function pidsInGroup(pgid: number): readonly number[] {
  try {
    const out = execFileSync("ps", ["-eo", "pid=,pgid="], { encoding: "utf8" });
    return out
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((pair) => pair[1] === pgid && pair[0] !== undefined && pair[0]! > 0)
      .map((pair) => pair[0]!);
  } catch {
    return [];
  }
}

describe.runIf(POSIX)("AC 1: cancel leaves no processes in the worker's group", () => {
  it("leaves the worker's process group empty after a cooperative cancel", async () => {
    const fixture = newFixture();
    const handle = await startHandle();
    const run = new WorkerRun({ handle, ledger: fixture.ledger, scope, route });
    run.start();
    const pgid = handle.pid; // detached: the worker is its own group leader
    expect(pidsInGroup(pgid)).toContain(handle.pid);
    const result = await run.cancel("done");
    expect(result.survivors).toEqual([]);
    expect(await waitUntil(() => pidsInGroup(pgid).length === 0, 3_000)).toBe(true);
    expect(pidsInGroup(pgid)).toEqual([]);
  }, 20_000);

  it("reaps a detached grandchild that SIGKILL orphaned, via the pre-kill snapshot", async () => {
    const fixture = newFixture();
    const handle = await startHandle({ graceMs: 500 });
    const run = new WorkerRun({ handle, ledger: fixture.ledger, scope, route });
    run.start();
    await handle.call({ type: "ignore_abort" }, 15_000);
    await handle.call({ type: "ignore_sigterm" }, 15_000);
    const child = (await handle.call({ type: "spawn_child" }, 15_000)).data as { pid: number };
    expect(await waitUntil(() => realProcessOps.alive(child.pid), 2_000)).toBe(true);

    const result = await run.cancel("hung");
    expect(result.tier).toBe("hard");
    expect(result.snapshot.pids).toContain(child.pid);
    expect(result.survivors).toEqual([]);
    expect(realProcessOps.alive(child.pid)).toBe(false);
    expect(realProcessOps.alive(handle.pid)).toBe(false);
  }, 25_000);
});

describe.runIf(POSIX)("AC 2: the elapsed limit terminates a sleeping worker and records outcome: timeout", () => {
  it("kills a worker that reports nothing and never exits, and reports timeout", async () => {
    const fixture = newFixture();
    // The worker is told to ignore abort and SIGTERM: it is 'asleep' in the
    // sense that matters — it emits no events, so nothing but the wall-clock
    // timer can end it.
    const handle = await startHandle({ wallClockMs: 250, graceMs: 400 });
    await handle.call({ type: "ignore_abort" }, 15_000);
    const run = new WorkerRun({ handle, ledger: fixture.ledger, scope, route });
    run.start();

    const result = await run.wait(15_000);
    expect(result.outcome).toBe("timeout");
    expect(result.attemptOutcome).toBe("failed");
    expect(result.breach?.kind).toBe("elapsed");
    expect(result.termination.failureKind).toBe("timeout");
    // A harness failure never consumes the task's attempt budget (#124).
    expect(result.termination.consumedAttemptBudget).toBe(false);
    expect(handle.exit).toBeDefined();
    expect(result.progress.events.some((e) => e.kind === "limit_breached")).toBe(true);
  }, 25_000);

  it("does not charge paused wall clock against the elapsed limit", async () => {
    const fixture = newFixture();
    const handle = await startHandle({ wallClockMs: 60_000 });
    const run = new WorkerRun({ handle, ledger: fixture.ledger, scope, route });
    run.start();
    expect(run.pause("under test")).toBe(true);
    expect(run.state).toBe("paused");
    const while_paused = run.elapsedMs;
    await new Promise((r) => setTimeout(r, 150));
    expect(run.elapsedMs).toBe(while_paused);
    expect(run.resume()).toBe(true);
    expect(run.state).toBe("running");
    const result = await run.cancel("done");
    expect(result.survivors).toEqual([]);
  }, 20_000);

  it("cancels a paused worker: SIGCONT first, so tier 2 is not skipped by a stopped process", async () => {
    const fixture = newFixture();
    const handle = await startHandle({ graceMs: 1_500 });
    const run = new WorkerRun({ handle, ledger: fixture.ledger, scope, route });
    run.start();
    run.pause();
    const result = await run.cancel("cancelled while paused");
    expect(result.tier).toBe("cooperative");
    expect(result.survivors).toEqual([]);
    expect(run.finish().outcome).toBe("cancelled");
  }, 20_000);
});

describe.runIf(POSIX)("AC 3: usage settles against the ledger within the reservation", () => {
  it("writes a reservation on start and a settlement on finish, labelled with the route", async () => {
    const fixture = newFixture();
    const handle = await startHandle();
    const run = new WorkerRun({ handle, ledger: fixture.ledger, scope, route });
    run.start();
    const reservation = run.reservation;
    expect(reservation).not.toBeNull();

    // The fake worker answers a prompt with a usage payload.
    handle.prompt("do the thing");
    await handle.expect((m) => m.type === "response" && m.command === "prompt", 15_000);

    await run.cancel("done");
    const result = run.finish();

    const rows = fixture.store.ledger.forReservation(reservation!.id);
    expect(rows.map((r) => r.entryKind)).toEqual(["reservation", "settlement"]);
    const settlement = rows[1]!;
    expect(settlement.label ?? rows[0]!.label).toBe(routeLabel(route.routeId));
    expect(settlement.usage.inputTokens).toBe(result.usage.inputTokens);
    expect(settlement.usage.outputTokens).toBe(result.usage.outputTokens);
    // fake-pi reports costUsd: 0 with no price metadata → unknown, not $0.00.
    expect(settlement.usage.spendUsd).toBeNull();
    expect(settlement.usage.costBasis).toBe("unknown");
  }, 20_000);

  it("settles exactly once even if finish() is called twice", async () => {
    const fixture = newFixture();
    const handle = await startHandle();
    const run = new WorkerRun({ handle, ledger: fixture.ledger, scope, route });
    run.start();
    await run.cancel("done");
    const first = run.finish();
    const second = run.finish();
    expect(second).toBe(first);
    expect(fixture.store.ledger.forReservation(run.reservation!.id)).toHaveLength(2);
  }, 20_000);

  it("refuses to start when the ledger's atomic reservation says the cap is spent", async () => {
    const fixture = makeLedgerFixture({ budgets: budgetsWith({ task: { maxConcurrency: 1 } }), prefix: "korwf-cap-" });
    fixtures.push(fixture);
    const first = await startHandle();
    const firstRun = new WorkerRun({ handle: first, ledger: fixture.ledger, scope, route });
    firstRun.start();

    const second = await startHandle();
    const secondRun = new WorkerRun({ handle: second, ledger: fixture.ledger, scope, route });
    // Global concurrency is the ledger's cap, enforced inside BEGIN IMMEDIATE
    // — not an in-process counter here.
    expect(() => secondRun.start()).toThrow(/KORWF_BUDGET_EXCEEDED|Budget cap/);
    await firstRun.cancel("done");
    await secondRun.cancel("never started").catch(() => undefined);
  }, 25_000);
});

describe.runIf(POSIX)("artifacts declared by the contract are captured into the #23 store", () => {
  it("captures a produced artifact and reports a declared one that is missing", async () => {
    const fixture = newFixture();
    // realpathSync on both sides: macOS symlinks /tmp and a raw string
    // compare passes on Linux and fails there (#70).
    const cwd = realpathSync(fixture.dir.path);
    execFileSync("sh", ["-c", `printf 'report body' > '${cwd}/out.txt'`]);
    const handle = await startHandle({ cwd, artifacts: ["out.txt", "never-written.txt"] });
    const run = new WorkerRun({
      handle,
      ledger: fixture.ledger,
      scope,
      route,
      artifacts: fixture.store.artifacts,
      attemptId: "at-1" as AttemptId,
    });
    run.start();
    await run.cancel("done");
    const result = run.finish();

    const produced = result.artifacts.find((a) => a.declaredPath === "out.txt");
    expect(produced?.missing).toBe(false);
    expect(produced?.ref?.relativePath).toBe("at-1/out.txt");
    expect(fixture.store.artifacts.read("at-1", "out.txt").toString()).toBe("report body");
    expect(fixture.store.artifacts.verify("at-1", "out.txt")).toBe(true);

    const missing = result.artifacts.find((a) => a.declaredPath === "never-written.txt");
    expect(missing?.missing).toBe(true);
    expect(missing?.ref).toBeNull();
  }, 20_000);

  it("refuses to capture an artifact path that escapes the worktree", async () => {
    const fixture = newFixture();
    const cwd = realpathSync(fixture.dir.path);
    const handle = await startHandle({ cwd, artifacts: ["../escape.txt"] });
    const run = new WorkerRun({
      handle,
      ledger: fixture.ledger,
      scope,
      route,
      artifacts: fixture.store.artifacts,
      attemptId: "at-1" as AttemptId,
    });
    run.start();
    await run.cancel("done");
    const captured = run.finish().artifacts[0];
    expect(captured?.ref).toBeNull();
    expect(captured?.reason).toMatch(/escapes the worker's worktree/);
  }, 20_000);
});

describe.runIf(POSIX)("the registry addresses live runs by worker id", () => {
  it("lists active runs and cancels them all", async () => {
    const fixture = newFixture();
    const registry = new WorkerRegistry();
    for (let i = 0; i < 2; i += 1) {
      const handle = await startHandle();
      const run = new WorkerRun({ handle, ledger: fixture.ledger, scope, route });
      run.start();
      registry.register(run);
    }
    expect(registry.active()).toHaveLength(2);
    const results = await registry.cancelAll("shutdown");
    expect(results.every((r) => r.survivors.length === 0)).toBe(true);
    for (const run of registry.list()) run.finish();
    expect(registry.active()).toHaveLength(0);
  }, 30_000);
});
