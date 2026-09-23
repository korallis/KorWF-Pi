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
import type { IntegrationItemRow, IntegrationConflictRow } from "../storage/integration-queue.ts";
import type { TransitionActor } from "../storage/transition-log.ts";
import { baseRelation, mergeBranch, resolveRef, MergeError, type MergeOutcome } from "../git/merge.ts";
import { realGitEnvRunner, type GitEnvRunner } from "../git/checkpoint.ts";
import { isDrift, type RevisionRelation } from "../git/revision.ts";
import { invalidateStaleEvidence, type WorktreeChangeSet } from "../verification/invalidate.ts";
import { raisePhaseBlocker } from "./blockers.ts";
import { requestApproval, type RequestApprovalResult } from "./approvals.ts";
import { join } from "node:path";
import { acquireLock, readLockfile, type LockfileContents, type LockHandle } from "../storage/lock.ts";
import { StoreLockedError } from "../storage/errors.ts";

/** Blocker kind raised when a conflict cannot be resolved (AC2). */
export const INTEGRATION_CONFLICT_BLOCKER = "integration_conflict";

/** Approval class a promotion to the user's branch is classified as. */
export const MERGE_TO_USER_BRANCH_CLASS = "remote_push" as const;

/**
 * The integration branch for a phase: `korwf/<workflow>/<phase>` (issue #78
 * Scope). Deterministic, namespaced, and never the user's branch — the
 * `korwf/` prefix is what makes "is this a ref the workflow owns?" decidable
 * by a string check in #15's `refOwnedByWorkflow`.
 */
export function integrationBranch(workflowId: WorkflowId, phaseId: PhaseId): string {
  return `korwf/${workflowId}/${phaseId}`;
}

/** `true` when `branch` is an integration branch this workflow owns. */
export function isWorkflowOwnedRef(branch: string, workflowId: WorkflowId): boolean {
  return branch === `korwf/${workflowId}` || branch.startsWith(`korwf/${workflowId}/`);
}

// ---------------------------------------------------------------------------
// The integration lease: "one integration owner"
// ---------------------------------------------------------------------------

/** An owned right to integrate. Release it when the drain stops. */
export interface IntegrationLease {
  readonly path: string;
  readonly holder: LockfileContents;
  /** `false` once released or displaced. */
  isOwned(): boolean;
  release(): void;
}

/** Raised when another live integrator already owns the right to merge. */
export class IntegrationBusyError extends Error {
  readonly code = "KORWF_INTEGRATION_BUSY";
  readonly holder: LockfileContents;
  constructor(holder: LockfileContents) {
    super(
      `Integration is owned by pid ${holder.pid}${
        holder.sessionId === undefined ? "" : ` (session ${holder.sessionId})`
      } since ${holder.startedAt}. One integrator merges at a time (PLAN §3.E).`,
    );
    this.name = "IntegrationBusyError";
    this.holder = holder;
  }
}

/** Path of the integration lease file, beside the coordinator lock. */
export function integrationLockPath(storageRoot: string): string {
  return join(storageRoot, "korwf-integration.lock");
}

export interface AcquireIntegrationLeaseOptions {
  readonly storageRoot: string;
  readonly sessionId?: string;
  readonly pid?: number;
  readonly now?: () => string;
  /** Liveness probe; defaults to `process.kill(pid, 0)`. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /** How long to wait for a live owner before refusing. Default: do not wait. */
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => void;
}

/**
 * Take the exclusive right to integrate, or refuse.
 *
 * This is the #77 lock *mechanism* pointed at a second file, not a second
 * implementation of it: `acquireLock` creates the file under `O_EXCL`, so two
 * integrators racing produce exactly one winner, and it treats a holder whose
 * **pid is dead** as stale — a crashed integrator does not wedge the phase
 * forever, and a live one is never displaced by a timer.
 *
 * It is a *separate* file from the coordinator lock on purpose. The
 * coordinator owns the right to schedule; this owns the right to merge. One
 * process usually holds both, but a run that is only draining an integration
 * queue does not need scheduling rights, and a takeover of one must not
 * silently confer the other.
 */
