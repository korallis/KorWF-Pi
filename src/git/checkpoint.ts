/**
 * Checkpoint capture and restore (issue #54; PLAN §3.G "Checkpoints and
 * approval policy for rollback; preserve uncommitted user work"; ADR 0002
 * "`src/git/` is the only place that runs git"; ADR 0001 row 5).
 *
 * This module is the *mechanism*. The policy — that a rollback is a proposal
 * requiring a `destructive_git` approval record, never an automatic act —
 * lives in `src/workflow/checkpoint.ts` and is the only caller that restores
 * anything.
 *
 * Three properties, each chosen because the alternative loses user work:
 *
 * 1. **Untracked files are included.** `git stash create` (the Pi example this
 *    extends) records only tracked content, so a checkpoint taken before a
 *    worker runs and restored afterwards would silently drop every file the
 *    worker — or the user — newly created. A checkpoint here is a real commit
 *    object built from a *temporary index* with `git add -A`, so new files are
 *    in the tree.
 * 2. **Nothing the user can see is touched.** Capture writes one object and
 *    one ref under `refs/korwf/checkpoints/`. It does not move `HEAD`, does
 *    not write the repository index, does not modify the working tree, and
 *    never appears in `git stash list`. A capture is therefore safe in any
 *    tree, including the user's.
 * 3. **Restore is refused for a tree this module was not given explicitly.**
 *    `restoreCheckpointTree` takes the worktree path it is to operate on and
 *    performs no search; `worktreeIdentity` is what the policy layer uses to
 *    prove that path is not the user's main tree.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { parsePorcelain, type WorkingTreeChange } from "./revision.ts";

/** Ref namespace for checkpoints. Never `refs/heads/`, never `refs/stash`. */
export const CHECKPOINT_REF_NAMESPACE = "refs/korwf/checkpoints";

/**
 * A git invocation surface that can also set environment variables.
 *
 * `GitRunner` from `status.ts` is structurally assignable to this (a
 * two-parameter function satisfies a three-parameter signature), so existing
 * stubs keep working; they simply ignore `env`, which only the temporary-index
 * capture path uses.
 */
export interface GitEnvRunner {
  run(args: readonly string[], cwd: string, env?: Readonly<Record<string, string>>): string;
}

/** Runs `git` with an optional environment overlay. Never touches the network. */
export const realGitEnvRunner: GitEnvRunner = {
  run(args, cwd, env) {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    });
  },
};

/** Why a checkpoint was taken. Mirrors `CheckpointKind` in the store. */
export const CHECKPOINT_KINDS = ["pre_attempt", "post_step", "pre_rollback_preservation", "manual"] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

/** Where a checkpoint lives, once captured. */
export interface CapturedCheckpoint {
  readonly ref: string;
  readonly commit: string;
  readonly tree: string;
  /** `HEAD` at capture time, or `null` in a repository with no commits. */
  readonly parentCommit: string | null;
  readonly branch: string | null;
  /** `true` when the working tree had uncommitted changes when captured. */
  readonly dirty: boolean;
  /** Porcelain entries at capture time, so the record explains what it holds. */
  readonly changes: readonly WorkingTreeChange[];
}

/** Identity of a working tree, used to prove one tree is not another. */
export interface WorktreeIdentity {
  readonly toplevel: string;
  /** `--git-common-dir`: shared between a repository and all its worktrees. */
  readonly commonDir: string;
  /** `--git-dir`: per-worktree, so it differs between linked worktrees. */
  readonly gitDir: string;
  readonly isLinkedWorktree: boolean;
}

/** Reason codes for a refused or failed checkpoint operation. */
export const CHECKPOINT_ERROR_CODES = [
  "not_a_repository",
  "checkpoint_missing",
  "different_repository",
  "git_failed",
] as const;
export type CheckpointErrorCode = (typeof CHECKPOINT_ERROR_CODES)[number];

/** A checkpoint operation that could not be performed. Never a silent no-op. */
export class CheckpointError extends Error {
  readonly code: CheckpointErrorCode;
  constructor(code: CheckpointErrorCode, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
  }
}

