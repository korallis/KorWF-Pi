/**
 * Git worktree lifecycle (issue #70; PLAN §3.E "Separate Git worktrees for
 * parallel writing workers; never concurrent uncontrolled integration into
 * the user's tree"; ADR 0002 "`git/` is the only place that runs git").
 *
 * This module only *creates and removes worktrees*. It never checks out,
 * resets or stashes the user's main tree: `addWorktree` always names a new
 * path and a new branch, and `removeWorktree` refuses outright if asked to
 * remove the main tree.
 */
import { existsSync } from "node:fs";
import { realGitEnvRunner, worktreeIdentity, type GitEnvRunner, type WorktreeIdentity } from "./checkpoint.ts";

/** Reason codes for a refused worktree operation. */
export const WORKTREE_ERROR_CODES = [
  "not_a_repository",
  "revision_missing",
  "path_exists",
  "refuses_main_tree",
  "git_failed",
] as const;
export type WorktreeErrorCode = (typeof WORKTREE_ERROR_CODES)[number];

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  constructor(code: WorktreeErrorCode, message: string) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
  }
}

/** Options for {@link addWorktree}. */
export interface AddWorktreeOptions {
  /** Any path inside the repository the worktree is created from. */
  readonly repoCwd: string;
  /** Absolute path the new worktree is created at. Must not already exist. */
  readonly worktreePath: string;
  /** New branch name created at `baseRevision` for this worktree. */
  readonly branch: string;
  readonly baseRevision: string;
  readonly runner?: GitEnvRunner;
}

/** Result of creating a worktree. */
export interface CreatedWorktree {
  readonly path: string;
  readonly branch: string;
  readonly baseRevision: string;
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

/**
 * Create a linked worktree at `worktreePath`, on a new branch `branch`,
 * starting from `baseRevision`. Refuses if the revision does not exist in
 * this repository or the target path already exists — never overwrites.
 */
export function addWorktree(options: AddWorktreeOptions): CreatedWorktree {
  const runner = options.runner ?? realGitEnvRunner;
  const identity = worktreeIdentity(options.repoCwd, runner);
  if (identity === null) {
    throw new WorktreeError("not_a_repository", `${options.repoCwd} is not inside a git repository`);
  }
  if (tryRun(runner, ["cat-file", "-e", `${options.baseRevision}^{commit}`], identity.toplevel) === null) {
    throw new WorktreeError(
      "revision_missing",
      `base revision ${options.baseRevision} does not exist in this repository`,
    );
  }
  if (existsSync(options.worktreePath)) {
    throw new WorktreeError("path_exists", `${options.worktreePath} already exists`);
  }
  try {
    run(
      runner,
      ["worktree", "add", "-b", options.branch, options.worktreePath, options.baseRevision],
      identity.toplevel,
    );
  } catch (error) {
    throw new WorktreeError("git_failed", `git worktree add failed: ${(error as Error).message}`);
  }
  return { path: options.worktreePath, branch: options.branch, baseRevision: options.baseRevision };
}

/** Options for {@link removeWorktree}. */
export interface RemoveWorktreeOptions {
  /** Any path inside the repository (e.g. its main tree) to run the removal from. */
  readonly repoCwd: string;
  readonly worktreePath: string;
  readonly force?: boolean;
  readonly runner?: GitEnvRunner;
  /** Identity of the user's main tree, when known; see `worktree.ts` policy layer. */
  readonly mainTree?: WorktreeIdentity | null;
}

/**
 * Remove a linked worktree.
 *
 * Refuses unconditionally if the target resolves to the repository's main
 * tree (or the caller-supplied `mainTree`), independent of what path string
 * was passed in — `worktreeIdentity` is recomputed from git, not trusted from
 * the caller.
 */
export function removeWorktree(options: RemoveWorktreeOptions): void {
  const runner = options.runner ?? realGitEnvRunner;
  const identity = worktreeIdentity(options.worktreePath, runner);
  if (identity === null) {
    throw new WorktreeError("not_a_repository", `${options.worktreePath} is not inside a git repository`);
  }
  const isMain = options.mainTree
    ? identity.gitDir === options.mainTree.gitDir || identity.toplevel === options.mainTree.toplevel
    : !identity.isLinkedWorktree;
  if (isMain) {
    throw new WorktreeError(
      "refuses_main_tree",
      `refusing to remove ${options.worktreePath}: it resolves to the repository's main tree`,
    );
  }
  const args = ["worktree", "remove", options.worktreePath];
  if (options.force === true) args.push("--force");
  try {
    run(runner, args, options.repoCwd);
  } catch (error) {
    throw new WorktreeError("git_failed", `git worktree remove failed: ${(error as Error).message}`);
  }
}

/** List every linked worktree of the repository containing `cwd`. */
export interface WorktreeListEntry {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
}

export function listWorktrees(cwd: string, runner: GitEnvRunner = realGitEnvRunner): readonly WorktreeListEntry[] {
  const identity = worktreeIdentity(cwd, runner);
  if (identity === null) return [];
  const out = tryRun(runner, ["worktree", "list", "--porcelain"], identity.toplevel);
  if (out === null) return [];
  const entries: WorktreeListEntry[] = [];
  let current: { path?: string; head?: string; branch?: string } = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path !== undefined) {
        entries.push({ path: current.path, head: current.head ?? null, branch: current.branch ?? null });
      }
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (current.path !== undefined) {
    entries.push({ path: current.path, head: current.head ?? null, branch: current.branch ?? null });
  }
  return entries;
}
