/**
 * Approval invalidation at runtime (issue #41; docs/state-machine.md §5,
 * PLAN §3.C "approval invalidation").
 *
 * `transitions.ts` enumerates the events and their state effects as data;
 * this module is the only place that *applies* them, and it applies **all**
 * of them: every row of `APPROVAL_INVALIDATION_EVENTS` maps to a state
 * effect here, asserted by a test that walks the contract rather than a
 * hand-written list.
 *
 * The invariants, in the order they matter:
 *
 *  1. **One transaction.** The approval rows, the task/phase transitions and
 *     the blockers land together. An approval can never be invalid while the
 *     task it authorised is still running.
 *  2. **Revision changes invalidate evidence.** Evidence is append-only, so
 *     nothing is deleted; the evidence bound to the old `taskRevision` is
 *     *excluded* from current gates (`evidenceForCurrentRevision`), and the
 *     old rows stay readable.
 *  3. **`invalidation` only ever goes null → reason.** Enforced by the
 *     repository; this module never tries otherwise.
 *  4. **Terminal subjects are untouched** but their approvals are still
 *     invalidated: a completed effect is not undone, and the used approval
 *     cannot authorise anything new.
 *  5. **`consumed` changes no state.** Only a repeated request for the same
 *     action blocks, which is the caller's next request, not this one.
 */
import type { Store } from "../storage/db.ts";
import type {
  Approval,
  ApprovalInvalidation,
  Evidence,
  IsoTimestamp,
  Phase,
  Revision,
  Task,
  TaskId,
  WorkflowId,
} from "../storage/records.ts";
import type { TransitionActor } from "../storage/transition-log.ts";
import { APPROVAL_INVALIDATION_EVENTS, type ApprovalInvalidationEvent } from "./transitions.ts";
import { BLOCKER_KINDS } from "./blockers.ts";
import {
  nonterminalPhases,
  nonterminalTasks,
  phaseLifecycleState,
  transitionPhase,
  transitionTask,
} from "./state.ts";

/** Invalidation reason, spelled as `records.ts` spells it. */
export type InvalidationReason = ApprovalInvalidation["reason"];

/** How a phase reacts when the contract says `by_approval_class`. */
export type PhaseDisposition = "queue_and_continue" | "stop_phase";

/** The contract row for one event. Throws for an unknown reason. */
export function invalidationContract(reason: InvalidationReason): ApprovalInvalidationEvent {
  const row = APPROVAL_INVALIDATION_EVENTS.find((event) => event.event === reason);
  if (row === undefined) throw new Error(`no invalidation contract for "${reason}"`);
  return row;
}

export interface ApplyInvalidationOptions {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly reason: InvalidationReason;
  readonly detail: string;
  readonly actor: TransitionActor;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
  /**
   * Task whose content changed, for `task_revision_changed`. Approvals scoped
   * to another task are then left alone: §5's "unrelated tasks retain state".
   */
  readonly taskId?: TaskId;
  /**
   * Disposition for the events the contract marks `by_approval_class`.
   * Defaults to `stop_phase`, the restrictive choice: §5 says auto-decide
   * "cannot keep an invalid approval alive" and high-risk never auto-decides,
   * so an unspecified class stops the phase rather than continuing.
   */
  readonly phaseDisposition?: PhaseDisposition;
}

/** What applying one invalidation event did. */
export interface InvalidationEffect {
  readonly reason: InvalidationReason;
  readonly invalidatedApprovals: readonly string[];
  readonly blockedTasks: readonly string[];
  readonly pausedPhases: readonly string[];
  /** Evidence rows now excluded from current gates (retained on disk). */
  readonly excludedEvidence: readonly string[];
  /** Tasks/phases left alone because they are terminal. */
  readonly unchangedTerminal: readonly string[];
}

/** Approvals this event makes unusable, per the contract's `appliesTo`. */
function affectedApprovals(options: ApplyInvalidationOptions): readonly Approval[] {
  const all = options.store.approvals
    .findBy("workflowId", options.workflowId)
    .filter((approval) => approval.invalidation === null);
  if (options.reason === "task_revision_changed" && options.taskId !== undefined) {
    // The changed task's own approvals, plus the containing phase/plan/
    // workflow approvals whose approved content includes it.
    const task = options.store.tasks.get(options.taskId);
    return all.filter((approval) => {
      switch (approval.scope.kind) {
        case "task":
          return approval.scope.taskId === options.taskId;
        case "phase":
          return task !== undefined && approval.scope.phaseId === task.phaseId;
        case "plan":
        case "workflow":
          return true;
      }
    });
  }
  if (options.reason === "expired") {
    const at = options.now();
    return all.filter((approval) => approval.expiresAt !== null && approval.expiresAt <= at);
  }
  return all;
}
