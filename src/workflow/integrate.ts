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

/**
 * Approval class a promotion to the user's branch is classified as: the
 * high-risk `merge_to_user_branch` added to #15's table by this issue. It is
 * `stop` in every mode and schema-pinned there, so nothing in this module can
 * make the promotion automatic.
 */
export const MERGE_TO_USER_BRANCH_CLASS = "merge_to_user_branch" as const;

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

// ---------------------------------------------------------------------------
// Integrating one item
// ---------------------------------------------------------------------------

/** How one integration ended. */
export type IntegrationOutcome =
  | { readonly kind: "empty" }
  | { readonly kind: "integrated"; readonly item: IntegrationItemRow; readonly head: string; readonly merge: MergeOutcome }
  | { readonly kind: "stale_base"; readonly item: IntegrationItemRow; readonly check: BaseRevisionCheck }
  | {
      readonly kind: "conflict";
      readonly item: IntegrationItemRow;
      readonly conflict: IntegrationConflictRow;
      readonly resolution: ConflictResolution;
    }
  | { readonly kind: "failed"; readonly item: IntegrationItemRow; readonly detail: string };

/**
 * The bounded resolution task a conflict produces, or the refusal to make
 * one. Never a merge: resolving a conflict is work, and work is verified.
 */
export type ConflictResolution =
  | {
      readonly kind: "task";
      readonly taskId: TaskId;
      /** Exactly the conflicted paths; the resolver may write nothing else. */
      readonly paths: readonly string[];
      /** Always `true`: a resolution is re-verified before the item retries. */
      readonly requiresReverification: true;
    }
  | { readonly kind: "blocked"; readonly reason: string; readonly notification: ConflictNotification };

/** Payload handed to the notification sink when a conflict blocks the phase. */
export interface ConflictNotification {
  readonly event: "integration_conflict";
  readonly workflowId: WorkflowId;
  readonly phaseId: PhaseId;
  readonly taskId: TaskId;
  readonly itemId: string;
  readonly conflictId: string;
  readonly branch: string;
  readonly paths: readonly string[];
  readonly summary: string;
}

/**
 * Creates the bounded resolution task for a set of conflicted paths.
 *
 * Supplied by the caller because task creation belongs to the planner and
 * the worker layer, not here. Returning `null` means no resolver is
 * available, which blocks the phase — the deterministic fallback, and the
 * behaviour with no Jev key and no implementer role configured.
 */
export type ResolutionTaskFactory = (input: {
  readonly item: IntegrationItemRow;
  readonly paths: readonly string[];
  readonly integrationBranch: string;
}) => TaskId | null;

/** Where a notification is delivered. Never throws into the integrator. */
export type ConflictNotifier = (notification: ConflictNotification) => void;

export interface IntegrateNextOptions {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly phaseId: PhaseId;
  /** The integration worktree: a linked worktree on the integration branch. */
  readonly integrationWorktree: string;
  /** The lease proving this process owns integration. Checked, not assumed. */
  readonly lease: IntegrationLease;
  readonly actor: TransitionActor;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
  /** Creates the bounded conflict-resolution task; `null` ⇒ block the phase. */
  readonly resolutionTask?: ResolutionTaskFactory;
  readonly notify?: ConflictNotifier;
  readonly runner?: GitEnvRunner;
}

/** Raised when a caller tries to integrate without owning the lease. */
export class NotIntegrationOwnerError extends Error {
  readonly code = "KORWF_NOT_INTEGRATION_OWNER";
  constructor() {
    super("refusing to integrate: this process does not hold the integration lease (PLAN §3.E, one integration owner)");
    this.name = "NotIntegrationOwnerError";
  }
}

/**
 * Integrate the head of the phase's queue, or return `empty`.
 *
 * The order of events is the issue's requirement in code:
 *
 *  1. refuse unless this process holds the integration lease;
 *  2. claim the FIFO head atomically (`claimNext`), so a second integrator
 *     in another process cannot take the same item;
 *  3. check the base revision — a moved base settles the item `stale_base`
 *     and sends the task back to `verifying` through #50, without merging;
 *  4. merge, which fast-forwards when it can;
 *  5. on conflict, record it, create the bounded resolution task restricted
 *     to the conflicted paths, and — when none can be created — block the
 *     phase with a notification.
 *
 * The merge itself happens in the *integration* worktree. The user's branch
 * is never an argument to this function.
 */
