/**
 * `/korwf plan <goal>` (issue #33).
 *
 * Exercises the full intake path — flag parsing, greenfield vs existing-repo
 * detection, clarification, and persistence — with a real store in a temp
 * dir and an injected fake git runner so no process is spawned.
 */
import { describe, it, expect, afterEach } from "vitest";
import { runPlanIntake } from "../../../src/extension/commands/plan.ts";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { loadConfig } from "../../../src/config/load.ts";
import type { GitRunner } from "../../../src/git/status.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";

const open: { dir: TempDir; store: Store }[] = [];

function freshProject(): TempDir {
  const dir = makeTempDir("korwf-plan-cmd-");
  return dir;
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

const greenfieldRunner: GitRunner = {
  run() {
    throw new Error("not a git repo");
  },
};

function existingRunner(sha: string): GitRunner {
  return {
    run(args) {
      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return "/repo";
      if (args[0] === "rev-parse" && args.includes("HEAD")) return sha;
      if (args[0] === "remote") throw new Error("no remote");
      if (args[0] === "status") return "";
      throw new Error(`unexpected: ${args.join(" ")}`);
    },
  };
}

describe("AC1: existing-repo `/korwf plan` creates a Workflow with the correct base revision", () => {
  it("persists a Workflow with status planning and the detected SHA", async () => {
    const dir = freshProject();
    open.push({ dir, store: undefined as unknown as Store });
    open.pop();
    const sha = "c".repeat(40);
    const result = await runPlanIntake(
      "Add a GET /orders/:id/summary endpoint returning item count and total",
      { cwd: dir.path, ui: { input: async () => null, hasUI: false }, sessionId: "sess-1" },
      {
        gitRunner: existingRunner(sha),
        loadConfig: () => loadConfig(dir.path, { env: {} }),
        now: () => "2026-01-01T00:00:00.000Z",
        newId: () => "wf-test-1",
      },
    );
    expect(result.ok).toBe(true);
    const readOnly = openStore({ storageRoot: `${dir.path}/.korwf`, writable: false });
    open.push({ dir, store: readOnly.store });
    const readBack = readOnly.store.workflows.get("wf-test-1");
    expect(readBack?.baseRevision).toBe(sha);
    expect(readBack?.status).toBe("planning");
    expect(readBack?.repoIdentity.rootCommit).toBe(sha);
  });
});

describe("AC2: an empty directory creates a Workflow flagged greenfield", () => {
  it("uses the zero-SHA base revision and no remote", async () => {
    const dir = freshProject();
    open.push({ dir, store: undefined as unknown as Store });
    open.pop();
    const result = await runPlanIntake(
      "Build a CLI for managing recipes and shopping lists",
      { cwd: dir.path, ui: { input: async () => null, hasUI: false }, sessionId: "sess-1" },
      {
        gitRunner: greenfieldRunner,
        loadConfig: () => loadConfig(dir.path, { env: {} }),
        now: () => "2026-01-01T00:00:00.000Z",
        newId: () => "wf-test-2",
      },
    );
    expect(result.ok).toBe(true);
    const readOnly = openStore({ storageRoot: `${dir.path}/.korwf`, writable: false });
    open.push({ dir, store: readOnly.store });
    const readBack = readOnly.store.workflows.get("wf-test-2");
    expect(readBack?.repoIdentity.rootCommit).toBe("0".repeat(40));
    expect(readBack?.repoIdentity.remoteUrl).toBeNull();
    expect(result.message).toContain("greenfield");
  });
});

describe("AC3: explicit exclusions from flags appear verbatim on the Workflow record", () => {
  it("round-trips --exclude globs through the store", async () => {
    const dir = freshProject();
    open.push({ dir, store: undefined as unknown as Store });
    open.pop();
    const result = await runPlanIntake(
      "--exclude vendor/** Build a CLI tool --exclude dist/**",
      { cwd: dir.path, ui: { input: async () => null, hasUI: false }, sessionId: "sess-1" },
      {
        gitRunner: greenfieldRunner,
        loadConfig: () => loadConfig(dir.path, { env: {} }),
        now: () => "2026-01-01T00:00:00.000Z",
        newId: () => "wf-test-3",
      },
    );
    expect(result.ok).toBe(true);
    const readOnly = openStore({ storageRoot: `${dir.path}/.korwf`, writable: false });
    open.push({ dir, store: readOnly.store });
    const readBack = readOnly.store.workflows.get("wf-test-3");
    expect(readBack?.exclusions).toEqual(["vendor/**", "dist/**"]);
  });
});

describe("AC4: non-interactive mode skips clarification without hanging", () => {
  it("never calls ui.input when hasUI is false, even on a short/underspecified goal", async () => {
    const dir = freshProject();
    let inputCalled = false;
    const result = await runPlanIntake(
      "fix bug",
      {
        cwd: dir.path,
        ui: {
          input: async () => {
            inputCalled = true;
            return "should not run";
          },
          hasUI: false,
        },
        sessionId: "sess-1",
      },
      {
        gitRunner: greenfieldRunner,
        loadConfig: () => loadConfig(dir.path, { env: {} }),
        now: () => "2026-01-01T00:00:00.000Z",
        newId: () => "wf-test-4",
        openStore: (opts) => {
          const opened = openStore(opts);
          open.push({ dir, store: opened.store });
          return opened;
        },
      },
    );
    expect(inputCalled).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("skipped (non-interactive session)");
  });
});

describe("Rejects an empty goal before touching the store", () => {
  it("returns a usage message and does not create a Workflow", async () => {
    const dir = freshProject();
    open.push({ dir, store: undefined as unknown as Store });
    open.pop();
    const result = await runPlanIntake(
      "--mode supervised",
      { cwd: dir.path, ui: { input: async () => null, hasUI: false }, sessionId: "sess-1" },
      { gitRunner: greenfieldRunner, loadConfig: () => loadConfig(dir.path, { env: {} }) },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Usage:");
    dir.cleanup();
  });
});
