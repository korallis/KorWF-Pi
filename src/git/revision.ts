/**
 * Live repository revision state (issue #42; ADR 0002 "`git/` is the only
 * place that runs git").
 *
 * `status.ts` answers "is this a repo, and what is its identity" once, at
 * intake. This module answers the question session reconciliation asks every
 * time a session is started, resumed, forked or navigated: **what does the
 * repository look like right now**, and how does that relate to the revision
 * the persisted workflow was planned against.
 *
 * Read-only, like `status.ts`: no fetch, no checkout, no stash, no write. A
 * git command that fails is reported as an unknown relation rather than
 * guessed at — PLAN §5's "prefer refusing and reporting" applies to the
 * comparison as much as to the actions it protects.
 */
import { realGitRunner, type GitRunner } from "./status.ts";

/**
 * How the live `HEAD` relates to a revision the store recorded.
 *
 * - `same` — identical SHAs.
 * - `advanced` — the recorded revision is an ancestor of `HEAD`: work landed
 *   on top of it while the session was away.
 * - `rewound` — `HEAD` is an ancestor of the recorded revision: the branch
 *   was reset/checked out backwards, so recorded evidence describes commits
 *   that are no longer reachable from `HEAD`.
 * - `diverged` — neither is an ancestor of the other.
 * - `unknown_revision` — the recorded revision does not exist in this
 *   repository at all (rebased away, branch deleted, different clone).
 * - `indeterminate` — git could not answer; never treated as `same`.
 */
export type RevisionRelation =
  | "same"
  | "advanced"
  | "rewound"
  | "diverged"
  | "unknown_revision"
  | "indeterminate";

/** A path git reports as modified, with the porcelain status code that named it. */
export interface WorkingTreeChange {
  readonly status: string;
  readonly path: string;
}

/** What the repository looks like right now. */
export type LiveRepoState =
  | {
      readonly kind: "repo";
      readonly gitRoot: string;
      /** Resolved `HEAD`, or `null` for a repository with no commits yet. */
      readonly head: string | null;
      readonly branch: string | null;
      readonly dirty: boolean;
      readonly changes: readonly WorkingTreeChange[];
    }
  | { readonly kind: "no_repo" };

/** Cap on the number of working-tree entries retained, so a huge diff cannot flood a notice. */
export const MAX_REPORTED_CHANGES = 50;

function tryRun(runner: GitRunner, args: readonly string[], cwd: string): string | null {
  try {
    return runner.run(args, cwd).trim();
  } catch {
    return null;
  }
}

/** Parse `git status --porcelain` output into `(status, path)` pairs. */
export function parsePorcelain(porcelain: string): readonly WorkingTreeChange[] {
  const changes: WorkingTreeChange[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.trim().length === 0) continue;
    const status = line.slice(0, 2).trim();
    const path = line.slice(3).trim();
    if (path.length === 0) continue;
    changes.push({ status: status.length === 0 ? "?" : status, path });
  }
  return changes;
}

/**
 * Read the live state of the repository containing `cwd`.
 *
 * Every field is read fresh: nothing here consults the store, and nothing
 * here is cached, because the entire point of reconciliation is that the
 * saved session's view of the repository may be wrong.
 */
export function readLiveRepoState(cwd: string, runner: GitRunner = realGitRunner): LiveRepoState {
  const gitRoot = tryRun(runner, ["rev-parse", "--show-toplevel"], cwd);
  if (gitRoot === null) return { kind: "no_repo" };

  const head = tryRun(runner, ["rev-parse", "HEAD"], gitRoot);
  const branchRaw = tryRun(runner, ["rev-parse", "--abbrev-ref", "HEAD"], gitRoot);
  const porcelain = tryRun(runner, ["status", "--porcelain"], gitRoot);
  const changes = porcelain === null ? [] : parsePorcelain(porcelain);

  return {
    kind: "repo",
    gitRoot,
    head: head === null || head.length === 0 ? null : head,
    // `HEAD` is what git prints for a detached head; that is not a branch name.
    branch: branchRaw === null || branchRaw.length === 0 || branchRaw === "HEAD" ? null : branchRaw,
    dirty: changes.length > 0,
    changes: changes.slice(0, MAX_REPORTED_CHANGES),
  };
}

/** Does `revision` name an object that exists in this repository? */
export function revisionExists(gitRoot: string, revision: string, runner: GitRunner = realGitRunner): boolean {
  if (revision.trim().length === 0) return false;
  return tryRun(runner, ["cat-file", "-e", `${revision}^{commit}`], gitRoot) !== null;
}

/**
 * Relate a recorded revision to the live `HEAD`.
 *
 * Ancestry is decided with `git merge-base --is-ancestor`, which is a
 * question about the commit graph and therefore unaffected by which branch
 * happens to be checked out. A failure to answer produces `indeterminate`,
 * never `same`.
 */
export function compareRevisions(
  gitRoot: string,
  recorded: string,
  head: string | null,
  runner: GitRunner = realGitRunner,
): RevisionRelation {
  if (head === null) return "indeterminate";
  if (recorded.trim().length === 0) return "indeterminate";
  if (recorded === head) return "same";
  if (!revisionExists(gitRoot, recorded, runner)) return "unknown_revision";
  if (!revisionExists(gitRoot, head, runner)) return "indeterminate";

  const recordedIsAncestor = isAncestor(gitRoot, recorded, head, runner);
  const headIsAncestor = isAncestor(gitRoot, head, recorded, runner);
  if (recordedIsAncestor === null || headIsAncestor === null) return "indeterminate";
  if (recordedIsAncestor) return "advanced";
  if (headIsAncestor) return "rewound";
  return "diverged";
}

/** `true`/`false` from `merge-base --is-ancestor`; `null` when git errored for another reason. */
function isAncestor(
  gitRoot: string,
  maybeAncestor: string,
  descendant: string,
  runner: GitRunner,
): boolean | null {
  try {
    runner.run(["merge-base", "--is-ancestor", maybeAncestor, descendant], gitRoot);
    return true;
  } catch (error) {
    // Exit status 1 is the documented "no" answer; anything else is a real failure.
    const status = (error as { status?: unknown }).status;
    if (status === 1) return false;
    return null;
  }
}

/** Does this relation mean the repository moved away from the recorded revision? */
export function isDrift(relation: RevisionRelation): boolean {
  return relation !== "same";
}
