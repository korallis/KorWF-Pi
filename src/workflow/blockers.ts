/**
 * Blockers as first-class records (issue #41 Scope: "Blocker add/remove API;
 * `blocked` is derived, not set directly").
 *
 * A blocker is a *reason*, not a status. `Task.status = "blocked"` and a
 * phase pause are consequences of an unresolved reason existing, which is why
 * this module never writes a status itself: it raises or resolves a blocker
 * row and then asks `state.ts` for the corresponding transition. That
 * ordering is what makes the two impossible to disagree:
 *
 *  - Raising a blocker on a nonterminal task drives it to `blocked` through
 *    `task-block`, so the status change is audited like any other.
 *  - Resolving the last unresolved blocker does **not** make a task ready.
 *    Readiness is `task-ready`, with its full conjunction — checks
 *    registered, dependencies done, authorization current. "The blocker went
 *    away" is one of those preconditions, not a substitute for them.
 *  - A resolved blocker is kept, never deleted (SQL trigger in
 *    `0005-transitions.sql`), so `/korwf why` can still say what stopped the
 *    task last week.
 */
import type { Store } from "../storage/db.ts";
import type { IsoTimestamp, Phase, PhaseId, Task, TaskId } from "../storage/records.ts";
import type { BlockerRow, TransitionActor, TransitionSubjectKind } from "../storage/transition-log.ts";
import { NO_CHECKS_BLOCKER, OUTPUT_BUDGET_BLOCKER, SUPERSEDED_BLOCKER } from "./plan-schema.ts";
import {
  TransitionRejected,
  deriveBlockerField,
  phaseLifecycleState,
  transitionPhase,
  transitionTask,
  type TransitionResult,
} from "./state.ts";

/**
 * Blocker kinds the engine itself raises. Callers may use any other string —
 * a blocker is a reason, and the set of reasons a real repository produces is
 * open — but these are the ones other modules match on, so they are named.
 */
export const BLOCKER_KINDS = {
  /** PLAN §2.3: a task with no executable check. Raised by `plan-store.ts`. */
  noChecks: NO_CHECKS_BLOCKER,
  /** #124: expected output exceeds one worker turn; the task must be split. */
  outputBudget: OUTPUT_BUDGET_BLOCKER,
  /** A later plan revision dropped this task. */
  superseded: SUPERSEDED_BLOCKER,
  /** A dependency is not `done`. */
  dependency: "dependency",
  /** A required permission or approval is missing, withdrawn or expired. */
  approval: "approval",
  /** Information only the user can supply. */
  information: "information",
  /** The user asked for a pause. */
  userPause: "user_pause",
  /** An enumerated approval-invalidation event applies (docs/state-machine.md §5). */
  invalidation: "approval_invalidated",
  /** Every eligible model is capped (`all_candidates_capped`). */
  cap: "all_candidates_capped",
} as const;

export type BlockerKind = (typeof BLOCKER_KINDS)[keyof typeof BLOCKER_KINDS];

/** Inputs shared by every blocker operation. */
export interface BlockerContext {
  readonly store: Store;
  readonly actor: TransitionActor;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
}

export interface RaiseBlockerOptions extends BlockerContext {
  readonly kind: string;
  readonly detail: string;
  /** Sanitised evidence references for the resulting transition's audit row. */
  readonly evidenceRefs?: readonly string[];
}

/** What raising a blocker did: the row, and the transition it forced (if any). */
export interface RaiseBlockerResult<TSubject> {
  readonly blocker: BlockerRow;
  /**
   * `null` when the subject was already in the state the blocker implies
   * (docs/state-machine.md §5: "Already blocked/paused subjects stay so and
   * accumulate the new reason") or when it is terminal.
   */
  readonly transition: TransitionResult<TSubject> | null;
}

function insertBlocker(
  options: RaiseBlockerOptions,
  subjectKind: TransitionSubjectKind,
  subjectId: string,
  workflowId: string,
): BlockerRow {
  return options.store.blockers.insert({
    blockerId: options.newId(),
    createdAt: options.now(),
    workflowId: workflowId as BlockerRow["workflowId"],
    subjectKind,
    subjectId,
    kind: options.kind,
    detail: options.detail,
    raisedBy: `${options.actor.kind}:${options.actor.identity}`,
    resolvedAt: null,
    resolvedBy: null,
    resolutionDetail: null,
  });
}

/**
 * Raise a blocker on a task and take it to `blocked`.
 *
 * One transaction: the reason and the state change land together, or neither
 * does. A task that is already `blocked` accumulates the reason without a
 * second transition (there is no `blocked → blocked` edge, and inventing one
 * would be exactly the coercion §6 forbids). A terminal task keeps its
 * status — "terminal tasks/phases remain unchanged" — but the reason is
 * still recorded, so the history says why something was attempted.
 */
export function raiseTaskBlocker(
  options: RaiseBlockerOptions & { readonly taskId: TaskId },
): RaiseBlockerResult<Task> {
  const { store } = options;
  return store.write(() => {
    const task = store.tasks.require(options.taskId) as Task;
    const blocker = insertBlocker(options, "task", task.id, task.workflowId);
    const terminal = task.status === "done" || task.status === "cancelled";
    if (terminal || task.status === "blocked") {
      // Keep `Task.blocker` consistent with the rows for a nonterminal task;
      // never touch a terminal one.
      if (!terminal) {
        store.tasks.update(task.id, { blocker: deriveBlockerField(store, "task", task.id) });
      }
      return { blocker, transition: null };
    }
    const transition = transitionTask({
      store,
      taskId: task.id,
      to: "blocked",
      trigger: "blocker_or_user_pause",
      actor: options.actor,
      now: options.now,
      newId: options.newId,
      evidenceRefs: options.evidenceRefs ?? [`blocker:${blocker.blockerId}`],
      // `blocker_present` is a structural guard: it is true because the row
      // above exists, and no caller can assert it without one.
      guards: {},
    });
    return { blocker, transition };
  });
}

