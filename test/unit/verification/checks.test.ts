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
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";

const repos: TestRepo[] = [];
const dirs: TempDir[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
  while (dirs.length > 0) dirs.pop()?.cleanup();
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

  it("reads the revision through src/git/, so the runner is the single git path", async () => {
    const repo = freshRepo();
    const calls: string[][] = [];
    const spying = {
      run: (args: readonly string[], cwd: string): string =>
        (calls.push([...args]),
        execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })),
    };
    const result = await runCheck(check(), { cwd: repo.path, subject, gitRunner: spying });
    expect(result.revision).toBe(repo.head());
    expect(calls.some((args) => args[0] === "rev-parse" && args.includes("HEAD"))).toBe(true);
  });

  it("is unavailable, not pass, when the directory is not a git repository", async () => {
    const dir = makeTempDir("korwf-norepo-");
    dirs.push(dir);
    const result = await runCheck(check(), { cwd: dir.path, subject });
    expect(result.status).toBe("unavailable");
    expect(result.exitStatus).toEqual({ kind: "unavailable", reason: "no_revision" });
    // Nothing to pin evidence to, so no row is drafted at all.
    expect(result.evidence).toBeNull();
  });
});

describe("AC2: a command that cannot be executed is unavailable, never pass", () => {
  it("classifies an absent binary as unavailable rather than fail", async () => {
    const repo = freshRepo();
    const result = await runCheck(check({ command: "korwf-definitely-not-a-real-binary --version" }), {
      cwd: repo.path,
      subject,
    });
    expect(result.status).toBe("unavailable");
    expect(result.exitStatus).toEqual({ kind: "unavailable", reason: "command_not_found" });
    expect(result.status).not.toBe("pass");
  });

  it("does not report unavailable as pass even when the check expects exit 127", async () => {
    const repo = freshRepo();
    // The confusion this criterion exists for, inverted: a check that declares
    // 127 as its expected code must still not pass on a missing tool, because
    // the shell's 127 says the command never ran.
    const result = await runCheck(
      check({ command: "korwf-definitely-not-a-real-binary", expectedExitCode: 127 }),
      { cwd: repo.path, subject },
    );
    expect(result.status).toBe("unavailable");
  });

  it("still reports a genuine non-zero exit as fail", async () => {
    const repo = freshRepo();
    const result = await runCheck(check({ command: 'node -e "process.exit(3)"' }), {
      cwd: repo.path,
      subject,
    });
    expect(result.status).toBe("fail");
    expect(result.exitStatus).toEqual({ kind: "exited", code: 3 });
  });

  it("treats a program that chooses exit 127 itself as fail, not unavailable", async () => {
    const repo = freshRepo();
    const result = await runCheck(check({ command: 'node -e "process.exit(127)"' }), {
      cwd: repo.path,
      subject,
    });
    expect(result.status).toBe("fail");
    expect(result.exitStatus).toEqual({ kind: "exited", code: 127 });
  });

  it("reports a missing working directory as unavailable", async () => {
    const repo = freshRepo();
    const result = await runCheck(check({ cwd: "no/such/dir" }), { cwd: repo.path, subject });
    expect(result.status).toBe("unavailable");
    expect(result.exitStatus).toEqual({ kind: "unavailable", reason: "cwd_missing" });
    // Evidence is still recorded: "the check could not run here" is a fact
    // about this revision (PLAN §3.F "represented explicitly").
    expect(result.evidence?.revision).toBe(repo.head());
  });
});
