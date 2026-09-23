/**
 * Single-owner integration queue, base-revision validation, and the
 * merge-conflict workflow (issue #78; PLAN §3.E, §2.1).
 *
 * > Separate Git worktrees for parallel writing workers; **one integration
 * > owner; never concurrent uncontrolled integration into the user's tree.**
 *
 * Three rules, each enforced by a mechanism rather than by convention:
 *
 * 1. **One owner integrates at a time.** Two tasks finishing simultaneously
 *    do not both merge: `enqueueIntegration` appends to a durable FIFO and
 *    `integrateNext` may only run while holding the *integration lease*,
 *    which is the #77 coordinator lockfile mechanism pointed at a second
 *    file. An in-process boolean would not survive two coordinator
 *    processes; a lockfile whose liveness is decided by the holder's pid
 *    does. `runIntegrationQueue` therefore drains the queue strictly
 *    sequentially even when its items arrive at the same instant.
 * 2. **A moved base invalidates the evidence.** #45 records the exact
 *    revision each check ran at. `checkBaseRevision` compares the item's
 *    recorded base with where the integration branch actually is now, using
 *    `src/git/`'s ancestry (never a string compare), and a base that has
 *    moved produces `stale_base` — which sends the task back to `verifying`
 *    through #50's `invalidateStaleEvidence`. It is never merged on trust,
 *    and a git failure reads as movement, not as freshness.
 * 3. **A conflict is a workflow.** `mergeBranch` leaves the integration
 *    worktree clean and names the conflicted paths; this module turns those
 *    into a bounded `ConflictResolution` whose ownership is restricted to
 *    exactly those paths, requires re-verification, and — when unresolved —
 *    blocks the phase with a notification payload rather than discarding
 *    anything.
 *
 * The user's branch is not touched here at all. Integration lands on
 * `korwf/<workflow>/<phase>`; promoting that to the user's branch is
 * `proposeUserBranchMerge`, which only ever *requests* the
 * `merge_to_user_branch` approval class and never performs the merge.
 */
import type { GitSha, IsoTimestamp, PhaseId, Task, TaskId, WorkflowId } from "../storage/records.ts";
import type { Store } from "../storage/db.ts";

/** Where an integration item is in its lifecycle. */
export type IntegrationItemStatus =
  | "queued"
  | "integrating"
  | "integrated"
  | "conflicted"
  | "stale_base"
  | "failed"
  | "cancelled";

/** One task's request to be integrated into its phase's integration branch. */
export interface IntegrationItem {
  readonly itemId: string;
  readonly workflowId: WorkflowId;
  readonly phaseId: PhaseId;
  readonly taskId: TaskId;
  /** `Task.revision` the work was verified at (#45). */
  readonly taskRevision: number;
  /** Branch holding the task's completed work. */
  readonly branch: string;
  /** Revision the task's worktree was created from, and verified against. */
  readonly baseRevision: GitSha;
  /** Exact revision the evidence was captured at (#45). */
  readonly verifiedRevision: GitSha;
  readonly enqueuedAt: IsoTimestamp;
  readonly status: IntegrationItemStatus;
  readonly detail: string | null;
}
