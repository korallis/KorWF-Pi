/**
 * Issue #71 — `/korwf pause|resume|cancel`.
 *
 * The commands are pure over the registry, so they are tested with a stub
 * run rather than a subprocess; the process-level guarantees are covered by
 * test/workers/lifecycle.test.ts. What matters here is that a refusal is
 * *stated* (never silently reported as success) and that a cancellation
 * which left survivors says so.
 */
import { describe, expect, it } from "vitest";
import { parseWorkerCommandArgs, pauseMessage } from "../../src/extension/commands/pause.ts";
import { resumeMessage } from "../../src/extension/commands/resume.ts";
import { cancelMessage } from "../../src/extension/commands/cancel.ts";
import { WorkerRegistry, type WorkerRun } from "../../src/workers/lifecycle.ts";
import type { CancelResult } from "../../src/workers/spawn.ts";
import type { Usage } from "../../src/storage/records.ts";

interface StubOptions {
  readonly workerId: string;
  readonly state?: WorkerRun["state"];
  readonly survivors?: readonly number[];
  readonly usage?: Usage;
}

const UNKNOWN: Usage = { inputTokens: 5, outputTokens: 5, requests: 1, spendUsd: null, costBasis: "unknown" };

/** Minimal stand-in for a live run: only what the commands actually touch. */
function stubRun(options: StubOptions): WorkerRun {
  let state: WorkerRun["state"] = options.state ?? "running";
  const cancellation: CancelResult = {
    tier: "cooperative",
    snapshot: { rootPid: 1, pids: [2, 3], takenAt: 0 },
    survivors: options.survivors ?? [],
  };
  return {
    handle: { contract: { workerId: options.workerId } },
    get state() {
      return state;
    },
    pause(): boolean {
      if (state !== "running") return false;
      state = "paused";
      return true;
    },
    resume(): boolean {
      if (state !== "paused") return false;
      state = "running";
      return true;
    },
    cancel(): Promise<CancelResult> {
      state = "stopping";
      return Promise.resolve(cancellation);
    },
    finish(): { usage: Usage } {
      state = "finished";
      return { usage: options.usage ?? UNKNOWN };
    },
  } as unknown as WorkerRun;
}

function registryWith(...runs: readonly WorkerRun[]): WorkerRegistry {
  const registry = new WorkerRegistry();
  for (const run of runs) registry.register(run);
  return registry;
}

describe("argument parsing", () => {
  it("reads a worker id, --all and --reason", () => {
    expect(parseWorkerCommandArgs(["w-1"])).toEqual({ workerId: "w-1", all: false, reason: null });
    expect(parseWorkerCommandArgs(["--all"])).toEqual({ workerId: null, all: true, reason: null });
    expect(parseWorkerCommandArgs(["w-1", "--reason", "cap", "hit"])).toEqual({
      workerId: "w-1",
      all: false,
      reason: "cap hit",
    });
    expect(parseWorkerCommandArgs([])).toEqual({ workerId: null, all: false, reason: null });
  });
});

describe("AC: /korwf pause and /korwf resume", () => {
  it("pauses the single active worker when none is named", () => {
    const registry = registryWith(stubRun({ workerId: "w-1" }));
    const result = pauseMessage(registry, parseWorkerCommandArgs([]));
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Paused: w-1");
    expect(registry.get("w-1")?.state).toBe("paused");
  });

  it("refuses to guess when several workers are active", () => {
    const registry = registryWith(stubRun({ workerId: "w-1" }), stubRun({ workerId: "w-2" }));
    const result = pauseMessage(registry, parseWorkerCommandArgs([]));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("name one or pass --all");
  });

  it("pauses every active worker with --all", () => {
    const registry = registryWith(stubRun({ workerId: "w-1" }), stubRun({ workerId: "w-2" }));
    const result = pauseMessage(registry, parseWorkerCommandArgs(["--all"]));
    expect(result.ok).toBe(true);
    expect(result.message).toContain("w-1, w-2");
  });

  it("reports an unknown worker id rather than succeeding silently", () => {
    const result = pauseMessage(registryWith(), parseWorkerCommandArgs(["nope"]));
    expect(result.ok).toBe(false);
    expect(result.message).toBe("No worker 'nope'.");
  });

  it("states that an already-paused worker was not pausable", () => {
    const registry = registryWith(stubRun({ workerId: "w-1", state: "paused" }));
    const result = pauseMessage(registry, parseWorkerCommandArgs(["w-1"]));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Not pausable: w-1 (paused)");
  });

  it("resumes a paused worker and refuses a running one", () => {
    const registry = registryWith(stubRun({ workerId: "w-1", state: "paused" }));
    expect(resumeMessage(registry, parseWorkerCommandArgs(["w-1"])).ok).toBe(true);
    const second = resumeMessage(registry, parseWorkerCommandArgs(["w-1"]));
    expect(second.ok).toBe(false);
    expect(second.message).toContain("Not paused: w-1 (running)");
  });
});

describe("AC: /korwf cancel reports the tier, the sweep and any survivors", () => {
  it("reports a clean cancellation and drops the run from the registry", async () => {
    const registry = registryWith(stubRun({ workerId: "w-1" }));
    const result = await cancelMessage(registry, parseWorkerCommandArgs(["w-1"]));
    expect(result.ok).toBe(true);
    expect(result.message).toContain("cancelled at the cooperative tier");
    expect(result.message).toContain("2 descendant processes swept, 0 surviving");
    expect(registry.get("w-1")).toBeUndefined();
  });

  it("WARNS rather than reassures when the sweep left a process behind", async () => {
    const registry = registryWith(stubRun({ workerId: "w-1", survivors: [4242] }));
    const result = await cancelMessage(registry, parseWorkerCommandArgs(["w-1"]));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("WARNING: 1 process(es) survived the sweep");
  });

  it("never prints $0.00 for a cost nothing stated (#56)", async () => {
    const registry = registryWith(stubRun({ workerId: "w-1" }));
    const result = await cancelMessage(registry, parseWorkerCommandArgs(["w-1"]));
    expect(result.message).toContain("cost unknown");
    expect(result.message).not.toContain("$0.00");
  });

  it("prints a stated cost with its basis", async () => {
    const priced: Usage = { inputTokens: 1, outputTokens: 1, requests: 2, spendUsd: 0.125, costBasis: "known" };
    const registry = registryWith(stubRun({ workerId: "w-1", usage: priced }));
    const result = await cancelMessage(registry, parseWorkerCommandArgs(["w-1"]));
    expect(result.message).toContain("2 request(s), $0.1250 (known)");
  });

  it("says so when there is nothing to cancel", async () => {
    const result = await cancelMessage(new WorkerRegistry(), parseWorkerCommandArgs(["--all"]));
    expect(result.ok).toBe(false);
    expect(result.message).toBe("No active workers.");
  });
});
