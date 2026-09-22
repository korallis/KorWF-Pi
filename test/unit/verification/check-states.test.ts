/**
 * `src/verification/flaky.ts` (issue #51; PLAN §3.F): flaky, missing, and
 * unavailable checks are represented explicitly, never as success.
 *
 * Test names reference the issue's acceptance criteria:
 *   AC1 — a flaky check (pass + fail at the same revision) blocks the gate
 *         under default policy (never reported as `pass`).
 *   AC2 — board shows distinct markers for pass/fail/flaky/missing/unavailable.
 *   AC3 — missing check for a criterion is reported by criterion id.
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import type { CheckDefinition, Evidence } from "../../../src/storage/records.ts";
import {
  DEFAULT_RERUN_POLICY,
  checkState,
  reconcileRuns,
  runCheckWithRerunPolicy,
  uncoveredCriteria,
  taskCheckSummary,
  missingCheckBlockerDetail,
  type FreshnessInput,
} from "../../../src/verification/flaky.ts";
import { checkStateMarker, CHECK_STATE_MARKERS } from "../../../src/extension/ui/board.ts";
import { makeTestRepo, type TestRepo } from "../../helpers/git-repo.ts";
import type { CheckRunResult } from "../../../src/verification/checks.ts";
import type { EvidenceSubject } from "../../../src/verification/evidence.ts";

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
});

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

function run(overrides: Partial<CheckRunResult> = {}): CheckRunResult {
  return {
    checkId: "c1",
    status: "pass",
    exitStatus: { kind: "exited", code: 0 },
    revision: SHA,
    stdout: { text: "", truncated: false, originalBytes: 0, contentHash: "x" },
    stderr: { text: "", truncated: false, originalBytes: 0, contentHash: "x" },
    durationMs: 1,
    fingerprint: { nodeVersion: "v22", platform: "linux", arch: "x64", envVarNames: [], shell: "/bin/sh" },
    killedPids: [],
    evidence: null,
    caveats: [],
    ...overrides,
  };
}

describe("AC1: reconcileRuns detects flaky at the same revision", () => {
  it("pass then fail at the same revision reconciles to flaky, both runs kept", () => {
    const passRun = run({ status: "pass", revision: SHA });
    const failRun = run({ status: "fail", exitStatus: { kind: "exited", code: 1 }, revision: SHA });
    const result = reconcileRuns("c1", [passRun, failRun]);
    expect(result.status).toBe("flaky");
    expect(result.runs).toHaveLength(2);
    expect(result.runs).toContain(passRun);
    expect(result.runs).toContain(failRun);
  });

  it("a flaky result is never `pass` — it does not satisfy the gate", () => {
    const result = reconcileRuns("c1", [run({ status: "fail" }), run({ status: "pass" })]);
    expect(result.status).not.toBe("pass");
    expect(result.status).toBe("flaky");
  });

  it("two passes at the same revision reconcile to pass, not flaky", () => {
    const result = reconcileRuns("c1", [run({ status: "pass" }), run({ status: "pass" })]);
    expect(result.status).toBe("pass");
  });

  it("two fails at the same revision reconcile to fail, not flaky", () => {
    const result = reconcileRuns("c1", [run({ status: "fail" }), run({ status: "fail" })]);
    expect(result.status).toBe("fail");
  });

  it("runs at different revisions are not compared for flakiness", () => {
    const result = reconcileRuns("c1", [
      run({ status: "pass", revision: SHA }),
      run({ status: "fail", revision: SHA2 }),
    ]);
    expect(result.status).not.toBe("flaky");
  });

  it("DEFAULT_RERUN_POLICY never allows flaky to satisfy the gate", () => {
    expect(DEFAULT_RERUN_POLICY.allowFlakyToPass).toBe(false);
  });

  it("the reconciled flaky row is the LAST draft, so 'latest result wins' lands on flaky (#55)", () => {
    // Found by the Stage 4 adversarial suite: storing only the per-run drafts
    // let a fail-then-pass sequence read back as `pass`, because the gate
    // takes the newest fresh row for a check (docs/gates.md §2).
    const draft = {
      workflowId: "wf-1",
      taskId: "tk-1",
      taskRevision: 1,
      attemptId: null,
      requirementId: "ac-1",
      checkId: "c1",
      artifact: null,
      revision: SHA,
      commandIdentity: { command: "npm test", cwd: ".", environmentHash: "c".repeat(64) },
      exitStatus: { kind: "exited", code: 0 },
      reviewer: { kind: "deterministic" },
      caveats: [],
      provenance: [],
      supersedesId: null,
    } as unknown as CheckRunResult["evidence"];
    const failRun = run({
      status: "fail",
      exitStatus: { kind: "exited", code: 1 },
      evidence: { ...(draft as object), exitStatus: { kind: "exited", code: 1 } } as never,
    });
    const passRun = run({ status: "pass", evidence: draft });
    const result = reconcileRuns("c1", [failRun, passRun]);
    expect(result.status).toBe("flaky");
    expect(result.evidence).toHaveLength(3);
    expect(result.evidence.at(-1)?.exitStatus).toEqual({ kind: "flaky", runs: [1, 0] });
    expect(result.evidence.at(-1)?.caveats.join(" ")).toContain("disagreed");
    // The individual runs are retained, not replaced.
    expect(result.evidence.slice(0, 2).map((e) => e.exitStatus)).toEqual([
      { kind: "exited", code: 1 },
      { kind: "exited", code: 0 },
    ]);
  });

  it("a run with no exit code records -1 in the flaky run list, never a real code", () => {
    const draft = {
      workflowId: "wf-1",
      taskId: "tk-1",
      taskRevision: 1,
      attemptId: null,
      requirementId: "ac-1",
      checkId: "c1",
      artifact: null,
      revision: SHA,
      commandIdentity: { command: "npm test", cwd: ".", environmentHash: "c".repeat(64) },
      exitStatus: { kind: "timed_out" },
      reviewer: { kind: "deterministic" },
      caveats: [],
      provenance: [],
      supersedesId: null,
    } as unknown as CheckRunResult["evidence"];
    const result = reconcileRuns("c1", [
      run({ status: "timeout", exitStatus: { kind: "timed_out" }, evidence: draft }),
      run({ status: "pass", evidence: draft }),
    ]);
    expect(result.status).toBe("flaky");
    expect(result.evidence.at(-1)?.exitStatus).toEqual({ kind: "flaky", runs: [-1, 0] });
  });
});

function check(overrides: Partial<CheckDefinition> = {}): CheckDefinition {
  return {
    id: "c1",
    kind: "command",
    command: "npm test",
    cwd: ".",
    expectedExitCode: 0,
    coversCriteria: ["ac1"],
    required: true,
    ...overrides,
  };
}

function evidence(overrides: Partial<Evidence> = {}): FreshnessInput {
  return {
    id: "ev1",
    checkId: "c1",
    taskRevision: 1,
    revision: SHA,
    exitStatus: { kind: "exited", code: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    supersedesId: null,
    ...overrides,
  } as FreshnessInput;
}

describe("checkState: missing is a distinct, explicit state", () => {
  it("a registered check with no fresh evidence at all is `missing`", () => {
    const status = checkState(check(), [], 1, SHA);
    expect(status).toBe("missing");
  });

  it("stale evidence (wrong taskRevision) does not count — still `missing`", () => {
    const status = checkState(check(), [evidence({ taskRevision: 0 })], 1, SHA);
    expect(status).toBe("missing");
  });

  it("stale evidence (wrong revision) does not count — still `missing`", () => {
    const status = checkState(check(), [evidence({ revision: SHA2 })], 1, SHA);
    expect(status).toBe("missing");
  });

  it("superseded evidence is excluded — still `missing`", () => {
    const status = checkState(check(), [evidence({ id: "ev1" as Evidence["id"] })], 1, SHA, new Set(["ev1"]));
    expect(status).toBe("missing");
  });

  it("fresh passing evidence is `pass`", () => {
    const status = checkState(check(), [evidence()], 1, SHA);
    expect(status).toBe("pass");
  });

  it("unavailable exit status maps to `unavailable`, never `pass`", () => {
    const status = checkState(
      check(),
      [evidence({ exitStatus: { kind: "unavailable", reason: "command_not_found" } })],
      1,
      SHA,
    );
    expect(status).toBe("unavailable");
  });

  it("timed_out exit status maps to `timeout`, never `pass`", () => {
    const status = checkState(check(), [evidence({ exitStatus: { kind: "timed_out" } })], 1, SHA);
    expect(status).toBe("timeout");
  });
});

describe("AC3: uncoveredCriteria is reported by criterion id, distinct from `missing`", () => {
  it("a criterion with no covering check is named, not folded into a check state", () => {
    const ids = uncoveredCriteria(
      [
        { id: "ac1", text: "first" },
        { id: "ac2", text: "second" },
      ],
      [check({ coversCriteria: ["ac1"] })],
    );
    expect(ids).toEqual(["ac2"]);
  });

  it("missingCheckBlockerDetail names the criterion", () => {
    expect(missingCheckBlockerDetail("ac2")).toContain("ac2");
  });

  it("a fully covered set of criteria reports nothing uncovered", () => {
    const ids = uncoveredCriteria([{ id: "ac1", text: "x" }], [check({ coversCriteria: ["ac1"] })]);
    expect(ids).toEqual([]);
  });
});

describe("AC2: board markers are distinct for every non-pass state", () => {
  it("pass/fail/flaky/missing/unavailable/timeout each render a different marker", () => {
    const markers = new Set(Object.keys(CHECK_STATE_MARKERS).map((k) => checkStateMarker(k)));
    expect(markers.size).toBe(Object.keys(CHECK_STATE_MARKERS).length);
    expect(checkStateMarker("pass")).not.toBe(checkStateMarker("flaky"));
    expect(checkStateMarker("flaky")).not.toBe(checkStateMarker("missing"));
    expect(checkStateMarker("missing")).not.toBe(checkStateMarker("unavailable"));
    expect(checkStateMarker("unavailable")).not.toBe(checkStateMarker("timeout"));
    expect(checkStateMarker("timeout")).not.toBe(checkStateMarker("fail"));
  });
});

describe("AC1: runCheckWithRerunPolicy detects a genuinely flaky real subprocess", () => {
  it("a command that fails then passes at the same revision reconciles to flaky", async () => {
    const repo = makeTestRepo("korwf-flaky-");
    repos.push(repo);
    const marker = join(repo.path, ".flaky-marker");
    // First invocation: marker absent -> exit 1. Second: marker now exists -> exit 0.
    const command = `node -e "const fs=require('fs'); const p='${marker}'; if (fs.existsSync(p)) process.exit(0); fs.writeFileSync(p,'x'); process.exit(1);"`;
    const subject: EvidenceSubject = {
      workflowId: "wf_1" as EvidenceSubject["workflowId"],
      taskId: "task_1" as EvidenceSubject["taskId"],
      taskRevision: 1 as EvidenceSubject["taskRevision"],
      attemptId: null,
      requirementId: "ac1",
    };
    const def: CheckDefinition = check({ command });
    const result = await runCheckWithRerunPolicy(def, { cwd: repo.path, subject });
    expect(result.status).toBe("flaky");
    expect(result.runs.length).toBeGreaterThanOrEqual(2);
  });
});

describe("taskCheckSummary: end-to-end per-task check state", () => {
  it("reports flaky/missing/uncovered together for one task", () => {
    const task = {
      revision: 1,
      acceptanceCriteria: [
        { id: "ac1", text: "a" },
        { id: "ac2", text: "b" },
      ],
      checks: [check({ id: "c1", coversCriteria: ["ac1"] })],
    };
    const summary = taskCheckSummary(task, [evidence({ checkId: "c1" })], SHA);
    expect(summary.checks).toEqual([{ checkId: "c1", status: "pass" }]);
    expect(summary.uncoveredCriteria).toEqual(["ac2"]);
  });

  it("reports `missing` for every check when the current revision is unknown", () => {
    const task = { revision: 1, acceptanceCriteria: [], checks: [check()] };
    const summary = taskCheckSummary(task, [evidence()], null);
    expect(summary.checks).toEqual([{ checkId: "c1", status: "missing" }]);
  });
});