function run(runner: GitEnvRunner, args: readonly string[], cwd: string, env?: Record<string, string>): string {
  return runner.run(args, cwd, env).trim();
}

function tryRun(runner: GitEnvRunner, args: readonly string[], cwd: string): string | null {
  try {
    return run(runner, args, cwd);
  } catch {
    return null;
  }
}

/**
 * Identify the working tree at `cwd`.
 *
 * `--git-common-dir` is the same string for a repository and every linked
 * worktree of it; `--git-dir` is not. That pair is what lets the policy layer
 * assert "this checkpoint belongs to the same repository, but is *not* the
 * user's main tree" without comparing paths by hand.
 */
export function worktreeIdentity(cwd: string, runner: GitEnvRunner = realGitEnvRunner): WorktreeIdentity | null {
  const toplevel = tryRun(runner, ["rev-parse", "--show-toplevel"], cwd);
  if (toplevel === null) return null;
  const gitDir = tryRun(runner, ["rev-parse", "--absolute-git-dir"], toplevel);
  const commonDirRaw = tryRun(runner, ["rev-parse", "--path-format=absolute", "--git-common-dir"], toplevel);
  if (gitDir === null) return null;
  const commonDir = commonDirRaw ?? gitDir;
  return { toplevel, commonDir, gitDir, isLinkedWorktree: commonDir !== gitDir };
}

/** Do these two trees belong to the same repository? */
export function sameRepository(a: WorktreeIdentity, b: WorktreeIdentity): boolean {
  return a.commonDir === b.commonDir;
}

/** Are these the same working tree (the check that stops a rollback of the user's tree)? */
export function sameWorktree(a: WorktreeIdentity, b: WorktreeIdentity): boolean {
  return a.gitDir === b.gitDir || a.toplevel === b.toplevel;
}

/** The ref a checkpoint with this id lives at. */
export function checkpointRef(checkpointId: string): string {
  return `${CHECKPOINT_REF_NAMESPACE}/${checkpointId}`;
}

/** Options for `captureCheckpoint`. */
export interface CaptureCheckpointOptions {
  /** Working tree to snapshot. Must be inside a repository. */
  readonly cwd: string;
  /** Stable id; becomes the ref name. Callers use the attempt id. */
  readonly checkpointId: string;
  /** One line recorded as the commit message, plus the structured trailer. */
  readonly message: string;
  readonly runner?: GitEnvRunner;
  /** Directory for the temporary index file; defaults to the git dir. */
  readonly tempDir?: string;
}

/**
 * Snapshot the working tree at `cwd` into a commit on a KorWF ref.
 *
 * The snapshot is built in a **temporary index** (`GIT_INDEX_FILE`), so the
 * repository's own index — which may hold the user's carefully staged
 * changes — is never written. `git add -A` against that temporary index picks
 * up modifications, deletions *and untracked files*, which is the whole
 * reason this does not use `git stash create`.
 *
 * Afterwards the working tree is byte-for-byte what it was: no checkout, no
 * reset, no stash entry, and `HEAD` is where it was. The only new things in
 * the repository are unreachable-from-`HEAD` objects and one ref under
 * `refs/korwf/checkpoints/`.
 */
