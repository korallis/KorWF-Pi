/**
 * Attempt worktree lifecycle (issue #70; PLAN §3.E "Separate Git worktrees
 * for parallel writing workers"; PLAN §10 "worktrees remain recoverable;
 * dirty user changes preserved").
 *
 * This is the policy layer over `src/git/worktree.ts`: it decides *where*
 * an attempt's worktree lives (`.korwf/worktrees/<attempt>`, never inside
 * the user's tree at large) and *what revision* it is built from (the base
 * revision the Workflow was planned against — never the user's live, dirty
 * `HEAD`). It never touches the user's main working tree: `addWorktree`
 * always creates a brand-new path and branch, so nothing here can check out,
 * reset or stash anything the user can see.
 */
import { join } from "node:path";
import { addWorktree, removeWorktree, realGitEnvRunner, worktreeIdentity, type GitEnvRunner } from "../git/index.ts";
import { DEFAULT_STORAGE_DIR_NAME } from "../storage/paths.ts";

/** Subdirectory of the storage root that holds attempt worktrees. */
export const WORKTREES_DIR_NAME = "worktrees";

/** Branch name prefix, so attempt branches never collide with the user's own. */
export const WORKTREE_BRANCH_PREFIX = "korwf/attempt";

/** Compute the path an attempt's worktree lives at, under `.korwf/worktrees/`. */
export function attemptWorktreePath(projectRoot: string, attemptId: string): string {
  return join(projectRoot, DEFAULT_STORAGE_DIR_NAME, WORKTREES_DIR_NAME, attemptId);
}

/** Branch name created for an attempt's worktree. */
export function attemptWorktreeBranch(attemptId: string): string {
  return `${WORKTREE_BRANCH_PREFIX}/${attemptId}`;
}

/** Inputs for {@link createAttemptWorktree}. */
export interface CreateAttemptWorktreeOptions {
  /** Any path inside the user's repository (their main tree). */
  readonly projectRoot: string;
  readonly attemptId: string;
  /** The revision the Workflow was planned against — never a live `HEAD`. */
  readonly baseRevision: string;
  readonly runner?: GitEnvRunner;
}

/** A created attempt worktree, ready for a worker's `cwd`. */
export interface AttemptWorktree {
  readonly path: string;
  readonly branch: string;
  readonly baseRevision: string;
}

/**
 * Create the worktree a worker attempt will run in.
 *
 * Always builds from `baseRevision`, never from the live `HEAD` of the
 * user's tree: whatever is uncommitted in the main tree at the moment this
 * runs is simply not part of what gets checked out here, by construction —
 * `git worktree add <path> <baseRevision>` populates the new tree from that
 * commit alone. Nothing is read from the working tree or the index of
 * `projectRoot`.
 */
export function createAttemptWorktree(options: CreateAttemptWorktreeOptions): AttemptWorktree {
  const created = addWorktree({
    repoCwd: options.projectRoot,
    worktreePath: attemptWorktreePath(options.projectRoot, options.attemptId),
    branch: attemptWorktreeBranch(options.attemptId),
    baseRevision: options.baseRevision,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
  return { path: created.path, branch: created.branch, baseRevision: created.baseRevision };
}

/** Inputs for {@link removeAttemptWorktree}. */
export interface RemoveAttemptWorktreeOptions {
  readonly projectRoot: string;
  readonly attemptId: string;
  readonly force?: boolean;
  readonly runner?: GitEnvRunner;
}

/**
 * Remove an attempt's worktree (Stage 6 cleanup hook).
 *
 * `removeWorktree` (src/git/worktree.ts) independently refuses to remove
 * anything that resolves to the repository's main tree, so even a caller
 * that miscomputes `attemptId` cannot use this to delete the user's tree.
 */
export function removeAttemptWorktree(options: RemoveAttemptWorktreeOptions): void {
  const runner = options.runner ?? realGitEnvRunner;
  const mainTree = worktreeIdentity(options.projectRoot, runner);
  removeWorktree({
    repoCwd: options.projectRoot,
    worktreePath: attemptWorktreePath(options.projectRoot, options.attemptId),
    force: options.force ?? false,
    runner,
    mainTree,
  });
}
