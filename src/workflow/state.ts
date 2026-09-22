/**
 * The runtime task/phase state machine (issue #41; PLAN §5, §2.4, §3.C;
 * specification in `docs/state-machine.md`, data contract in
 * `transitions.ts`).
 *
 * **This module is the only thing in the package that changes `Task.status`
 * or `Phase.gateStatus`.** Everything else — workers, tools, the UI, the
 * planner, recovery, Jev — may *request* a transition; only `transition()`
 * commits one, and only after every conjunctive guard of the matching row in
 * `TASK_TRANSITIONS`/`PHASE_TRANSITIONS` has been satisfied against one
 * current snapshot.
 *
 * The three rules that must never be reachable any other way
 * (docs/state-machine.md §2, PLAN §2.4):
 *
 *  1. `ready` requires `Task.checks.length >= 1` with at least one
 *     executable check. #37 enforces this at plan time; it is re-enforced
 *     here at transition time, because a plan is not the only way a task can
 *     end up in the store.
 *  2. `done` requires the full TASK_DONE conjunction: all checks pass at the
 *     exact task revision *and* Git SHA, no Jev evidence gap (or Jev
 *     explicitly disabled with a recorded deterministic assessment), and
 *     policy review satisfied. A worker's claim, a user instruction and a
 *     Jev score are none of those things.
 *  3. Every gate hook **defaults to reject**. The gate formulas themselves
 *     are Stage 4 (#46–#49); until they are supplied, `done` is unreachable
 *     rather than assumed. Absent, unknown and erroring evaluators all fail
 *     closed.
 *
 * Every accepted and every rejected request appends a `transition_event` row
 * in the same transaction as the state change, so a refusal is as visible as
 * a success (docs/state-machine.md §6).
 */
import type { Store } from "../storage/db.ts";
import type {
  IsoTimestamp,
  Phase,
  PhaseGateStatus,
  PhaseId,
  Task,
  TaskId,
  TaskStatus,
  Workflow,
  WorkflowId,
} from "../storage/records.ts";
import type { TransitionActor, TransitionEvent, TransitionSubjectKind } from "../storage/transition-log.ts";
import { hashRecord } from "../storage/repos/base.ts";
import { EXECUTABLE_CHECK_KINDS } from "./plan-schema.ts";
import {
  PHASE_STATES,
  PHASE_STORAGE_STATES,
  PHASE_TERMINAL_STATES,
  PHASE_TRANSITIONS,
  TASK_STATES,
  TASK_TERMINAL_STATES,
  TASK_TRANSITIONS,
  type PhaseState,
  type Precondition,
  type Transition,
} from "./transitions.ts";

// ---------------------------------------------------------------------------
// Rejection reason codes
// ---------------------------------------------------------------------------

/**
 * Stable reason codes for a refused request, one per bullet of
 * `ILLEGAL_TRANSITION_POLICY.rejects` plus the storage-failure case. They are
 * part of the observable contract: `/korwf why` and the tests match on them,
 * not on message text.
 */
