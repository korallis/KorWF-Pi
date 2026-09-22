/**
 * Status, checkpoints, worktrees, conflicts (all git invocations) (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * `status.ts` (issue #33) is the first tenant: repository identity detection
 * for `/korwf plan`. `revision.ts` (issue #42) reads the live `HEAD`, branch
 * and working-tree state and relates a recorded revision to it, which is what
 * session reconciliation compares persisted state against. Later issues add
 * checkpoints, worktrees, and conflicts.
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
