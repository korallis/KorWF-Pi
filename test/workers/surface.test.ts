/**
 * ADR 0004 "Worker visibility in Herdr": a headless worker is invisible to the
 * host's agent panel, so it is surfaced in its **own worktree Space** — never
 * by splitting the user's pane — and the surface is best-effort: if the host
 * is absent the worker still runs.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { closeSurface, surfaceWorktree, type HostRunner } from "../../src/workers/surface.ts";
import { draftToContract, type ContractPolicy } from "../../src/workers/contract.ts";
import { spawnWorker } from "../../src/workers/spawn.ts";
import type { ModelAllowlist, ModelRef } from "../../src/config/types.ts";

const ALLOWED: ModelRef = "provider-a/model-one";
const allowlist: ModelAllowlist = { providers: [], models: [ALLOWED], pins: {} };
const policy: ContractPolicy = { allowlist };

function recordingRunner(result: { code: number; stdout: string }): {
  run: HostRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push([...args]);
      return result;
    },
  };
}

describe("worker visibility surface", () => {
  it("opens the worker's own worktree as a Space", async () => {
    const { run, calls } = recordingRunner({ code: 0, stdout: "opened" });
    const result = await surfaceWorktree({ worktree: "/tmp/worktree-a", run });
    expect(result.opened).toBe(true);
    expect(calls).toEqual([["worktree", "open", "--path", "/tmp/worktree-a"]]);
  });

  it("never issues a pane split, whatever it is asked for", async () => {
    const { run, calls } = recordingRunner({ code: 0, stdout: "" });
    await surfaceWorktree({ worktree: "/tmp/worktree-a", run });
    for (const call of calls) {
      expect(call).not.toContain("pane");
      expect(call).not.toContain("--current");
    }
  });

  it("degrades to 'not opened' when the host is absent, and never throws", async () => {
    const throwing: HostRunner = async () => {
      throw new Error("herdr: command not found");
    };
    const result = await surfaceWorktree({ worktree: "/tmp/worktree-a", run: throwing });
    expect(result.opened).toBe(false);
    expect(result.reason).toContain("command not found");
  });

  it("reports a non-zero host exit without failing", async () => {
    const { run } = recordingRunner({ code: 3, stdout: "" });
    const result = await surfaceWorktree({ worktree: "/tmp/worktree-a", run });
    expect(result).toEqual({ opened: false, alreadyOpen: false, reason: "host exited 3" });
  });

  it("refuses a relative worktree path", async () => {
    const { run, calls } = recordingRunner({ code: 0, stdout: "" });
    const result = await surfaceWorktree({ worktree: "relative/dir", run });
    expect(result.opened).toBe(false);
    expect(calls).toEqual([]);
  });

  it("closes only a Space it created, never a pre-existing one", async () => {
    const { run, calls } = recordingRunner({ code: 0, stdout: "" });
    const preExisting = { opened: true, alreadyOpen: true, reason: null };
    await closeSurface({ worktree: "/tmp/worktree-a", openedResult: preExisting, run });
    expect(calls).toEqual([]);

    const ours = { opened: true, alreadyOpen: false, reason: null };
    await closeSurface({ worktree: "/tmp/worktree-a", openedResult: ours, run });
    expect(calls).toEqual([["workspace", "close", "--path", "/tmp/worktree-a"]]);
  });

  it("never closes a tab: no code path in src/workers/ mentions one", () => {
    const root = fileURLToPath(new URL("../../src/workers/", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    for (const file of files) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const code = line.replace(/^\s*(\/\/|\*|#).*$/, "");
        expect(code, `${file}: ${line}`).not.toMatch(/tab["'\s,\]]+.{0,20}["']close["']/);
      }
    }
  });

  it("does not fail the worker when the surface throws (spawn still returns a handle)", async () => {
    const contract = draftToContract({
      workerId: "s1",
      role: "scout",
      task: "t",
      cwd: process.cwd(),
      model: ALLOWED,
    });
    let spawned = 0;
    const handle = await spawnWorker(contract, {
      policy,
      parentEnv: {},
      surface: () => {
        throw new Error("host unavailable");
      },
      spawnFn: (() => {
        spawned += 1;
        return {
          pid: 4242,
          stdout: null,
          stdin: { write: () => true },
          on: () => undefined,
        };
      }) as never,
    });
    expect(spawned).toBe(1);
    expect(handle.pid).toBe(4242);
  });
});
