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
import { canonicalJson } from "../storage/repos/base.ts";
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

/**
 * Apply one enumerated invalidation event: invalidate the affected approvals,
 * then take every affected nonterminal task to `blocked` and every affected
 * nonterminal phase to `paused` exactly as the contract row prescribes.
 *
 * `consumed` is the one event with no state effect (`unchanged_unless_action_
 * repeated`): the completed action's receipt stands, and it is the *next*
 * request for the same action that is refused for want of an approval.
 */
export function applyInvalidation(options: ApplyInvalidationOptions): InvalidationEffect {
  const { store } = options;
  const contract = invalidationContract(options.reason);
  return store.write(() => {
    const at = options.now();
    const invalidated: string[] = [];
    for (const approval of affectedApprovals(options)) {
      store.approvals.invalidate(approval.id, { reason: options.reason, at, detail: options.detail });
      invalidated.push(approval.id);
    }

    const excludedEvidence =
      options.reason === "task_revision_changed" || options.reason === "plan_revision_changed"
        ? staleEvidenceIds(store, options)
        : [];

    if (contract.taskEffect === "unchanged_unless_action_repeated") {
      return {
        reason: options.reason,
        invalidatedApprovals: invalidated,
        blockedTasks: [],
        pausedPhases: [],
        excludedEvidence,
        unchangedTerminal: [],
      };
    }

    const unchangedTerminal: string[] = [];
    const blockedTasks = blockAffectedTasks(options, unchangedTerminal);
    const pausedPhases = pauseAffectedPhases(options, contract, blockedTasks);
    return {
      reason: options.reason,
      invalidatedApprovals: invalidated,
      blockedTasks,
      pausedPhases,
      excludedEvidence,
      unchangedTerminal,
    };
  });
}

/**
 * Tasks the event affects, taken to `blocked` through `task-invalidate`.
 *
 * A task already `blocked` accumulates the reason (a blocker row) without a
 * second transition; a terminal task is recorded as deliberately unchanged.
 */
function blockAffectedTasks(options: ApplyInvalidationOptions, unchangedTerminal: string[]): readonly string[] {
  const { store } = options;
  const candidates: readonly Task[] =
    options.taskId === undefined
      ? nonterminalTasks(store, options.workflowId)
      : ((): readonly Task[] => {
          const task = store.tasks.get(options.taskId);
          if (task === undefined) return [];
          if (task.status === "done" || task.status === "cancelled") {
            unchangedTerminal.push(task.id);
            return [];
          }
          return [task];
        })();

  const blocked: string[] = [];
  for (const task of candidates) {
    store.blockers.insert({
      blockerId: options.newId(),
      createdAt: options.now(),
      workflowId: task.workflowId,
      subjectKind: "task",
      subjectId: task.id,
      kind: BLOCKER_KINDS.invalidation,
      detail: `${options.reason}: ${options.detail}`,
      raisedBy: `${options.actor.kind}:${options.actor.identity}`,
      resolvedAt: null,
      resolvedBy: null,
      resolutionDetail: null,
    });
    if (task.status === "blocked") {
      blocked.push(task.id);
      continue;
    }
    transitionTask({
      store,
      taskId: task.id,
      to: "blocked",
      trigger: "approval_invalidated",
      actor: { kind: "engine", identity: options.actor.identity },
      now: options.now,
      newId: options.newId,
      evidenceRefs: [`invalidation:${options.reason}`],
      guards: { invalidation_applies: () => true },
    });
    blocked.push(task.id);
  }
  return blocked;
}

/**
 * Phases the event affects.
 *
 * `paused` when the contract says so unconditionally; when it says
 * `by_approval_class`, the caller's disposition decides — `queue_and_continue`
 * leaves the phase running so other ready tasks may proceed, `stop_phase`
 * pauses it as `paused_approval`. Only phases containing an affected task
 * are touched, so an unrelated phase keeps its state.
 */
function pauseAffectedPhases(
  options: ApplyInvalidationOptions,
  contract: ApprovalInvalidationEvent,
  blockedTasks: readonly string[],
): readonly string[] {
  const { store } = options;
  if (contract.phaseEffect === "unchanged_unless_action_repeated") return [];
  if (contract.phaseEffect === "by_approval_class" && (options.phaseDisposition ?? "stop_phase") === "queue_and_continue") {
    return [];
  }

  const affectedPhaseIds = new Set(
    blockedTasks.map((taskId) => store.tasks.get(taskId as TaskId)?.phaseId).filter((id): id is Phase["id"] => id !== undefined),
  );
  const candidates =
    options.taskId === undefined && affectedPhaseIds.size === 0
      ? nonterminalPhases(store, options.workflowId)
      : nonterminalPhases(store, options.workflowId).filter((phase) => affectedPhaseIds.has(phase.id));

  const paused: string[] = [];
  for (const phase of candidates) {
    if (phaseLifecycleState(phase.gateStatus) === "paused") {
      // Already paused: accumulate the reason only (§5).
      store.blockers.insert({
        blockerId: options.newId(),
        createdAt: options.now(),
        workflowId: phase.workflowId,
        subjectKind: "phase",
        subjectId: phase.id,
        kind: BLOCKER_KINDS.invalidation,
        detail: `${options.reason}: ${options.detail}`,
        raisedBy: `${options.actor.kind}:${options.actor.identity}`,
        resolvedAt: null,
        resolvedBy: null,
        resolutionDetail: null,
      });
      paused.push(phase.id);
      continue;
    }
    transitionPhase({
      store,
      phaseId: phase.id,
      to: "paused",
      trigger: "approval_invalidated",
      actor: { kind: "engine", identity: options.actor.identity },
      now: options.now,
      newId: options.newId,
      evidenceRefs: [`invalidation:${options.reason}`],
      blocker: { kind: BLOCKER_KINDS.invalidation, detail: `${options.reason}: ${options.detail}` },
      guards: { invalidation_applies: () => true, stop_phase_required: () => true },
    });
    paused.push(phase.id);
  }
  return paused;
}