export function captureCheckpoint(options: CaptureCheckpointOptions): CapturedCheckpoint {
  const runner = options.runner ?? realGitEnvRunner;
  const identity = worktreeIdentity(options.cwd, runner);
  if (identity === null) throw new CheckpointError("not_a_repository", `${options.cwd} is not inside a git repository`);
  const root = identity.toplevel;

  const parentCommit = tryRun(runner, ["rev-parse", "HEAD"], root);
  const branchRaw = tryRun(runner, ["rev-parse", "--abbrev-ref", "HEAD"], root);
  const porcelain = tryRun(runner, ["status", "--porcelain"], root);
  const changes = porcelain === null ? [] : parsePorcelain(porcelain);

  const indexFile = join(
    options.tempDir ?? identity.gitDir,
    `korwf-checkpoint-${randomBytes(8).toString("hex")}.index`,
  );
  const env = { GIT_INDEX_FILE: indexFile };
  let tree: string;
  try {
    // Seed from HEAD when there is one so unchanged paths are already staged,
    // then `add -A` folds in every difference including untracked files.
    if (parentCommit !== null && parentCommit.length > 0) {
      run(runner, ["read-tree", parentCommit], root, env);
    }
    run(runner, ["add", "-A", "--", "."], root, env);
    tree = run(runner, ["write-tree"], root, env);
  } finally {
    // The temporary index is scratch space; leaving it behind would be litter
    // inside the user's `.git`.
    rmSync(indexFile, { force: true });
    rmSync(`${indexFile}.lock`, { force: true });
  }

  const body = `${options.message}\n\nkorwf-checkpoint-id: ${options.checkpointId}\n`;
  const commitArgs = ["commit-tree", tree, "-m", body];
  if (parentCommit !== null && parentCommit.length > 0) commitArgs.push("-p", parentCommit);
  const commit = run(runner, commitArgs, root, checkpointAuthorEnv());

  const ref = checkpointRef(options.checkpointId);
  run(runner, ["update-ref", ref, commit], root);

  return {
    ref,
    commit,
    tree,
    parentCommit: parentCommit === null || parentCommit.length === 0 ? null : parentCommit,
    branch: branchRaw === null || branchRaw.length === 0 || branchRaw === "HEAD" ? null : branchRaw,
    dirty: changes.length > 0,
    changes,
  };
}

/**
 * Identity used for checkpoint commits.
 *
 * Fixed and fabricated rather than inherited: a checkpoint is machinery, not
 * authorship, and a repository with no `user.email` configured must still be
 * able to take one. `.invalid` is reserved by RFC 2606, so this can never be
 * a real address, and no machine-specific value appears in shipped code.
 */
function checkpointAuthorEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: "KorWF",
    GIT_AUTHOR_EMAIL: "korwf@localhost.invalid",
    GIT_COMMITTER_NAME: "KorWF",
    GIT_COMMITTER_EMAIL: "korwf@localhost.invalid",
  };
}

/** Does this checkpoint commit still exist in the repository at `cwd`? */
export function checkpointExists(cwd: string, commit: string, runner: GitEnvRunner = realGitEnvRunner): boolean {
  if (commit.trim().length === 0) return false;
  return tryRun(runner, ["cat-file", "-e", `${commit}^{commit}`], cwd) !== null;
}

/** One path a restore would change, and how. */
export interface CheckpointDiffEntry {
  /** Git name-status letter: `A`, `M`, `D`, `R`… */
  readonly status: string;
  readonly path: string;
}

/**
 * What restoring `commit` into the tree at `cwd` would change, computed
 * against the tree as it is now (index + working tree, untracked included).
 *
 * Read-only: this is the input to the proposal a human is asked to approve,
 * so it must be obtainable without performing any part of the rollback.
 */
export function diffAgainstCheckpoint(
  cwd: string,
  commit: string,
  runner: GitEnvRunner = realGitEnvRunner,
): readonly CheckpointDiffEntry[] {
  const identity = worktreeIdentity(cwd, runner);
  if (identity === null) throw new CheckpointError("not_a_repository", `${cwd} is not inside a git repository`);
  if (!checkpointExists(identity.toplevel, commit, runner)) {
    throw new CheckpointError("checkpoint_missing", `checkpoint commit ${commit} is not in this repository`);
  }
  // Compare the checkpoint tree against a freshly written tree of *now*, so
  // untracked files show up as deletions-if-restored rather than being
  // invisible (which is precisely the data loss this issue is about).
  const current = captureCheckpoint({
    cwd: identity.toplevel,
    checkpointId: `diff-${randomBytes(6).toString("hex")}`,
    message: "korwf: transient tree for diff",
    runner,
  });
  try {
    const out = tryRun(runner, ["diff", "--name-status", "--no-renames", `${current.tree}`, `${commit}^{tree}`], identity.toplevel);
    if (out === null) throw new CheckpointError("git_failed", "git diff could not compare the checkpoint");
    return parseNameStatus(out);
  } finally {
    // The transient snapshot is not a checkpoint; it must not linger as a ref.
    tryRun(runner, ["update-ref", "-d", current.ref], identity.toplevel);
  }
}