export function integrateNext(options: IntegrateNextOptions): IntegrationOutcome {
  const { store, workflowId, phaseId } = options;
  if (!options.lease.isOwned()) throw new NotIntegrationOwnerError();

  const branch = integrationBranch(workflowId, phaseId);
  const item = store.write(() => store.integrations.claimNext(phaseId, options.now()));
  if (item === undefined) return { kind: "empty" };

  const check = checkBaseRevision({
    repoCwd: options.integrationWorktree,
    item,
    integrationBranch: branch,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
  if (!check.current) {
    const settled = store.integrations.settle(item.itemId, "stale_base", check.detail) ?? item;
    requireReverification({ ...options, item, check });
    return { kind: "stale_base", item: settled, check };
  }

  let merge: MergeOutcome;
  try {
    merge = mergeBranch({
      worktreePath: options.integrationWorktree,
      source: item.branch,
      message: `korwf: integrate ${item.taskId}@${item.taskRevision} into ${branch}`,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    });
  } catch (error) {
    const detail = error instanceof MergeError ? `${error.code}: ${error.message}` : (error as Error).message;
    const settled = store.integrations.settle(item.itemId, "failed", detail) ?? item;
    return { kind: "failed", item: settled, detail };
  }

  if (merge.kind === "conflict") {
    return openConflict({ ...options, item, merge, branch });
  }
  const settled = store.integrations.settle(item.itemId, "integrated", `${merge.kind} at ${merge.head}`) ?? item;
  return { kind: "integrated", item: settled, head: merge.head, merge };
}

/**
 * A stale base sends the task back to verification, through #50's
 * `invalidateStaleEvidence` — the module that already owns "which evidence
 * stopped being fresh, and does the task return to `verifying`".
 *
 * The change set is `unknown`: the integrator knows the base moved but not
 * which paths moved with it, and #50 defines `unknown` as invalidating
 * everything. Guessing a narrower set here would be the one way to merge
 * stale work on trust.
 *
 * Returns the ids of nothing and throws nothing: a task that is no longer in
 * a state with an invalidation edge (already `blocked`, `cancelled`) simply
 * keeps its state, and the item is still recorded `stale_base`.
 */
function requireReverification(options: {
  readonly store: Store;
  readonly item: IntegrationItemRow;
  readonly check: BaseRevisionCheck;
  readonly actor: TransitionActor;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
}): void {
  const { store, item, check } = options;
  const changes: WorktreeChangeSet = {
    kind: "unknown",
    reason: `integration base moved (${check.relation}) before ${item.taskId} was merged`,
  };
  try {
    invalidateStaleEvidence({
      store,
      taskId: item.taskId as TaskId,
      oldRevision: item.verifiedRevision as GitSha,
      newRevision: (check.integrationHead ?? item.baseRevision) as GitSha,
      changes,
      actor: options.actor,
      now: options.now,
      newId: options.newId,
    });
  } catch {
    // A task with no valid `task-stale-evidence` edge right now (terminal,
    // blocked, already re-verifying) keeps its state. The item stays
    // `stale_base`, so the work is still not merged — which is the guarantee
    // this function exists to provide.
  }
}

/**
 * Turn a conflicted merge into the conflict workflow.
 *
 * `mergeBranch` has already aborted the merge, so the integration worktree
 * is clean when this runs: the conflict is recorded as data, not left in the
 * tree. A resolution task is created for exactly the conflicted paths; when
 * the caller supplies no factory, or the factory declines, the phase is
 * blocked with `integration_conflict` and the notification carries the paths
 * so a human can see what to resolve.
 */
function openConflict(options: IntegrateNextOptions & {
  readonly item: IntegrationItemRow;
  readonly merge: Extract<MergeOutcome, { kind: "conflict" }>;
  readonly branch: string;
}): IntegrationOutcome {
  const { store, item, merge } = options;
  const conflictId = options.newId();
  const paths = merge.paths;
  const conflict = store.write(() =>
    store.integrations.recordConflict({
      conflictId,
      createdAt: options.now(),
      workflowId: options.workflowId,
      itemId: item.itemId,
      taskId: item.taskId,
      paths,
      resolutionTaskId: null,
      status: "open",
      resolvedAt: null,
      detail: merge.detail,
    }),
  );
  store.integrations.settle(
    item.itemId,
    "conflicted",
    `merge conflict on ${paths.length} path(s): ${paths.join(", ")}`,
  );

  const resolutionTaskId =
    options.resolutionTask === undefined
      ? null
      : options.resolutionTask({ item, paths, integrationBranch: options.branch });

  if (resolutionTaskId !== null) {
    const withTask = store.integrations.attachResolutionTask(conflictId, resolutionTaskId) ?? conflict;
    return {
      kind: "conflict",
      item: store.integrations.get(item.itemId) ?? item,
      conflict: withTask,
      resolution: { kind: "task", taskId: resolutionTaskId, paths, requiresReverification: true },
    };
  }

  const notification: ConflictNotification = {
    event: "integration_conflict",
    workflowId: options.workflowId,
    phaseId: options.phaseId,
    taskId: item.taskId as TaskId,
    itemId: item.itemId,
    conflictId,
    branch: options.branch,
    paths,
    summary: `Integration of ${item.taskId} into ${options.branch} conflicts on ${paths.length} path(s); no resolver is available.`,
  };
  const unresolved = store.integrations.settleConflict(
    conflictId,
    "unresolved",
    options.now(),
    notification.summary,
  ) ?? conflict;
  raisePhaseBlocker({
    store,
    phaseId: options.phaseId,
    kind: INTEGRATION_CONFLICT_BLOCKER,
    detail: notification.summary,
    actor: options.actor,
    now: options.now,
    newId: options.newId,
    evidenceRefs: [`integration_conflict:${conflictId}`, ...paths.map((p) => `path:${p}`)],
  });
  options.notify?.(notification);
  return {
    kind: "conflict",
    item: store.integrations.get(item.itemId) ?? item,
    conflict: unresolved,
    resolution: { kind: "blocked", reason: notification.summary, notification },
  };
}

// ---------------------------------------------------------------------------
// Draining the queue
// ---------------------------------------------------------------------------

/** What one drain did. */
export interface DrainResult {
  readonly outcomes: readonly IntegrationOutcome[];
  /** Item ids integrated, in the order they were merged. */
  readonly integrated: readonly string[];
  /** `true` when the drain stopped early because a conflict blocked the phase. */
  readonly stopped: boolean;
  /** Highest number of integrations in flight at once. Always 0 or 1 (AC1). */
  readonly peakConcurrentIntegrations: number;
}

export interface RunIntegrationQueueOptions extends IntegrateNextOptions {
  /** Safety bound on iterations; the queue is finite but the loop says so. */
  readonly maxItems?: number;
  /** Cooperative cancellation, polled between items. */
  readonly signal?: { readonly aborted: boolean };
}

/**
 * Drain the phase's queue, one item at a time (AC1).
 *
 * The sequencing is structural rather than advisory: the loop calls
 * `integrateNext`, which claims a single item inside a write transaction and
 * returns only after that item has settled. Two tasks finishing at the same
 * instant therefore produce two queue rows and two *sequential* merges. The
 * `peakConcurrentIntegrations` counter is instrumentation for the test, not
 * the mechanism — the mechanism is the lease plus the claim.
 *
 * The drain stops on the first conflict that blocks the phase: continuing
 * would merge later items onto a base a human is about to change.
 */
export function runIntegrationQueue(options: RunIntegrationQueueOptions): DrainResult {
  const outcomes: IntegrationOutcome[] = [];
  const integrated: string[] = [];
  const max = options.maxItems ?? 1000;
  let inFlight = 0;
  let peak = 0;
  let stopped = false;

  for (let i = 0; i < max; i += 1) {
    if (options.signal?.aborted === true) {
      stopped = true;
      break;
    }
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    let outcome: IntegrationOutcome;
    try {
      outcome = integrateNext(options);
    } finally {
      inFlight -= 1;
    }
    if (outcome.kind === "empty") break;
    outcomes.push(outcome);
    if (outcome.kind === "integrated") integrated.push(outcome.item.itemId);
    if (outcome.kind === "conflict" && outcome.resolution.kind === "blocked") {
      stopped = true;
      break;
    }
  }
  return { outcomes, integrated, stopped, peakConcurrentIntegrations: peak };
}

// ---------------------------------------------------------------------------
// Completing a conflict resolution
// ---------------------------------------------------------------------------

/** Why a resolution was refused. */
export type ResolutionRefusal = "unknown_conflict" | "not_open" | "not_reverified" | "paths_outside_conflict";

export type ResolveConflictResult =
  | { readonly ok: true; readonly conflict: IntegrationConflictRow; readonly requeued: IntegrationItemRow }
  | { readonly ok: false; readonly refusal: ResolutionRefusal; readonly detail: string };

export interface ResolveConflictOptions {
  readonly store: Store;
  readonly conflictId: string;
  /** Branch the resolution work landed on; re-queued for integration. */
  readonly branch: string;
  /** Base the resolution was produced against — normally the integration head. */
  readonly baseRevision: GitSha;
  /** Revision the resolution's checks ran at (#45). */
  readonly verifiedRevision: GitSha;
  /**
   * Did the resolution task pass its own verification? Supplied by the
   * caller from #46's gate receipt, because `src/verification/task-gate.ts`
   * is the only thing that may declare a task `done` and this module must
   * not form a second opinion about it.
   */
  readonly reverified: boolean;
  /** Paths the resolution actually touched, for the restriction check. */
  readonly changedPaths?: readonly string[];
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
}

/**
 * Accept a conflict resolution and re-queue the item.
 *
 * Two refusals matter and neither is waivable here:
 *
 *  - `not_reverified` — a resolution that did not pass verification never
 *    re-queues. The issue's requirement is "conflict resolution as a task
 *    ... with re-verification", and the caller's `reverified` flag comes
 *    from a #46 gate receipt, not from the resolver's claim.
 *  - `paths_outside_conflict` — the resolution task is restricted to the
 *    conflicted paths, so a resolution that edited anything else is refused
 *    rather than quietly accepted as a wider change.
 *
 * A re-queue is a NEW item at the resolution's own revisions; the conflicted
 * item stays `conflicted` in the history.
 */
export function resolveConflict(options: ResolveConflictOptions): ResolveConflictResult {
  const { store } = options;
  const conflict = store.integrations.conflict(options.conflictId);
  if (conflict === undefined) {
    return { ok: false, refusal: "unknown_conflict", detail: `no conflict ${options.conflictId}` };
  }
  if (conflict.status !== "open") {
    return { ok: false, refusal: "not_open", detail: `conflict ${options.conflictId} is ${conflict.status}` };
  }
  if (!options.reverified) {
    return {
      ok: false,
      refusal: "not_reverified",
      detail: `resolution of ${options.conflictId} has not passed verification; it may not be integrated on trust`,
    };
  }
  const outside = (options.changedPaths ?? []).filter((path) => !conflict.paths.includes(path));
  if (outside.length > 0) {
    return {
      ok: false,
      refusal: "paths_outside_conflict",
      detail: `resolution touched ${outside.join(", ")}, outside the conflicted paths it was scoped to`,
    };
  }
  const item = store.integrations.get(conflict.itemId);
  if (item === undefined) {
    return { ok: false, refusal: "unknown_conflict", detail: `conflict ${options.conflictId} has no item` };
  }
  return store.write(() => {
    const settled =
      store.integrations.settleConflict(options.conflictId, "resolved", options.now(), "resolution verified") ??
      conflict;
    const requeued = store.integrations.enqueue({
      itemId: options.newId(),
      enqueuedAt: options.now(),
      workflowId: item.workflowId,
      phaseId: item.phaseId,
      taskId: item.taskId,
      taskRevision: item.taskRevision,
      branch: options.branch,
      baseRevision: options.baseRevision,
      verifiedRevision: options.verifiedRevision,
      status: "queued",
      detail: `re-queued after resolving conflict ${options.conflictId}`,
    });
    return { ok: true as const, conflict: settled, requeued };
  });
}

// ---------------------------------------------------------------------------
// Promotion to the user's branch — a request, never an act
// ---------------------------------------------------------------------------

/** Why a promotion may not even be proposed yet. */
export type PromotionRefusal = "phase_gate_not_passed" | "queue_not_drained" | "open_conflicts";

export type ProposeUserBranchMergeResult =
  | { readonly ok: false; readonly refusal: PromotionRefusal; readonly detail: string }
  | {
      readonly ok: true;
      /** The approval request. Merging waits for a human to grant it. */
      readonly request: RequestApprovalResult;
      readonly integrationBranch: string;
      readonly userBranch: string;
    };

export interface ProposeUserBranchMergeOptions {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly phaseId: PhaseId;
  /** The branch the user works on. Read for the request payload; never written. */
  readonly userBranch: string;
  /**
   * Did the phase gate pass? Supplied by the caller from #46's phase gate
   * receipt — this module does not form its own opinion about gates.
   */
  readonly phaseGatePassed: boolean;
  readonly now: IsoTimestamp;
  readonly newId: () => string;
}

/**
 * Ask for permission to merge the phase's integration branch into the user's
 * branch. **This function never merges anything.**
 *
 * There is no counterpart in this module that performs the merge: the only
 * output is an `ApprovalRequest` row of the high-risk
 * `merge_to_user_branch` class, which `approvals.ts` pins to `stop` in every
 * mode. The user's branch HEAD is therefore unchanged by everything in this
 * file (AC3), and a caller that wants to promote has to go through a granted
 * approval record and `src/git/`.
 *
 * It refuses to even ask while the phase gate has not passed, while items
 * are still queued, or while a conflict is open — asking a human to approve
 * a merge of work that is not finished is how an approval gets reused later
 * for something it did not describe.
 */
export function proposeUserBranchMerge(options: ProposeUserBranchMergeOptions): ProposeUserBranchMergeResult {
  const { store } = options;
  const branch = integrationBranch(options.workflowId, options.phaseId);
  if (!options.phaseGatePassed) {
    return {
      ok: false,
      refusal: "phase_gate_not_passed",
      detail: `phase ${options.phaseId} has not passed its gate; the user's branch is not touched until it does`,
    };
  }
  const items = store.integrations.forPhase(options.phaseId);
  const undrained = items.filter((i) => i.status === "queued" || i.status === "integrating");
  if (undrained.length > 0) {
    return {
      ok: false,
      refusal: "queue_not_drained",
      detail: `${undrained.length} integration item(s) still pending for phase ${options.phaseId}`,
    };
  }
  const open = store.integrations.openConflictsForWorkflow(options.workflowId).filter((c) =>
    items.some((i) => i.itemId === c.itemId),
  );
  if (open.length > 0) {
    return {
      ok: false,
      refusal: "open_conflicts",
      detail: `${open.length} unresolved merge conflict(s) in phase ${options.phaseId}`,
    };
  }
  const taskIds = [...new Set(items.filter((i) => i.status === "integrated").map((i) => i.taskId))];
  const request = requestApproval({
    store,
    workflowId: options.workflowId,
    classId: MERGE_TO_USER_BRANCH_CLASS,
    scope: { kind: "phase", phaseId: options.phaseId },
    permittedAction: `merge_to_user_branch:${branch}->${options.userBranch}`,
    summary: `Merge ${branch} (${taskIds.length} task(s)) into ${options.userBranch}.`,
    now: options.now,
    newId: options.newId,
  });
  return { ok: true, request, integrationBranch: branch, userBranch: options.userBranch };
}
