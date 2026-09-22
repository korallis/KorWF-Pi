/**
 * #68 AC2: "Worker attempting `/korwf run` is refused."
 *
 * ADR 0004 makes recursion prevention a three-guard property, and each guard
 * is checked here independently, because the whole point is that no single
 * one of them is load-bearing:
 *
 *   1. `--no-extensions` — the orchestration extension is never loaded;
 *   2. `KORWF_WORKER_DEPTH` — if it were loaded, it registers no spawn surface;
 *   3. the per-role `--tools` allowlist — if it registered one, the tool is
 *      filtered out of the worker's active set.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAvailability, runRefusalMessage } from "../../src/extension/commands/run.ts";
import { buildWorkerArgv } from "../../src/workers/spawn.ts";
import { draftToContract } from "../../src/workers/contract.ts";
import { buildWorkerEnv, DEPTH_ENV_VAR } from "../../src/workers/env.ts";
import { ROLE_IDS, SPAWN_TOOL_NAMES, roleTools } from "../../src/workers/roles.ts";
import type { ModelRef } from "../../src/config/types.ts";

const ALLOWED: ModelRef = "provider-a/model-one";

function contract(overrides: Record<string, unknown> = {}) {
  return draftToContract({
    workerId: "r1",
    role: "implementer",
    task: "t",
    cwd: "/tmp/w",
    model: ALLOWED,
    ...overrides,
  });
}

describe("AC2: guard 2 — /korwf run is refused inside a worker", () => {
  it("is available in an orchestrator (no depth marker)", () => {
    const availability = runAvailability({});
    expect(availability.available).toBe(true);
    expect(availability.depth).toBe(0);
  });

  it("is refused at the default maxDepth of 1, with an explanation", () => {
    const availability = runAvailability({ [DEPTH_ENV_VAR]: "1" });
    expect(availability.available).toBe(false);
    expect(runRefusalMessage(availability)).toContain("not available inside a worker");
    expect(runRefusalMessage(availability)).toContain("workers may not spawn workers");
  });

  it("is refused for the environment a real worker is actually given", () => {
    const worker = contract();
    const env = buildWorkerEnv({
      parentEnv: {},
      workerId: worker.workerId,
      role: worker.role,
      depth: worker.depth,
    });
    expect(runAvailability(env).available).toBe(false);
  });

  it("becomes available only when maxDepth is explicitly raised", () => {
    expect(runAvailability({ [DEPTH_ENV_VAR]: "1" }, 2).available).toBe(true);
    expect(runAvailability({ [DEPTH_ENV_VAR]: "2" }, 2).available).toBe(false);
  });

  it("refuses when the marker is corrupted, rather than treating it as absent", () => {
    expect(runAvailability({ [DEPTH_ENV_VAR]: "banana" }).available).toBe(false);
  });

  it("keeps the depth check wired into the extension entry point", () => {
    // ADR 0004 follow-up: "a test that fails if KORWF_WORKER_DEPTH handling is
    // removed from the extension".
    const source = readFileSync(
      fileURLToPath(new URL("../../src/extension/index.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("runAvailability");
    expect(source).toContain("ACTIVE_SUBCOMMANDS");
    expect(source).toContain("RUN_AVAILABILITY.available");
  });

  it("withholds the whole worker-control surface inside a worker, not just `run` (#71)", () => {
    // pause/resume/cancel supervise workers. A worker that can pause or
    // cancel workers is a worker that supervises them, so guard 2 must cover
    // all four, not only the spawn verb.
    const source = readFileSync(
      fileURLToPath(new URL("../../src/extension/index.ts", import.meta.url)),
      "utf8",
    );
    const surface = /const WORKER_SURFACE: readonly Subcommand\[\] = \[([^\]]*)\]/.exec(source);
    expect(surface).not.toBeNull();
    for (const sub of ["run", "pause", "resume", "cancel"]) {
      expect(surface?.[1]).toContain(`"${sub}"`);
    }
    expect(source).toContain("!WORKER_SURFACE.includes(s) || RUN_AVAILABILITY.available");
  });
});

describe("AC2: guard 1 — the orchestration extension is never loaded in a worker", () => {
  it("passes --no-extensions on every launch", () => {
    for (const role of ROLE_IDS) {
      expect(buildWorkerArgv(contract({ role }))).toContain("--no-extensions");
    }
  });

  it("passes --no-extensions even with explicitly permitted role extensions", () => {
    const argv = buildWorkerArgv(contract({ inheritance: { extensions: ["/x/role.ts"] } }));
    expect(argv).toContain("--no-extensions");
  });

  it("isolates the other discovered resources too", () => {
    const argv = buildWorkerArgv(contract());
    expect(argv).toContain("--no-skills");
    expect(argv).toContain("--no-prompt-templates");
    expect(argv).toContain("--no-context-files");
  });
});

describe("AC2: guard 3 — no role's tool allowlist contains a spawn tool", () => {
  it("holds for every role", () => {
    for (const role of ROLE_IDS) {
      const tools = roleTools(role);
      for (const spawnTool of SPAWN_TOOL_NAMES) {
        expect(tools, `${role} lists ${spawnTool}`).not.toContain(spawnTool);
      }
    }
  });

  it("is what --tools actually carries to the process", () => {
    for (const role of ROLE_IDS) {
      const argv = buildWorkerArgv(contract({ role }));
      const list = argv[argv.indexOf("--tools") + 1]!.split(",");
      expect(list).toEqual([...roleTools(role)]);
      for (const spawnTool of SPAWN_TOOL_NAMES) expect(list).not.toContain(spawnTool);
    }
  });
});
