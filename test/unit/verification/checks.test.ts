/**
 * `src/verification/checks.ts` + `evidence.ts` (issue #45): check registration
 * and evidence capture at the exact revision and environment.
 *
 * Test names reference the issue's acceptance criteria:
 *   AC1 — Evidence.revision equals `git rev-parse HEAD` at run time.
 *   AC2 — command not found → `unavailable`, never `pass`.
 *   AC3 — timeout kills the whole process tree.
 *   AC4 — secrets never reach stored stdout/stderr.
 *   AC5 — a `human` check creates a pending approval, never Evidence.
 *
 * These run real subprocesses against real git repositories: the defects the
 * criteria describe (a stale revision, a 127 read as a failure, an orphaned
 * `sleep`) are all invisible to a mocked spawn.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { runCheck } from "../../../src/verification/checks.ts";
import type { CheckDefinition } from "../../../src/storage/records.ts";
import type { EvidenceSubject } from "../../../src/verification/evidence.ts";
import { makeTestRepo, type TestRepo } from "../../helpers/git-repo.ts";

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
});

function freshRepo(): TestRepo {
  const repo = makeTestRepo("korwf-checks-");
  repos.push(repo);
  return repo;
}

const subject: EvidenceSubject = {
  workflowId: "wf_1" as EvidenceSubject["workflowId"],
  taskId: "task_1" as EvidenceSubject["taskId"],
  taskRevision: 1 as EvidenceSubject["taskRevision"],
  attemptId: null,
  requirementId: "ac1",
};

function check(overrides: Partial<CheckDefinition> = {}): CheckDefinition {
  return {
    id: "c1",
    kind: "command",
    command: "node -e \"process.exit(0)\"",
    cwd: ".",
    expectedExitCode: 0,
    coversCriteria: ["ac1"],
    required: true,
    ...overrides,
  };
}

/** `ps` view of whether a pid is still alive, independent of the module under test. */
function pidAlive(pid: number): boolean {
  try {
    execFileSync("ps", ["-p", String(pid)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("AC1: Evidence.revision is the worktree HEAD at run time", () => {
  it("records the revision git reports, not one supplied by the caller", async () => {
    const repo = freshRepo();
    const result = await runCheck(check(), { cwd: repo.path, subject });
    expect(result.status).toBe("pass");
    expect(result.revision).toBe(repo.head());
    expect(result.evidence?.revision).toBe(repo.head());
  });

  it("produces different revisions when the repository is mutated between runs", async () => {
    const repo = freshRepo();
    const first = await runCheck(check(), { cwd: repo.path, subject });
    const firstHead = repo.head();

    repo.commitFile("feature.txt", "work\n", "second commit");
    const secondHead = repo.head();
    expect(secondHead).not.toBe(firstHead);

    const second = await runCheck(check(), { cwd: repo.path, subject });
    expect(first.evidence?.revision).toBe(firstHead);
    expect(second.evidence?.revision).toBe(secondHead);
    expect(second.evidence?.revision).not.toBe(first.evidence?.revision);
  });
});