/** Result of restoring a checkpoint into a working tree. */
export interface RestoreResult {
  readonly ref: string;
  readonly commit: string;
  /** Snapshot of the tree as it was immediately *before* the restore. */
  readonly preservation: CapturedCheckpoint;
  readonly changedPaths: readonly string[];
}

/** Options for `restoreCheckpointTree`. */
export interface RestoreCheckpointOptions {
  /** The worktree to restore into. Never searched for; always passed in. */
  readonly cwd: string;
  readonly commit: string;
  /** Id for the safety checkpoint taken of the pre-restore state. */
  readonly preservationId: string;
  readonly runner?: GitEnvRunner;
}

/**
 * Restore the tree recorded in `commit` into the working tree at `cwd`.
 *
 * Two things happen before any file is touched:
 *
 *  - the *current* state of that tree is itself captured as a checkpoint, so
 *    even an approved rollback is reversible. A rollback that cannot be
 *    undone is indistinguishable from data loss;
 *  - the diff is computed, so the caller records what actually changed.
 *
 * The restore is two `read-tree` steps, and the first one matters: the index
 * is first set to the *preservation* tree, which (like every checkpoint here)
 * has untracked files staged in it. Only then does `read-tree -u --reset` of
 * the checkpoint tree remove files created since — `--reset` deletes what the
 * old index held and the new one does not, and a file git never knew about is
 * not in the old index. Without the seeding step a restore would silently
 * leave behind exactly the files the proposal told the user it would delete.
 * Everything it removes is in the preservation checkpoint, which is why this
 * is safe. Files ignored by `.gitignore` are in neither tree and are never
 * touched.
 *
 * This function performs no authorisation of its own. It is unexported from
 * the package barrel's point of view *as policy*: `src/workflow/checkpoint.ts`
 * is the only caller, and that module refuses without an approval record.
 */
export function restoreCheckpointTree(options: RestoreCheckpointOptions): RestoreResult {
  const runner = options.runner ?? realGitEnvRunner;
  const identity = worktreeIdentity(options.cwd, runner);
  if (identity === null) throw new CheckpointError("not_a_repository", `${options.cwd} is not inside a git repository`);
  const root = identity.toplevel;
  if (!checkpointExists(root, options.commit, runner)) {
    throw new CheckpointError("checkpoint_missing", `checkpoint commit ${options.commit} is not in this repository`);
  }

  const preservation = captureCheckpoint({
    cwd: root,
    checkpointId: options.preservationId,
    message: "korwf: state preserved immediately before a rollback",
    runner,
  });

  const diff = tryRun(
    runner,
    ["diff", "--name-only", "--no-renames", preservation.tree, `${options.commit}^{tree}`],
    root,
  );
  const changedPaths = diff === null ? [] : diff.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);

  try {
    // Step 1: index := the tree as it is now (untracked files included). No
    // `-u`, so nothing on disk changes — the working tree already matches it.
    run(runner, ["read-tree", "--reset", preservation.tree], root);
    // Step 2: index *and* working tree := the checkpoint. Tracked
    // modifications revert and anything added since is removed.
    run(runner, ["read-tree", "-u", "--reset", `${options.commit}^{tree}`], root);
  } catch (error) {
    throw new CheckpointError("git_failed", `restore failed: ${(error as Error).message}`);
  }

  return { ref: checkpointRef(options.preservationId), commit: options.commit, preservation, changedPaths };
}

/** Delete a checkpoint ref. The commit object stays until git prunes it. */
export function dropCheckpointRef(cwd: string, ref: string, runner: GitEnvRunner = realGitEnvRunner): boolean {
  return tryRun(runner, ["update-ref", "-d", ref], cwd) !== null;
}

/** Parse `git diff --name-status` output. */
export function parseNameStatus(output: string): readonly CheckpointDiffEntry[] {
  const entries: CheckpointDiffEntry[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const [status, ...rest] = line.split("\t");
    const path = rest[rest.length - 1];
    if (status === undefined || path === undefined || path.length === 0) continue;
    entries.push({ status: status.trim(), path: path.trim() });
  }
  return entries;
}
