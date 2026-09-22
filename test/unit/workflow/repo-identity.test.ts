/**
 * `src/workflow/repo-identity.ts` (issue #70): refuse to act on a repository
 * different from the one a Workflow was planned against.
 */
import { describe, it, expect, afterEach } from "vitest";
import { checkRepoAndRevision, checkRepoIdentity, REPO_IDENTITY_REFUSALS } from "../../../src/workflow/repo-identity.ts";
import { makeTestRepo, type TestRepo } from "../../helpers/git-repo.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import type { RepoIdentity } from "../../../src/git/index.ts";

const repos: TestRepo[] = [];
const dirs: TempDir[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
  while (dirs.length > 0) dirs.pop()?.cleanup();
});

function repo(): TestRepo {
  const r = makeTestRepo("korwf-identity-");
  repos.push(r);
  return r;
}

function identityOf(r: TestRepo): RepoIdentity {
  return { remoteUrl: null, rootCommit: r.head(), name: "planned-repo" };
}

describe("AC1: running in a different clone of another repo is refused", () => {
  it("refuses when the live repository's root commit differs", () => {
    const planned = repo();
    const other = repo();
    // `makeTestRepo` commits identical content (same message, same second-resolution
    // timestamp), which can produce an identical initial commit SHA between two fresh
    // repositories. Add a distinguishing commit so the two are unambiguously different
    // histories, since `detectRepoIdentity` reports live `HEAD` as the root commit.
    other.commitFile("other-marker.txt", "distinct\n", "distinguish from planned repo");
    const result = checkRepoIdentity(other.path, identityOf(planned));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(REPO_IDENTITY_REFUSALS.rootCommitMismatch);
  });

  it("refuses when cwd is not a git repository at all", () => {
    const planned = repo();
    const dir = makeTempDir("korwf-not-a-repo-");
    dirs.push(dir);
    const result = checkRepoIdentity(dir.path, identityOf(planned));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(REPO_IDENTITY_REFUSALS.greenfield);
  });

  it("refuses when remotes disagree even though root commits match (spoofed clone)", () => {
    const planned = repo();
    const expected: RepoIdentity = { remoteUrl: "https://example.invalid/a.git", rootCommit: planned.head(), name: "a" };
    // The live repo has no remote configured, so this exercises the "both sides must be
    // present" rule via a repo that *does* have one set differently.
    planned.git("remote", "add", "origin", "https://example.invalid/b.git");
    const result = checkRepoIdentity(planned.path, expected);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(REPO_IDENTITY_REFUSALS.remoteMismatch);
  });

  it("accepts the same repository by root commit, remote absent on one side", () => {
    const planned = repo();
    const result = checkRepoIdentity(planned.path, identityOf(planned));
    expect(result.ok).toBe(true);
  });
});

describe("checkRepoAndRevision: base revision must also exist", () => {
  it("refuses when the base revision is not present in this repository", () => {
    const planned = repo();
    const result = checkRepoAndRevision(planned.path, {
      repoIdentity: identityOf(planned),
      baseRevision: "f".repeat(40),
    });
    expect(result.ok).toBe(false);
  });

  it("accepts when the repository and base revision both match", () => {
    const planned = repo();
    const result = checkRepoAndRevision(planned.path, {
      repoIdentity: identityOf(planned),
      baseRevision: planned.head(),
    });
    expect(result.ok).toBe(true);
  });
});
