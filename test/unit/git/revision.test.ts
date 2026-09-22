/**
 * `src/git/revision.ts` (issue #42): live repository state and the ancestry
 * relation session reconciliation is built on.
 *
 * Supports acceptance criterion 1 ("mutate the repo, resume: status shows the
 * drift"): the drift itself is computed here, so every relation gets a test
 * against a real repository.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  compareRevisions,
  isDrift,
  parsePorcelain,
  readLiveRepoState,
  revisionExists,
} from "../../../src/git/revision.ts";
import type { GitRunner } from "../../../src/git/status.ts";
import { makeTestRepo, type TestRepo } from "../../helpers/git-repo.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";

const repos: TestRepo[] = [];
const dirs: TempDir[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
  while (dirs.length > 0) dirs.pop()?.cleanup();
});

function freshRepo(): TestRepo {
  const repo = makeTestRepo();
  repos.push(repo);
  return repo;
}

describe("AC1: readLiveRepoState reads the repository as it is now", () => {
  it("reports no_repo outside a git repository", () => {
    const dir = makeTempDir("korwf-norepo-");
    dirs.push(dir);
    expect(readLiveRepoState(dir.path).kind).toBe("no_repo");
  });

  it("reports HEAD, branch and a clean tree", () => {
    const repo = freshRepo();
    const state = readLiveRepoState(repo.path);
    expect(state.kind).toBe("repo");
    if (state.kind !== "repo") return;
    expect(state.head).toBe(repo.head());
    expect(state.branch).toBe("main");
    expect(state.dirty).toBe(false);
    expect(state.changes).toEqual([]);
  });

  it("reports the dirty working tree and the paths that changed", () => {
    const repo = freshRepo();
    repo.writeDirty("new-file.txt", "uncommitted\n");
    const state = readLiveRepoState(repo.path);
    expect(state.kind).toBe("repo");
    if (state.kind !== "repo") return;
    expect(state.dirty).toBe(true);
    expect(state.changes.map((c) => c.path)).toContain("new-file.txt");
  });

  it("reports branch null for a detached HEAD rather than the literal 'HEAD'", () => {
    const repo = freshRepo();
    const first = repo.head();
    repo.commitFile("second.txt", "two\n", "second");
    repo.git("checkout", "-q", "--detach", first);
    const state = readLiveRepoState(repo.path);
    expect(state.kind).toBe("repo");
    if (state.kind !== "repo") return;
    expect(state.branch).toBeNull();
    expect(state.head).toBe(first);
  });
});

describe("AC1: compareRevisions relates a recorded revision to live HEAD", () => {
  it("same when HEAD has not moved", () => {
    const repo = freshRepo();
    expect(compareRevisions(repo.path, repo.head(), repo.head())).toBe("same");
    expect(isDrift("same")).toBe(false);
  });

  it("advanced when commits landed on top of the recorded revision", () => {
    const repo = freshRepo();
    const base = repo.head();
    repo.commitFile("a.txt", "a\n", "later work");
    expect(compareRevisions(repo.path, base, repo.head())).toBe("advanced");
    expect(isDrift("advanced")).toBe(true);
  });

  it("rewound when HEAD was reset behind the recorded revision", () => {
    const repo = freshRepo();
    const base = repo.head();
    const later = repo.commitFile("a.txt", "a\n", "later work");
    repo.git("reset", "-q", "--hard", base);
    expect(compareRevisions(repo.path, later, repo.head())).toBe("rewound");
  });

  it("diverged when neither revision is an ancestor of the other", () => {
    const repo = freshRepo();
    const base = repo.head();
    const sideBranch = repo.commitFile("side.txt", "side\n", "side work");
    repo.git("reset", "-q", "--hard", base);
    repo.commitFile("main.txt", "main\n", "main work");
    expect(compareRevisions(repo.path, sideBranch, repo.head())).toBe("diverged");
  });

  it("unknown_revision when the recorded revision is not in this repository", () => {
    const repo = freshRepo();
    const absent = "0".repeat(40);
    expect(revisionExists(repo.path, absent)).toBe(false);
    expect(compareRevisions(repo.path, absent, repo.head())).toBe("unknown_revision");
  });

  it("indeterminate, never 'same', when there is no HEAD to compare against", () => {
    const repo = freshRepo();
    expect(compareRevisions(repo.path, repo.head(), null)).toBe("indeterminate");
  });

  it("indeterminate when git fails for a reason other than a negative answer", () => {
    const failing: GitRunner = {
      run(args) {
        if (args[0] === "cat-file") return "";
        const error = new Error("git exploded") as Error & { status?: number };
        error.status = 128;
        throw error;
      },
    };
    expect(compareRevisions("/nowhere", "a".repeat(40), "b".repeat(40), failing)).toBe("indeterminate");
  });
});

describe("parsePorcelain", () => {
  it("keeps the status code and path of each entry and drops blank lines", () => {
    const parsed = parsePorcelain(" M src/a.ts\n?? new.txt\n\n A  src/b.ts\n");
    expect(parsed).toEqual([
      { status: "M", path: "src/a.ts" },
      { status: "??", path: "new.txt" },
      { status: "A", path: "src/b.ts" },
    ]);
  });
});