/**
 * Raise a blocker on a phase and pause it.
 *
 * The stored status follows docs/state-machine.md §1: a cap or budget stop is
 * `paused_cap`, anything else `paused_approval`. An already-paused phase
 * accumulates the reason; `phase-pause` has no `paused → paused` edge.
 */
export function raisePhaseBlocker(
  options: RaiseBlockerOptions & { readonly phaseId: PhaseId },
): RaiseBlockerResult<Phase> {
  const { store } = options;
  return store.write(() => {
    const phase = store.phases.require(options.phaseId) as Phase;
    const blocker = insertBlocker(options, "phase", phase.id, phase.workflowId);
    const state = phaseLifecycleState(phase.gateStatus);
    if (state === undefined || state === "done" || state === "cancelled" || state === "paused") {
      return { blocker, transition: null };
    }
    const transition = transitionPhase({
      store,
      phaseId: phase.id,
      to: "paused",
      trigger: "phase_stop",
      actor: options.actor,
      now: options.now,
      newId: options.newId,
      evidenceRefs: options.evidenceRefs ?? [`blocker:${blocker.blockerId}`],
      blocker: { kind: options.kind, detail: options.detail },
      guards: { phase_stop_present: () => true },
    });
    return { blocker, transition };
  });
}

/** What resolving a blocker did. */
export interface ResolveBlockerResult {
  readonly blocker: BlockerRow;
  /** Unresolved reasons that remain on the subject afterwards. */
  readonly remaining: readonly BlockerRow[];
  /**
   * `true` when nothing unresolved remains. **Not** "the task is ready":
   * readiness is a `task-ready` transition with the full conjunction, which
   * the caller must request separately and which can still be refused.
   */
  readonly clear: boolean;
}

/**
 * Resolve one blocker. Deliberately does **not** change any status.
 *
 * A cleared blocker is a precondition of readiness, not readiness itself
 * (docs/state-machine.md §2: every edge into `ready` also needs
 * `checks_registered`, `readiness_valid` and `authorization_current`); and
 * §5 is explicit that "a cap clearing cannot clear another unresolved
 * reason". So the only state effect here is keeping `Task.blocker` in step
 * with the rows.
 */
export function resolveBlocker(
  options: BlockerContext & { readonly blockerId: string; readonly detail: string },
): ResolveBlockerResult {
  const { store } = options;
  return store.write(() => {
    const existing = store.blockers.get(options.blockerId);
    if (existing === undefined) {
      throw new TransitionRejected({ message: `unknown blocker ${options.blockerId}`, code: "unknown_subject" });
    }
    const blocker = store.blockers.resolve(options.blockerId, {
      at: options.now(),
      by: `${options.actor.kind}:${options.actor.identity}`,
      detail: options.detail,
    });
    const remaining = store.blockers.unresolvedForSubject(existing.subjectKind, existing.subjectId);
    if (existing.subjectKind === "task") {
      const task = store.tasks.get(existing.subjectId as TaskId);
      if (task !== undefined && task.status !== "done" && task.status !== "cancelled") {
        store.tasks.update(task.id, { blocker: deriveBlockerField(store, "task", task.id) });
      }
    }
    return { blocker, remaining, clear: remaining.length === 0 };
  });
}

/** Resolve every unresolved blocker of one kind on a subject. */
export function resolveBlockersOfKind(
  options: BlockerContext & {
    readonly subjectKind: TransitionSubjectKind;
    readonly subjectId: string;
    readonly kind: string;
    readonly detail: string;
  },
): readonly BlockerRow[] {
  const { store } = options;
  return store.write(() => {
    const matching = store.blockers
      .unresolvedForSubject(options.subjectKind, options.subjectId)
      .filter((blocker) => blocker.kind === options.kind);
    return matching.map(
      (blocker) => resolveBlocker({ ...options, blockerId: blocker.blockerId, detail: options.detail }).blocker,
    );
  });
}

/** Unresolved reasons on a subject. Empty means nothing is holding it. */
export function activeBlockers(
  store: Store,
  subjectKind: TransitionSubjectKind,
  subjectId: string,
): readonly BlockerRow[] {
  return store.blockers.unresolvedForSubject(subjectKind, subjectId);
}

/**
 * Is the subject blocked? Derived from the rows, which is the whole point:
 * there is no setter for this.
 */
export function isBlocked(store: Store, subjectKind: TransitionSubjectKind, subjectId: string): boolean {
  return activeBlockers(store, subjectKind, subjectId).length > 0;
}

/** One line per unresolved reason, for `/korwf tasks` and `/korwf why`. */
export function describeBlockers(blockers: readonly BlockerRow[]): string {
  if (blockers.length === 0) return "no unresolved blockers";
  return blockers.map((blocker) => `  ! ${blocker.kind}: ${blocker.detail} (raised by ${blocker.raisedBy})`).join("\n");
}
