/**
 * Integration-branch merges and conflict detection (issue #78; PLAN §3.E
 * "one integration owner; never concurrent uncontrolled integration into the
 * user's tree"; ADR 0002 "`src/git/` is the only place that runs git").
 *
 * This module is the git half of the integration queue. It answers three
 * questions and performs one act:
 *
 *  - where is a branch now (`resolveRef`), and how does a recorded base
 *    revision relate to it (`baseRelation`, delegating ancestry to
 *    `revision.ts`'s `compareRevisions`);
 *  - can the integration branch take the task branch as a fast-forward
 *    (`canFastForward`);
 *  - does merging conflict, and if so on exactly which paths
 *    (`mergeBranch`, which reports `conflict` with the paths git named).
 *
 * Every operation runs in an explicitly named worktree path supplied by the
 * caller. Nothing here ever checks out, resets, stashes or merges into a tree
 * it was not handed, and a conflicted merge is always left *aborted*, so the
 * tree it ran in is recoverable rather than sitting in a half-merged state
 * (#82 owns recovery; this module owes it a clean tree).
 */
import { realGitEnvRunner, worktreeIdentity, type GitEnvRunner } from "./checkpoint.ts";
import { compareRevisions, type RevisionRelation } from "./revision.ts";

/** Reason codes for a refused or failed merge operation. */
export const MERGE_ERROR_CODES = ["not_a_repository", "unknown_ref", "git_failed", "dirty_tree"] as const;
export type MergeErrorCode = (typeof MERGE_ERROR_CODES)[number];

export class MergeError extends Error {
  readonly code: MergeErrorCode;
  constructor(code: MergeErrorCode, message: string) {
    super(message);
    this.name = "MergeError";
    this.code = code;
  }
}

/** How a merge attempt ended. */
export type MergeOutcome =
  | { readonly kind: "already_integrated"; readonly head: string }
  | { readonly kind: "fast_forward"; readonly head: string; readonly from: string }
  | { readonly kind: "merged"; readonly head: string; readonly from: string }
  | { readonly kind: "conflict"; readonly head: string; readonly paths: readonly string[]; readonly detail: string };

export interface MergeBranchOptions {
  /** Worktree the merge runs in. Must be the integration worktree, never the user's tree. */
  readonly worktreePath: string;
  /** Revision (branch name or sha) being merged in. */
  readonly source: string;
  /** Commit message used when a real merge commit is created. */
  readonly message: string;
  /** Refuse a fast-forward-only integration; always create a merge commit. */
  readonly noFastForward?: boolean;
  readonly runner?: GitEnvRunner;
}

function run(runner: GitEnvRunner, args: readonly string[], cwd: string): string {
  return runner.run(args, cwd).trim();
}

function tryRun(runner: GitEnvRunner, args: readonly string[], cwd: string): string | null {
  try {
    return run(runner, args, cwd);
  } catch {
    return null;
  }
}

/** Resolve a ref (branch, tag or sha) to a commit sha, or `null` when it does not exist. */
export function resolveRef(cwd: string, ref: string, runner: GitEnvRunner = realGitEnvRunner): string | null {
  if (ref.trim().length === 0) return null;
  return tryRun(runner, ["rev-parse", "--verify", `${ref}^{commit}`], cwd);
}

/**
 * Relate a recorded base revision to where the integration branch is now.
 *
 * Pure delegation to `revision.ts`: `"same"` means the base has not moved,
 * and anything else means the work was verified against a tree that is no
 * longer the integration base. `"indeterminate"` is returned when git cannot
 * answer, and callers must treat it as movement, never as `"same"`.
 */
export function baseRelation(
  cwd: string,
  recordedBase: string,
  integrationHead: string | null,
  runner: GitEnvRunner = realGitEnvRunner,
): RevisionRelation {
  const identity = worktreeIdentity(cwd, runner);
  if (identity === null) return "indeterminate";
  return compareRevisions(identity.toplevel, recordedBase, integrationHead, runner);
}

/**
 * Is `source` already contained in `target` (nothing to merge), or reachable
 * as a fast-forward from it?
 *
 * `contains` and `fastForward` are both false when the branches have
 * diverged, and both false when git could not answer — a failure is never
 * reported as "safe to fast-forward".
 */