export function acquireIntegrationLease(options: AcquireIntegrationLeaseOptions): IntegrationLease {
  const path = integrationLockPath(options.storageRoot);
  let handle: LockHandle;
  try {
    handle = acquireLock(path, {
      ...(options.pid === undefined ? {} : { pid: options.pid }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      timeoutMs: options.timeoutMs ?? 0,
    });
  } catch (error) {
    if (error instanceof StoreLockedError) {
      let holder: LockfileContents;
      try {
        holder = readLockfile(path);
      } catch {
        throw error;
      }
      throw new IntegrationBusyError(holder);
    }
    throw error;
  }
  let owned = true;
  return {
    path: handle.path,
    holder: handle.contents,
    isOwned: () => owned,
    release(): void {
      owned = false;
      // `LockHandle.release` refuses to remove a file whose pid/startedAt
      // differ, so a lease taken over from us stays with its new owner.
      handle.release();
    },
  };
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface EnqueueIntegrationOptions {
  readonly store: Store;
  readonly task: Task;
  /** Branch holding the task's completed work (its worktree branch). */
  readonly branch: string;
  /** Revision the task worktree was created from. */
  readonly baseRevision: GitSha;
  /** Revision the task's evidence was captured at (#45). */
  readonly verifiedRevision: GitSha;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
}

/**
 * Append a completed task to its phase's integration queue.
 *
 * Enqueueing is *not* integrating and carries no authority: the item records
 * which revisions the work was verified against so that the integrator, which
 * may run much later, can discover that the base moved. A task already
 * waiting or being integrated is returned unchanged rather than queued twice
 * — two dispatches of the same work must not become two merges.
 */
export function enqueueIntegration(options: EnqueueIntegrationOptions): IntegrationItemRow {
  const { store, task } = options;
  return store.write(() => {
    const existing = store.integrations
      .forPhase(task.phaseId)
      .find((item) => item.taskId === task.id && (item.status === "queued" || item.status === "integrating"));
    if (existing !== undefined) return existing;
    return store.integrations.enqueue({
      itemId: options.newId(),
      enqueuedAt: options.now(),
      workflowId: task.workflowId,
      phaseId: task.phaseId,
      taskId: task.id,
      taskRevision: task.revision,
      branch: options.branch,
      baseRevision: options.baseRevision,
      verifiedRevision: options.verifiedRevision,
      status: "queued",
      detail: null,
    });
  });
}

// ---------------------------------------------------------------------------
// Base-revision check
// ---------------------------------------------------------------------------

/** Verdict on whether an item's recorded base still matches the integration branch. */
export interface BaseRevisionCheck {
  /** `true` only when the base is unchanged and the evidence therefore still applies. */
  readonly current: boolean;
  /** Where the integration branch is now; `null` when the branch does not exist yet. */
  readonly integrationHead: string | null;
  /** Ancestry relation from `src/git/`; `indeterminate` when git could not answer. */
  readonly relation: RevisionRelation;
  readonly detail: string;
}

/**
 * Has the integration base moved since this work was verified?
 *
 * The comparison is ancestry from `src/git/revision.ts`, not a string
 * compare, and `indeterminate` — what a git failure produces — counts as
 * movement. The rule is one-directional on purpose: any relation other than
 * `"same"` means the evidence recorded at `verifiedRevision` was produced
 * against a tree that is no longer the base, so #50 already calls it stale
 * and the work must be **re-verified, not merged on trust**.
 *
 * A branch that does not exist yet is not drift: the first integration into
 * a fresh phase branch starts from the recorded base by construction.
 */
export function checkBaseRevision(options: {
  readonly repoCwd: string;
  readonly item: Pick<IntegrationItemRow, "baseRevision" | "verifiedRevision">;
  readonly integrationBranch: string;
  readonly runner?: GitEnvRunner;
}): BaseRevisionCheck {
  const runner = options.runner ?? realGitEnvRunner;
  const head = resolveRef(options.repoCwd, options.integrationBranch, runner);
  if (head === null) {
    return {
      current: true,
      integrationHead: null,
      relation: "same",
      detail: `integration branch ${options.integrationBranch} does not exist yet; the recorded base is still the base`,
    };
  }
  const relation = baseRelation(options.repoCwd, options.item.baseRevision, head, runner);
  if (!isDrift(relation)) {
    return { current: true, integrationHead: head, relation, detail: `base ${options.item.baseRevision} is current` };
  }
  return {
    current: false,
    integrationHead: head,
    relation,
    detail:
      `integration base moved (${relation}): work was verified at ${options.item.verifiedRevision} ` +
      `against base ${options.item.baseRevision}, but ${options.integrationBranch} is now at ${head}`,
  };
}