// ---------------------------------------------------------------------------
// Evidence: retained, but excluded from current gates
// ---------------------------------------------------------------------------

/**
 * Evidence rows no longer usable by a current gate, because they were
 * captured against a task revision that is no longer current.
 *
 * Evidence is append-only — "invalidated evidence stays on disk" — so this is
 * a *filter*, not a delete. It exists so the gate cannot accidentally count a
 * pre-revision pass: `all_checks_pass_exact_revision` means the exact
 * revision, and this is how "exact" is computed.
 */
function staleEvidenceIds(store: Store, options: ApplyInvalidationOptions): readonly string[] {
  const taskIds =
    options.taskId === undefined
      ? store.tasks.findBy("workflowId", options.workflowId).map((task) => task.id)
      : [options.taskId];
  const stale: string[] = [];
  for (const taskId of taskIds) {
    const task = store.tasks.get(taskId);
    if (task === undefined) continue;
    for (const evidence of store.evidence.findBy("taskId", taskId)) {
      if (evidence.taskRevision !== task.revision) stale.push(evidence.id);
    }
  }
  return stale;
}

/**
 * Evidence a gate may count for a task: captured at the task's current
 * revision and, when a Git SHA is given, at that exact SHA.
 *
 * Both conditions are required by docs/state-machine.md §2: "a changed
 * integration SHA cannot borrow task evidence from the pre-merge SHA".
 */
export function evidenceForCurrentRevision(
  store: Store,
  task: Pick<Task, "id" | "revision">,
  gitRevision: string | null = null,
): readonly Evidence[] {
  return store.evidence
    .forTaskRevision(task.id, task.revision)
    .filter((evidence) => gitRevision === null || evidence.revision === gitRevision);
}

/** Evidence retained but excluded from current gates, for `/korwf why`. */
export function excludedEvidence(
  store: Store,
  task: Pick<Task, "id" | "revision">,
  gitRevision: string | null = null,
): readonly Evidence[] {
  return store.evidence
    .findBy("taskId", task.id)
    .filter((evidence) => evidence.taskRevision !== task.revision || (gitRevision !== null && evidence.revision !== gitRevision));
}

/**
 * Bump a task's revision because its definition of done changed, and apply
 * the `task_revision_changed` consequences in the same transaction.
 *
 * This is the runtime counterpart of what `plan-store.ts` does for a whole
 * plan revision, for the case where one task's goal/criteria/checks/ownership
 * changed on its own (#41 Scope: "Task `revision` increments on any change to
 * goal/criteria/checks/ownership; approvals for the old revision are
 * invalidated").
 *
 * Ownership is in the issue's list but is *not* a `TASK_REVISIONED_FIELDS`
 * member (docs/records.md §5.1: the store *rejects* bumping the revision
 * without a goal/criteria/checks change). Both requirements are met by
 * treating an ownership-only change as an invalidating change — approvals are
 * invalidated with `task_revision_changed` and the task is blocked — without
 * inventing a revision number the store forbids.
 */
export function reviseTask(options: {
  readonly store: Store;
  readonly taskId: TaskId;
  readonly patch: Partial<Pick<Task, "goal" | "acceptanceCriteria" | "checks" | "ownership">>;
  readonly actor: TransitionActor;
  readonly detail: string;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
}): { readonly task: Task; readonly effect: InvalidationEffect | null; readonly revisionBumped: boolean } {
  const { store } = options;
  return store.write(() => {
    const before = store.tasks.require(options.taskId) as Task;
    // Only fields that actually differ are patched. Passing an unchanged
    // `goal` would otherwise trip the store's revision rule (which treats the
    // *presence* of a revisioned key as a change) and bump the revision — and
    // a no-op edit must not invalidate anybody's approval.
    const effective: {
      goal?: string;
      acceptanceCriteria?: Task["acceptanceCriteria"];
      checks?: Task["checks"];
      ownership?: Task["ownership"];
    } = {};
    if (options.patch.goal !== undefined && options.patch.goal !== before.goal) {
      effective.goal = options.patch.goal;
    }
    if (
      options.patch.acceptanceCriteria !== undefined &&
      canonicalJson(options.patch.acceptanceCriteria) !== canonicalJson(before.acceptanceCriteria)
    ) {
      effective.acceptanceCriteria = options.patch.acceptanceCriteria;
    }
    if (options.patch.checks !== undefined && canonicalJson(options.patch.checks) !== canonicalJson(before.checks)) {
      effective.checks = options.patch.checks;
    }
    if (
      options.patch.ownership !== undefined &&
      canonicalJson(options.patch.ownership) !== canonicalJson(before.ownership)
    ) {
      effective.ownership = options.patch.ownership;
    }

    const definitionChanged =
      effective.goal !== undefined || effective.acceptanceCriteria !== undefined || effective.checks !== undefined;
    const ownershipOnly = !definitionChanged && effective.ownership !== undefined;
    if (!definitionChanged && !ownershipOnly) {
      return { task: before, effect: null, revisionBumped: false };
    }

    const task = store.tasks.update(options.taskId, {
      ...effective,
      ...(definitionChanged ? { revision: (before.revision + 1) as Revision } : {}),
    });

    const effect = applyInvalidation({
      store,
      workflowId: task.workflowId,
      reason: "task_revision_changed",
      detail: options.detail,
      actor: options.actor,
      now: options.now,
      newId: options.newId,
      taskId: task.id,
    });
    return { task, effect, revisionBumped: definitionChanged };
  });
}
