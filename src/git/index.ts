/**
 * Status, checkpoints, worktrees, conflicts (all git invocations) (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * `status.ts` (issue #33) is the first tenant: repository identity detection
 * for `/korwf plan`. `revision.ts` (issue #42) reads the live `HEAD`, branch
 * and working-tree state and relates a recorded revision to it, which is what
 * session reconciliation compares persisted state against. `checkpoint.ts`
 * (issue #54) captures a working tree — untracked files included — into a
 * commit on a `refs/korwf/checkpoints/` ref without touching `HEAD`, the
 * index, the stash list or the working tree, and restores one into an
 * explicitly named worktree. Later issues add worktrees and conflicts.
 *
 * **Re-export style:** explicit here (this barrel predates the `export *`
 * convention) but additive — append a block rather than editing one.
 */
export { detectRepoIdentity, normaliseRemoteUrl, realGitRunner, EMPTY_REPO_NO_HEAD } from "./status.ts";
export type { GitRunner, RepoDetection, RepoIdentity } from "./status.ts";
export {
  compareRevisions,
  isDrift,
  parsePorcelain,
  readLiveRepoState,
  revisionExists,
  MAX_REPORTED_CHANGES,
} from "./revision.ts";
export type { LiveRepoState, RevisionRelation, WorkingTreeChange } from "./revision.ts";
export {
  captureCheckpoint,
  checkpointExists,
  checkpointRef,
  diffAgainstCheckpoint,
  dropCheckpointRef,
  parseNameStatus,
  realGitEnvRunner,
  restoreCheckpointTree,
  sameRepository,
  sameWorktree,
  worktreeIdentity,
  CheckpointError,
  CHECKPOINT_ERROR_CODES,
  CHECKPOINT_KINDS,
  CHECKPOINT_REF_NAMESPACE,
} from "./checkpoint.ts";
export type {
  CapturedCheckpoint,
  CaptureCheckpointOptions,
  CheckpointDiffEntry,
  CheckpointErrorCode,
  CheckpointKind,
  GitEnvRunner,
  RestoreCheckpointOptions,
  RestoreResult,
  WorktreeIdentity,
} from "./checkpoint.ts";
export {
  addWorktree,
  listWorktrees,
  removeWorktree,
  WorktreeError,
  WORKTREE_ERROR_CODES,
} from "./worktree.ts";
export type {
  AddWorktreeOptions,
  CreatedWorktree,
  RemoveWorktreeOptions,
  WorktreeErrorCode,
  WorktreeListEntry,
} from "./worktree.ts";