export const REJECTION_CODES = [
  "unknown_state",
  "unknown_trigger",
  "unlisted_edge",
  "unauthorized_actor",
  "precondition_failed",
  "missing_evidence",
  "terminal_subject",
  "stale_snapshot",
  "unknown_subject",
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

/** Thrown when a transition is refused. Carries the persisted event. */
export class TransitionRejected extends Error {
  override readonly name = "TransitionRejected";
  readonly code: RejectionCode;
  readonly failedGuards: readonly Precondition[];
  readonly event: TransitionEvent | null;

  constructor(params: {
    message: string;
    code: RejectionCode;
    failedGuards?: readonly Precondition[];
    event?: TransitionEvent | null;
  }) {
    super(params.message);
    this.code = params.code;
    this.failedGuards = params.failedGuards ?? [];
    this.event = params.event ?? null;
  }
}

// ---------------------------------------------------------------------------
// Guard evaluation
// ---------------------------------------------------------------------------

/**
 * One guard's answer. `unknown` exists so an evaluator can say "I could not
 * tell" without that being mistaken for `true`: docs/state-machine.md §1,
 * "missing or unknown results fail closed".
 */
export type GuardOutcome = true | false | "unknown";

/** Context a guard evaluator may read. Read-only: a guard never mutates. */
export interface GuardContext {
  readonly store: Store;
  readonly workflow: Workflow;
  readonly task: Task | null;
  readonly phase: Phase | null;
  /** Exact Git SHA the request is evaluated against, when the caller knows it. */
  readonly gitRevision: string | null;
  readonly actor: TransitionActor;
  readonly now: IsoTimestamp;
  /** Sanitised evidence references supplied with the request. */
  readonly evidenceRefs: readonly string[];
  /** Unresolved blocker kinds on the subject, derived from the blocker table. */
  readonly unresolvedBlockers: readonly string[];
}

/** A guard implementation: pure with respect to state, returns a verdict. */
export type GuardEvaluator = (context: GuardContext) => GuardOutcome;

/**
 * The guards a caller supplies. Every key is optional and **every omitted
 * key evaluates to `false`** — see `evaluateGuards`. This is the
 * "precondition hook exists and defaults to reject" acceptance criterion:
 * Stage 4 supplies the real gate formulas, and until it does, the edges that
 * need them are unreachable rather than waived.
 */
export type GuardTable = Partial<Record<Precondition, GuardEvaluator>>;

/** Result of evaluating one edge's conjunction. */
export interface GuardEvaluation {
  readonly satisfied: boolean;
  /** Guard ids that returned `false`, `unknown`, threw, or were not supplied. */
  readonly failed: readonly Precondition[];
}

/**
 * Evaluate a conjunction of guards, fail-closed in all four failure shapes:
 * absent evaluator, `false`, `"unknown"`, and a thrown error. Every guard is
 * evaluated (not short-circuited) so a rejection can name all failing guard
 * ids at once, which is what the audit row requires.
 */
export function evaluateGuards(
  preconditions: readonly Precondition[],
  guards: GuardTable,
  context: GuardContext,
): GuardEvaluation {
  const failed: Precondition[] = [];
  for (const id of preconditions) {
    const evaluator = guards[id];
    if (evaluator === undefined) {
      failed.push(id);
      continue;
    }
    let outcome: GuardOutcome;
    try {
      outcome = evaluator(context);
    } catch {
      // An evaluator that throws has not established its precondition.
      failed.push(id);
      continue;
    }
    if (outcome !== true) failed.push(id);
  }
  return { satisfied: failed.length === 0, failed };
}

// ---------------------------------------------------------------------------
// Structural guards: deterministic facts no caller may contradict
// ---------------------------------------------------------------------------

/**
 * Does this task carry at least one *executable* check, or an explicitly
 * required human check (PLAN §2.3, `checks_registered`)?
 *
 * `required: false` does not exempt a registered check from the gate, but an
 * optional human check is not on its own a registered means of verification:
 * a task whose only check is an unrequired human one has nothing that can be
 * run, so it cannot become ready.
 */
export function hasExecutableCheck(task: Pick<Task, "checks">): boolean {
  const executable = new Set<string>(EXECUTABLE_CHECK_KINDS);
  return task.checks.some((check) => executable.has(check.kind) || (check.kind === "human" && check.required));
}

/**
 * Guard verdicts computed from the store rather than supplied by the caller.
 *
 * These are combined with the caller's table by **conjunction**, and the
 * structural verdict wins: a caller cannot pass `checks_registered: () => true`
 * for a task with no checks, and cannot claim `readiness_valid` while an
 * unresolved blocker or an unmet dependency exists. That is what "deterministic
 * checks cannot be waived by any tool path" means in code.
 */
export function structuralGuards(context: GuardContext): Partial<Record<Precondition, GuardOutcome>> {
  const out: Partial<Record<Precondition, GuardOutcome>> = {};
  const { task } = context;
  if (task !== null) {
    out.checks_registered = hasExecutableCheck(task);
    const dependenciesDone = task.dependencies.every(
      (dep) => context.store.tasks.get(dep)?.status === "done",
    );
    out.readiness_valid = context.unresolvedBlockers.length === 0 && dependenciesDone;
    out.blocker_present = context.unresolvedBlockers.length > 0;
  }
  return out;
}

/** Apply the structural verdicts on top of a caller table (conjunctive). */
export function withStructuralGuards(guards: GuardTable, context: GuardContext): GuardTable {
  const structural = structuralGuards(context);
  const merged: GuardTable = { ...guards };
  for (const [id, verdict] of Object.entries(structural) as [Precondition, GuardOutcome][]) {
    const supplied = guards[id];
    merged[id] = (inner) => {
      if (verdict !== true) return verdict;
      if (supplied === undefined) return verdict;
      try {
        return supplied(inner);
      } catch {
        return false;
      }
    };
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Edge lookup
// ---------------------------------------------------------------------------

/** Every distinct trigger name in the two tables. */
export const TASK_TRIGGERS = [...new Set(TASK_TRANSITIONS.map((t) => t.trigger))] as readonly string[];
export const PHASE_TRIGGERS = [...new Set(PHASE_TRANSITIONS.map((t) => t.trigger))] as readonly string[];

/**
 * The listed edge for `(from, to)`, optionally narrowed by trigger.
 *
 * There is deliberately no fallback: two rows share a `(from, to)` pair only
 * with different triggers (`task-block` and `task-invalidate` both end
 * `blocked`), and choosing one of them for a caller who did not say which
 * would be exactly the "coercion into a similar edge" §6 forbids.
 */
export function findTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
  trigger?: string,
): Transition<TaskStatus> | undefined {
  return TASK_TRANSITIONS.find(
    (row) =>
      row.to === to &&
      (row.from as readonly TaskStatus[]).includes(from) &&
      (trigger === undefined || row.trigger === trigger),
  ) as Transition<TaskStatus> | undefined;
}

export function findPhaseTransition(
  from: PhaseState,
  to: PhaseState,
  trigger?: string,
): Transition<PhaseState> | undefined {
  return PHASE_TRANSITIONS.find(
    (row) =>
      row.to === to &&
      (row.from as readonly PhaseState[]).includes(from) &&
      (trigger === undefined || row.trigger === trigger),
  ) as Transition<PhaseState> | undefined;
}

/** Is `(from, to)` a listed task edge at all? Used by the table-driven test. */
export function isLegalTaskEdge(from: TaskStatus, to: TaskStatus): boolean {
  return findTaskTransition(from, to) !== undefined;
}

export function isLegalPhaseEdge(from: PhaseState, to: PhaseState): boolean {
  return findPhaseTransition(from, to) !== undefined;
}

/** Lifecycle state a persisted `PhaseGateStatus` projects onto (§1 table). */
export function phaseLifecycleState(gateStatus: PhaseGateStatus): PhaseState | undefined {
  for (const state of PHASE_STATES) {
    if ((PHASE_STORAGE_STATES[state] as readonly PhaseGateStatus[]).includes(gateStatus)) return state;
  }
  return undefined;
}

/**
 * The `PhaseGateStatus` a lifecycle state is stored as. `gating` enters at
 * `integrating` — the projection is not permission to skip substages, so the
 * engine enters gating at its first substage and `advanceGating` walks it.
 */
export function phaseStorageStatus(state: PhaseState): PhaseGateStatus {
  const first = PHASE_STORAGE_STATES[state][0];
  return first as PhaseGateStatus;
}

/** Ordered gating substages; `phase-done` may only be requested from the last. */
export const GATING_SUBSTAGES = PHASE_STORAGE_STATES.gating;
