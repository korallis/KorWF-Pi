/**
 * Repository identity check (issue #70; PLAN §3.E, §10; docs/records.md
 * `Workflow.repoIdentity`/`baseRevision`, #12).
 *
 * A `Workflow` is planned against a specific repository. Acting on the wrong
 * one — a different clone, a similarly-named sibling project, a directory
 * that happens to share a basename — is unrecoverable: any writes a worker
 * makes land in the wrong history. This module answers one question before
 * anything is allowed to run: **is the repository at `cwd` the one this
 * Workflow was created for?** When it cannot be sure, it refuses; it never
 * guesses (PLAN §5 "prefer refusing and reporting").
 *
 * No git is run here: `detectRepoIdentity` (src/git/status.ts) is the only
 * place that does, per ADR 0002.
 */
import { detectRepoIdentity, realGitRunner, type GitRunner, type RepoIdentity } from "../git/index.ts";

/** Why a repository identity check refused. */
export const REPO_IDENTITY_REFUSALS = {
  /** `cwd` is not inside any git repository at all. */
  notARepository: "not_a_repository",
  /** The repository has no commits yet (greenfield), so it cannot match a planned Workflow. */
  greenfield: "greenfield",
  /** The root commit differs: this is a different repository history. */
  rootCommitMismatch: "root_commit_mismatch",
  /** Root commits match but the recorded remote URL differs from the live one. */
  remoteMismatch: "remote_mismatch",
} as const;

export type RepoIdentityRefusal = (typeof REPO_IDENTITY_REFUSALS)[keyof typeof REPO_IDENTITY_REFUSALS];

/** Result of checking a Workflow's repository identity against the live tree. */
export type RepoIdentityCheck =
  | { readonly ok: true; readonly live: RepoIdentity; readonly gitRoot: string }
  | { readonly ok: false; readonly reason: RepoIdentityRefusal; readonly detail: string };

/**
 * Verify that `cwd` resolves to the same repository the `expected` identity
 * describes.
 *
 * Matching rule, deliberately narrow:
 *
 *  - `rootCommit` must match exactly. It is stable across clones, forks and
 *    remote renames, and is the one field in {@link RepoIdentity} that cannot
 *    be spoofed by editing `.git/config`.
 *  - If **both** sides have a non-null `remoteUrl`, it must also match. A
 *    Workflow recorded with no remote (a local-only repo) is not compared on
 *    that field, and neither is a live repo that currently has none — the
 *    root commit is the authority; the remote is corroborating evidence only,
 *    consulted when both sides can offer it.
 *
 * Anything that cannot be established — no repository, a repository with no
 * commits yet — is a refusal, never treated as "compatible".
 */
export function checkRepoIdentity(
  cwd: string,
  expected: RepoIdentity,
  runner: GitRunner = realGitRunner,
): RepoIdentityCheck {
  const detection = detectRepoIdentity(cwd, runner);

  if (detection.kind === "greenfield") {
    return {
      ok: false,
      reason: REPO_IDENTITY_REFUSALS.greenfield,
      detail:
        `${cwd} is not an existing git repository with commits; the Workflow was planned ` +
        `against ${expected.name} (root commit ${expected.rootCommit}). Refusing rather than guessing.`,
    };
  }

  const live = detection.identity;
  if (live.rootCommit !== expected.rootCommit) {
    return {
      ok: false,
      reason: REPO_IDENTITY_REFUSALS.rootCommitMismatch,
      detail:
        `repository at ${detection.gitRoot} has root commit ${live.rootCommit}, but this Workflow ` +
        `was planned against ${expected.name} (root commit ${expected.rootCommit}). Refusing: acting on the ` +
        `wrong repository is unrecoverable.`,
    };
  }

  if (expected.remoteUrl !== null && live.remoteUrl !== null && expected.remoteUrl !== live.remoteUrl) {
    return {
      ok: false,
      reason: REPO_IDENTITY_REFUSALS.remoteMismatch,
      detail:
        `repository at ${detection.gitRoot} has remote ${live.remoteUrl}, but this Workflow was planned ` +
        `against remote ${expected.remoteUrl} (same root commit; remotes disagree).`,
    };
  }

  return { ok: true, live, gitRoot: detection.gitRoot };
}

/**
 * Verify identity **and** that the base revision the Workflow was planned
 * against still exists in the repository.
 *
 * A repository can be the right one and still lack the base revision — a
 * shallow clone, a rebased-away branch, a history rewrite. Neither is safe
 * to build a worktree from, so both are checked together as one gate before
 * any worker or worktree is created.
 */
export function checkRepoAndRevision(
  cwd: string,
  expected: { readonly repoIdentity: RepoIdentity; readonly baseRevision: string },
  runner: GitRunner = realGitRunner,
): RepoIdentityCheck {
  const identityCheck = checkRepoIdentity(cwd, expected.repoIdentity, runner);
  if (!identityCheck.ok) return identityCheck;

  if (!revisionExists(identityCheck.gitRoot, expected.baseRevision, runner)) {
    return {
      ok: false,
      reason: REPO_IDENTITY_REFUSALS.rootCommitMismatch,
      detail:
        `repository ${identityCheck.gitRoot} matches this Workflow's identity, but base revision ` +
        `${expected.baseRevision} it was planned against no longer exists here.`,
    };
  }
  return identityCheck;
}

function revisionExists(gitRoot: string, revision: string, runner: GitRunner): boolean {
  if (revision.trim().length === 0) return false;
  try {
    runner.run(["cat-file", "-e", `${revision}^{commit}`], gitRoot);
    return true;
  } catch {
    return false;
  }
}
