/**
 * Status, checkpoints, worktrees, conflicts (all git invocations) (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * `status.ts` (issue #33) is the first tenant: repository identity detection
 * for `/korwf plan`. Later issues add checkpoints, worktrees, and conflicts.
 */
export { detectRepoIdentity, normaliseRemoteUrl, realGitRunner, EMPTY_REPO_NO_HEAD } from "./status.ts";
export type { GitRunner, RepoDetection, RepoIdentity } from "./status.ts";
