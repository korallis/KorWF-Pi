/**
 * Checkpoints and rollback **proposals** (issue #54; PLAN §3.G "Checkpoints
 * and approval policy for rollback; preserve uncommitted user work"; PLAN §10
 * "worktrees remain recoverable; dirty user changes preserved").
 *
 * The clause that governs every line of this file is the last one: *preserve
 * uncommitted user work*. A rollback that discards a user's uncommitted
 * changes is data loss, and no Jev score, no worker claim and no recovery
 * ladder may authorise it. So the shape here is not "roll back, carefully" —
 * it is:
 *
 *  1. **Capture is always allowed; restore almost never is.** `takeCheckpoint`
 *     is read-only with respect to everything the user can see (`src/git/
 *     checkpoint.ts` builds the snapshot in a temporary index), so it can run
 *     before every attempt and after every verified step in any tree.
 *  2. **A rollback is a proposal.** `proposeRollback` writes a row describing
 *     what would change and, specifically, **what would be lost**, then queues
 *     a `destructive_git` approval request. `destructive_git` is one of the
 *     seven PLAN §7 high-risk classes: `stop` in every mode, un-configurable
 *     down (V10), and grantable only by a `user` actor (#49).
 *  3. **`applyRollback` refuses without an approval record.** It does not take
 *     a boolean, a score, or a claim; it re-reads the `Approval` rows through
 *     `isActionApproved` (#49) at call time. The database refuses the same
 *     thing independently (`0010-checkpoints.sql`), so raw SQL cannot get
 *     round it either.
 *  4. **The user's main tree is never a rollback target.** Restoring a tree
 *     deletes files the checkpoint does not contain, and the user's
 *     uncommitted work is exactly that. `targetIsMainTree` is computed from
 *     git's own `--git-dir`/`--git-common-dir` pair, refused in code, and
 *     refused again by a trigger.
 *  5. **A rollback is never replayed.** Every proposal carries an `actionId`
 *     (#42 `actionIdFor`) and goes through `guardAction`, so a forked or
 *     resumed conversation replaying the turn is refused with a notice
 *     instead of restoring a stale tree over newer work.
 *  6. **Even an approved rollback is reversible.** The restore path captures
 *     the target tree *first*, as a `pre_rollback_preservation` checkpoint,
 *     so the state the rollback discards remains addressable afterwards.
 *
 * Git is never invoked here: this module calls `src/git/checkpoint.ts`
 * (ADR 0002).
 */
import type { Store } from "../storage/db.ts";
import type { IsoTimestamp, TaskId, WorkflowId } from "../storage/records.ts";
import type {
  CheckpointRecordKind,
  CheckpointRow,
  RollbackProposalRow,
} from "../storage/checkpoints.ts";
import { actionIdFor } from "../storage/action-log.ts";
import { readLiveRepoState } from "../git/revision.ts";
import {
  captureCheckpoint,
  diffAgainstCheckpoint,
  restoreCheckpointTree,
  worktreeIdentity,
  CheckpointError,
  type CapturedCheckpoint,
  type CheckpointDiffEntry,
  type GitEnvRunner,
  type WorktreeIdentity,
} from "../git/checkpoint.ts";

/** The high-risk approval class a rollback is, always. PLAN §7. */
export const ROLLBACK_APPROVAL_CLASS = "destructive_git" as const;

/** `permittedAction` prefix, so one grant cannot authorise a different rollback. */
export const ROLLBACK_ACTION_PREFIX = "rollback_checkpoint";

/** The action namespace used for the #42 receipt of an applied rollback. */
export const ROLLBACK_ACTION_KIND = "git_rollback";

/** `permittedAction` for one specific proposal. */
export function rollbackPermittedAction(proposalId: string): string {
  return `${ROLLBACK_ACTION_PREFIX}:${proposalId}`;
}

// ---------------------------------------------------------------------------
// Dirty-tree guard (ADR 0001 row 7, `dirty-repo-guard.ts`)
// ---------------------------------------------------------------------------

/** What a dirty-tree inspection found. Facts only; the decision is separate. */
export interface DirtyTreeReport {
  readonly isRepository: boolean;
  readonly toplevel: string | null;
  readonly dirty: boolean;
  /** Paths with uncommitted changes, capped by `MAX_REPORTED_CHANGES`. */
  readonly paths: readonly string[];
  /** `true` when this tree is a linked worktree rather than the main one. */
  readonly isLinkedWorktree: boolean;
}

/**
 * Inspect a working tree for uncommitted changes, without touching it.
 *
 * The Pi example's default when it could not ask a human was to **block**,
 * and ADR 0001 row 7 calls that "already the one PLAN §2.6 wants". The same
 * default is kept here by construction: this function reports, the callers
 * below refuse, and there is no parameter that turns the refusal off.
 *
 * A path that is not a repository is reported as `isRepository: false` and
 * *not* as clean, so "we could not tell" can never read as "nothing to lose".
 */