export function canFastForward(
  cwd: string,
  target: string,
  source: string,
  runner: GitEnvRunner = realGitEnvRunner,
): { readonly contains: boolean; readonly fastForward: boolean } {
  const targetSha = resolveRef(cwd, target, runner);
  const sourceSha = resolveRef(cwd, source, runner);
  if (targetSha === null || sourceSha === null) return { contains: false, fastForward: false };
  if (targetSha === sourceSha) return { contains: true, fastForward: false };
  const identity = worktreeIdentity(cwd, runner);
  if (identity === null) return { contains: false, fastForward: false };
  const relation = compareRevisions(identity.toplevel, targetSha, sourceSha, runner);
  // `advanced` means targetSha is an ancestor of sourceSha: source is ahead,
  // so target can fast-forward onto it.
  if (relation === "advanced") return { contains: false, fastForward: true };
  // `rewound` means sourceSha is an ancestor of targetSha: already integrated.
  if (relation === "rewound") return { contains: true, fastForward: false };
  return { contains: false, fastForward: false };
}

/** Paths git reports as unmerged (`diff --name-only --diff-filter=U`). */
export function conflictedPaths(cwd: string, runner: GitEnvRunner = realGitEnvRunner): readonly string[] {
  const out = tryRun(runner, ["diff", "--name-only", "--diff-filter=U"], cwd);
  if (out === null || out.length === 0) return [];
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** `true` when the worktree has uncommitted tracked or untracked changes. */
export function isDirty(cwd: string, runner: GitEnvRunner = realGitEnvRunner): boolean {
  const out = tryRun(runner, ["status", "--porcelain"], cwd);
  // A git failure is reported as dirty: "we could not tell" must never read
  // as "there is nothing to lose".
  if (out === null) return true;
  return out.length > 0;
}

/**
 * Merge `source` into whatever `worktreePath` has checked out.
 *
 * Preconditions, all refusals rather than best-effort behaviour:
 *  - the path is a git worktree (`not_a_repository`);
 *  - `source` resolves (`unknown_ref`);
 *  - the worktree is clean (`dirty_tree`). Merging over uncommitted work is
 *    how uncommitted work gets lost, so it is refused outright rather than
 *    stashed — #54/#70's rule that the system never discards work it did not
 *    create.
 *
 * On conflict the merge is **aborted** before returning, so the caller gets a
 * clean tree plus the list of conflicted paths. The conflict is data for the
 * resolution workflow, not a broken worktree left for a human to find.
 */
export function mergeBranch(options: MergeBranchOptions): MergeOutcome {
  const runner = options.runner ?? realGitEnvRunner;
  const cwd = options.worktreePath;
  const identity = worktreeIdentity(cwd, runner);
  if (identity === null) {
    throw new MergeError("not_a_repository", `${cwd} is not inside a git repository`);
  }
  const sourceSha = resolveRef(cwd, options.source, runner);
  if (sourceSha === null) {
    throw new MergeError("unknown_ref", `merge source ${options.source} does not resolve to a commit`);
  }
  if (isDirty(cwd, runner)) {
    throw new MergeError(
      "dirty_tree",
      `${cwd} has uncommitted changes; refusing to merge over them (PLAN §10: never discard uncommitted work)`,
    );
  }
  const before = resolveRef(cwd, "HEAD", runner);
  if (before === null) {
    throw new MergeError("unknown_ref", `${cwd} has no HEAD commit to merge into`);
  }
  const ff = canFastForward(cwd, before, sourceSha, runner);
  if (ff.contains) return { kind: "already_integrated", head: before };

  const args = ["merge", "--no-edit"];
  args.push(options.noFastForward === true ? "--no-ff" : "--ff");
  args.push("-m", options.message, sourceSha);
  try {
    run(runner, args, cwd);
  } catch (error) {
    const paths = conflictedPaths(cwd, runner);
    const detail = (error as Error).message;
    // Leave the tree usable whether or not this was a content conflict.
    tryRun(runner, ["merge", "--abort"], cwd);
    if (paths.length > 0) {
      return { kind: "conflict", head: before, paths, detail };
    }
    throw new MergeError("git_failed", `git merge failed: ${detail}`);
  }
  const after = resolveRef(cwd, "HEAD", runner) ?? before;
  return {
    kind: ff.fastForward && options.noFastForward !== true ? "fast_forward" : "merged",
    head: after,
    from: sourceSha,
  };
}