export function inspectTree(cwd: string, runner?: GitEnvRunner): DirtyTreeReport {
  const identity = worktreeIdentity(cwd, runner);
  if (identity === null) {
    return { isRepository: false, toplevel: null, dirty: false, paths: [], isLinkedWorktree: false };
  }
  // Capture is the cheapest honest way to enumerate *all* differences
  // including untracked files, but it writes a ref; use the read-only status
  // read from `revision.ts` instead, which `git/` already owns.
  const state = readTreeState(identity, runner);
  return {
    isRepository: true,
    toplevel: identity.toplevel,
    dirty: state.dirty,
    paths: state.paths,
    isLinkedWorktree: identity.isLinkedWorktree,
  };
}

function readTreeState(
  identity: WorktreeIdentity,
  runner?: GitEnvRunner,
): { dirty: boolean; paths: readonly string[] } {
  // `readLiveRepoState` takes the `GitRunner` shape from `status.ts`; a
  // `GitEnvRunner` satisfies it (the extra parameter is optional on both
  // sides), so the one git surface serves both.
  const live = runner === undefined ? readLiveRepoState(identity.toplevel) : readLiveRepoState(identity.toplevel, runner);
  if (live.kind === "no_repo") return { dirty: false, paths: [] };
  return { dirty: live.dirty, paths: live.changes.map((c) => c.path) };
}

/**
 * Would acting on `cwd` risk the user's uncommitted work?
 *
 * `true` whenever the tree is dirty **or** git could not answer. Callers use
 * it as a precondition, never as advice.
 */
export function wouldRiskUserWork(report: DirtyTreeReport): boolean {
  return !report.isRepository || report.dirty;
}

// ---------------------------------------------------------------------------
// Taking a checkpoint
// ---------------------------------------------------------------------------

export interface TakeCheckpointOptions {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  /** The worktree to snapshot. The user's main tree is permitted here. */
  readonly cwd: string;
  readonly kind: CheckpointRecordKind;
  /** Attempt this checkpoint is tagged with (issue #54 Scope). */
  readonly attemptId?: string | null;
  readonly taskId?: TaskId | string | null;
  readonly summary?: string;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
  /** Identity of the user's main tree, when it is known; see `isMainTree`. */
  readonly mainTree?: WorktreeIdentity | null;
  readonly runner?: GitEnvRunner;
}

/** A checkpoint that was taken, both as a git object and as a durable row. */
export interface TakenCheckpoint {
  readonly row: CheckpointRow;
  readonly captured: CapturedCheckpoint;
}

/**
 * Snapshot a working tree and record it.
 *
 * Safe to call before a worker starts and after every verified step, in any
 * tree including the user's: `captureCheckpoint` writes one object and one
 * ref and leaves `HEAD`, the index, the stash list and every file exactly as
 * they were. Untracked files are included, so a later comparison can tell the
 * user that a rollback would delete the three files they just created — the
 * `git stash create` approach cannot (ADR 0001 row 5).
 */
export function takeCheckpoint(options: TakeCheckpointOptions): TakenCheckpoint {
  const identity = worktreeIdentity(options.cwd, options.runner);
  if (identity === null) {
    throw new CheckpointError("not_a_repository", `${options.cwd} is not inside a git repository`);
  }
  const checkpointId = options.newId();
  const summary = options.summary ?? defaultSummary(options.kind, options.attemptId ?? null);
  const captured = captureCheckpoint({
    cwd: identity.toplevel,
    checkpointId,
    message: `korwf checkpoint (${options.kind}): ${summary}`,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });

  const row: CheckpointRow = {
    checkpointId,
    createdAt: options.now(),
    workflowId: options.workflowId,
    attemptId: options.attemptId ?? null,
    taskId: (options.taskId ?? null) as string | null,
    kind: options.kind,
    worktreePath: identity.toplevel,
    repoCommonDir: identity.commonDir,
    isMainTree: isMainTree(identity, options.mainTree ?? null),
    ref: captured.ref,
    commitSha: captured.commit,
    treeSha: captured.tree,
    parentCommit: captured.parentCommit,
    branch: captured.branch,
    dirty: captured.dirty,
    changedPaths: captured.changes.length,
    summary,
  };
  options.store.write(() => options.store.checkpoints.insert(row));
  return { row, captured };
}

/**
 * Is this tree the user's main tree?
 *
 * When the caller names the main tree explicitly, that answer wins. Otherwise
 * the conservative structural answer is used: a tree whose `--git-dir` equals
 * its `--git-common-dir` is the repository's main tree, and a linked worktree
 * (what `/korwf run` creates for a worker) is not. The default therefore
 * errs towards "this is the user's tree", which is the direction that refuses
 * rather than the direction that deletes.
 */
export function isMainTree(tree: WorktreeIdentity, mainTree: WorktreeIdentity | null): boolean {
  if (mainTree !== null) return tree.gitDir === mainTree.gitDir || tree.toplevel === mainTree.toplevel;
  return !tree.isLinkedWorktree;
}

// ---------------------------------------------------------------------------
// Proposing a rollback
// ---------------------------------------------------------------------------

/** What a rollback would do, computed before anybody is asked to approve it. */
export interface RollbackImpact {
  readonly checkpointId: string;
  readonly worktreePath: string;
  readonly targetIsMainTree: boolean;
  /** Every path the restore would change, from `git diff --name-status`. */
  readonly entries: readonly CheckpointDiffEntry[];
  /**
   * Paths that exist now and not in the checkpoint: the restore deletes them.
   * This is the "what would be lost" the issue asks the proposal to carry.
   */
  readonly wouldDelete: readonly string[];
  /** Paths whose current content would be overwritten by older content. */
  readonly wouldOverwrite: readonly string[];
  /** Uncommitted paths in the target tree right now. */
  readonly uncommittedPaths: readonly string[];
  /** `true` when any uncommitted work is inside the blast radius. */
  readonly wouldLoseUncommitted: boolean;
}

/**
 * Compute the impact of restoring `checkpointId` into its worktree.
 *
 * Read-only: nothing is restored, nothing is staged, and the transient tree
 * object this uses to compare against "now" is not left behind as a ref. The
 * answer is the evidence a human is shown before deciding.
 */
export function computeRollbackImpact(options: {
  readonly store: Store;
  readonly checkpointId: string;
  /** Override the worktree; defaults to the one recorded on the checkpoint. */
  readonly cwd?: string;
  readonly mainTree?: WorktreeIdentity | null;
  readonly runner?: GitEnvRunner;
}): RollbackImpact {
  const checkpoint = options.store.checkpoints.find(options.checkpointId);
  if (checkpoint === undefined) {
    throw new CheckpointError("checkpoint_missing", `no checkpoint ${options.checkpointId}`);
  }
  const cwd = options.cwd ?? checkpoint.worktreePath;
  const identity = worktreeIdentity(cwd, options.runner);
  if (identity === null) throw new CheckpointError("not_a_repository", `${cwd} is not inside a git repository`);
  if (identity.commonDir !== checkpoint.repoCommonDir) {
    throw new CheckpointError(
      "different_repository",
      `checkpoint ${checkpoint.checkpointId} was taken in a different repository`,
    );
  }

  const entries = diffAgainstCheckpoint(identity.toplevel, checkpoint.commitSha, options.runner);
  // Direction matters: the diff is `current -> checkpoint`, so `D` means the
  // checkpoint does not have the path, i.e. restoring deletes it.
  const wouldDelete = entries.filter((e) => e.status.startsWith("D")).map((e) => e.path);
  const wouldOverwrite = entries.filter((e) => e.status.startsWith("M") || e.status.startsWith("T")).map((e) => e.path);
  const tree = inspectTree(identity.toplevel, options.runner);
  const touched = new Set(entries.map((e) => e.path));
  const uncommittedPaths = tree.paths;
  return {
    checkpointId: checkpoint.checkpointId,
    worktreePath: identity.toplevel,
    targetIsMainTree: isMainTree(identity, options.mainTree ?? null),
    entries,
    wouldDelete,
    wouldOverwrite,
    uncommittedPaths,
    wouldLoseUncommitted: uncommittedPaths.some((p) => touched.has(p)),
  };
}

/** One human-readable paragraph naming what a rollback would change and lose. */
export function describeImpact(impact: RollbackImpact): string {
  if (impact.entries.length === 0) {
    return `Rolling back to checkpoint ${impact.checkpointId} would change nothing: the worktree already matches it.`;
  }
  const lost =
    impact.wouldDelete.length === 0
      ? "no files would be deleted"
      : `${impact.wouldDelete.length} file(s) would be DELETED (${impact.wouldDelete.slice(0, 5).join(", ")}${
          impact.wouldDelete.length > 5 ? ", \u2026" : ""
        })`;
  const over =
    impact.wouldOverwrite.length === 0
      ? "no files would be overwritten"
      : `${impact.wouldOverwrite.length} file(s) would be overwritten with older content`;
  const uncommitted = impact.wouldLoseUncommitted
    ? ` UNCOMMITTED WORK IS AFFECTED: ${impact.uncommittedPaths.slice(0, 5).join(", ")}.`
    : "";
  return (
    `Rolling back to checkpoint ${impact.checkpointId} in ${impact.worktreePath} would change ` +
    `${impact.entries.length} path(s): ${lost}; ${over}.${uncommitted}`
  );
}

function defaultSummary(kind: CheckpointRecordKind, attemptId: string | null): string {
  const where = attemptId === null ? "" : ` for attempt ${attemptId}`;
  switch (kind) {
    case "pre_attempt":
      return `state before the attempt started${where}`;
    case "post_step":
      return `state after a verified step${where}`;
    case "pre_rollback_preservation":
      return `state preserved immediately before a rollback${where}`;
    case "manual":
      return `checkpoint requested by the user${where}`;
  }
}
