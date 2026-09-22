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

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Shared inputs for any transition request. */
export interface TransitionRequestBase {
  readonly store: Store;
  /** Who is asking. Only `engine` may commit; `user`/`worker` requests are mapped. */
  readonly actor: TransitionActor;
  readonly trigger: string;
  /** Guard implementations. Omitted guards reject (see `evaluateGuards`). */
  readonly guards?: GuardTable;
  /** Sanitised evidence references; never raw payloads (docs/state-machine.md §6). */
  readonly evidenceRefs?: readonly string[];
  /** Exact Git SHA being certified, where the edge concerns one. */
  readonly gitRevision?: string | null;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
  /**
   * Revision/status the caller last observed. When given and stale, the
   * request is rejected with `stale_snapshot` rather than applied to a
   * subject that moved underneath it.
   */
  readonly expected?: { readonly status?: string; readonly revision?: number };
  /** Blocker to raise/resolve alongside the transition (see `blockers.ts`). */
  readonly blocker?: {
    readonly kind: string;
    readonly detail: string;
  };
}

export interface TaskTransitionRequest extends TransitionRequestBase {
  readonly taskId: TaskId;
  readonly to: TaskStatus;
}

export interface PhaseTransitionRequest extends TransitionRequestBase {
  readonly phaseId: PhaseId;
  readonly to: PhaseState;
}

/** What an accepted transition did. */
export interface TransitionResult<TSubject> {
  readonly subject: TSubject;
  readonly event: TransitionEvent;
  readonly transitionId: string;
  /** Side-effect notes from the table row, for the caller to surface. */
  readonly sideEffects: readonly string[];
}

// ---------------------------------------------------------------------------
// Event writing
// ---------------------------------------------------------------------------

interface EventDraft {
  readonly workflow: Workflow;
  readonly subjectKind: TransitionSubjectKind;
  readonly subjectId: string;
  readonly fromState: string;
  readonly toState: string;
  readonly transitionId: string | null;
  readonly trigger: string;
  readonly actor: TransitionActor;
  readonly disposition: "accepted" | "rejected";
  readonly reasonCode: RejectionCode | null;
  readonly taskRevision: number | null;
  readonly gitRevision: string | null;
  readonly failedGuards: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly beforeHash: string;
  readonly afterHash: string;
}

function appendEvent(
  store: Store,
  draft: EventDraft,
  now: () => IsoTimestamp,
  newId: () => string,
): TransitionEvent {
  const event: TransitionEvent = {
    eventId: newId(),
    createdAt: now(),
    workflowId: draft.workflow.id,
    subjectKind: draft.subjectKind,
    subjectId: draft.subjectId,
    fromState: draft.fromState,
    toState: draft.toState,
    transitionId: draft.transitionId,
    trigger: draft.trigger,
    actor: draft.actor,
    disposition: draft.disposition,
    reasonCode: draft.reasonCode,
    taskRevision: draft.taskRevision,
    planRevision: draft.workflow.planRevision,
    gitRevision: draft.gitRevision,
    mode: draft.workflow.mode,
    policyVersion: draft.workflow.policyVersion,
    failedGuards: draft.failedGuards,
    evidenceRefs: draft.evidenceRefs,
    beforeHash: draft.beforeHash,
    afterHash: draft.afterHash,
  };
  return store.transitionLog.insert(event);
}

/**
 * Reject: append the event, then throw. The append happens inside the
 * caller's transaction; if it cannot persist, the throw propagates and
 * nothing was mutated either — fail closed, as §6 requires.
 */
function reject(
  store: Store,
  draft: Omit<EventDraft, "disposition">,
  message: string,
  now: () => IsoTimestamp,
  newId: () => string,
): never {
  const event = appendEvent(store, { ...draft, disposition: "rejected" }, now, newId);
  throw new TransitionRejected({
    message,
    code: draft.reasonCode ?? "unlisted_edge",
    failedGuards: draft.failedGuards as readonly Precondition[],
    event,
  });
}

/** Which table actor a request's origin maps to (docs/state-machine.md §1). */
export function actorRole(actor: TransitionActor): "engine_only" | "user" | "worker_request_then_engine" {
  switch (actor.kind) {
    case "engine":
      return "engine_only";
    case "user":
      return "user";
    case "worker":
      return "worker_request_then_engine";
  }
}

/**
 * Success states no requester other than the engine may reach, however the
 * request is spelled (docs/state-machine.md §2 and the §1 commit rules).
 * Listed rather than derived, so adding a state cannot quietly open a route
 * to completion.
 */
export const ENGINE_ONLY_SUCCESS_STATES = { task: ["done"], phase: ["done"] } as const;

// ---------------------------------------------------------------------------
// Task transitions
// ---------------------------------------------------------------------------

/**
 * Request a task transition. The only writer of `Task.status`.
 *
 * Order of checks matters and mirrors §6: identity, terminal state, known
 * state/trigger, listed edge, actor authorisation, snapshot freshness, then
 * the guard conjunction. Everything runs against one snapshot read inside
 * the transaction, and the state change plus its event are one commit.
 */
export function transitionTask(request: TaskTransitionRequest): TransitionResult<Task> {
  const { store, now, newId } = request;
  const evidenceRefs = request.evidenceRefs ?? [];
  const gitRevision = request.gitRevision ?? null;

  return store.write(() => {
    const task = store.tasks.get(request.taskId);
    if (task === undefined) {
      throw new TransitionRejected({
        message: `unknown task ${request.taskId}`,
        code: "unknown_subject",
      });
    }
    const workflow = store.workflows.require(task.workflowId) as Workflow;
    const unresolvedBlockers = store.blockers
      .unresolvedForSubject("task", task.id)
      .map((blocker) => blocker.kind);
    const before = hashRecord(task);
    const base = {
      workflow,
      subjectKind: "task" as const,
      subjectId: task.id,
      fromState: task.status,
      toState: String(request.to),
      trigger: request.trigger,
      actor: request.actor,
      taskRevision: task.revision,
      gitRevision,
      evidenceRefs,
      beforeHash: before,
      afterHash: before,
    };

    const known = (TASK_STATES as readonly string[]).includes(String(request.to));
    if (!known) {
      reject(
        store,
        { ...base, transitionId: null, reasonCode: "unknown_state", failedGuards: [] },
        `"${request.to}" is not a task state`,
        now,
        newId,
      );
    }
    if ((TASK_TERMINAL_STATES as readonly string[]).includes(task.status)) {
      reject(
        store,
        { ...base, transitionId: null, reasonCode: "terminal_subject", failedGuards: [] },
        `task ${task.id} is ${task.status}: terminal states have no outgoing transitions`,
        now,
        newId,
      );
    }
    if (!TASK_TRIGGERS.includes(request.trigger)) {
      reject(
        store,
        { ...base, transitionId: null, reasonCode: "unknown_trigger", failedGuards: [] },
        `"${request.trigger}" is not a task trigger`,
        now,
        newId,
      );
    }
    const edge = findTaskTransition(task.status, request.to, request.trigger);
    if (edge === undefined) {
      reject(
        store,
        { ...base, transitionId: null, reasonCode: "unlisted_edge", failedGuards: [] },
        `no listed task transition ${task.status} -> ${request.to} on "${request.trigger}"`,
        now,
        newId,
      );
    }
    return commitTaskEdge({ request, task, workflow, edge, base, unresolvedBlockers });
  });
}

interface CommitTaskArgs {
  readonly request: TaskTransitionRequest;
  readonly task: Task;
  readonly workflow: Workflow;
  readonly edge: Transition<TaskStatus>;
  readonly base: Omit<EventDraft, "disposition" | "reasonCode" | "failedGuards" | "transitionId">;
  readonly unresolvedBlockers: readonly string[];
}

/** Actor, snapshot, evidence and guard checks, then the single write. */
function commitTaskEdge(args: CommitTaskArgs): TransitionResult<Task> {
  const { request, task, workflow, edge, unresolvedBlockers } = args;
  const { store, now, newId } = request;
  const base = { ...args.base, transitionId: edge.id };

  if (!edge.whoMayTrigger.includes(actorRole(request.actor))) {
    reject(
      store,
      { ...base, reasonCode: "unauthorized_actor", failedGuards: [] },
      `actor "${request.actor.kind}" may not trigger ${edge.id} (allowed: ${edge.whoMayTrigger.join(", ")})`,
      now,
      newId,
    );
  }
  if (
    request.expected !== undefined &&
    ((request.expected.status !== undefined && request.expected.status !== task.status) ||
      (request.expected.revision !== undefined && request.expected.revision !== task.revision))
  ) {
    reject(
      store,
      { ...base, reasonCode: "stale_snapshot", failedGuards: [] },
      `task ${task.id} moved: expected ${request.expected.status ?? task.status}@${
        request.expected.revision ?? task.revision
      }, found ${task.status}@${task.revision}`,
      now,
      newId,
    );
  }
  if (edge.requiredEvidence.length > 0 && base.evidenceRefs.length === 0) {
    reject(
      store,
      { ...base, reasonCode: "missing_evidence", failedGuards: [] },
      `${edge.id} requires evidence references (${edge.requiredEvidence.join("; ")}) and none were supplied`,
      now,
      newId,
    );
  }

  const context: GuardContext = {
    store,
    workflow,
    task,
    phase: store.phases.get(task.phaseId) ?? null,
    gitRevision: base.gitRevision,
    actor: request.actor,
    now: now(),
    evidenceRefs: base.evidenceRefs,
    unresolvedBlockers,
  };
  const guards = withStructuralGuards(request.guards ?? {}, context);
  const evaluation = evaluateGuards(edge.preconditions, guards, context);
  if (!evaluation.satisfied) {
    reject(
      store,
      { ...base, reasonCode: "precondition_failed", failedGuards: evaluation.failed },
      `${edge.id} rejected: unsatisfied precondition(s) ${evaluation.failed.join(", ")}`,
      now,
      newId,
    );
  }

  const blockerKind = applyTaskBlockerSideEffects(args);
  const updated = store.tasks.update(task.id, { status: request.to, blocker: blockerKind });
  const event = appendEvent(
    store,
    {
      ...base,
      afterHash: hashRecord(updated),
      disposition: "accepted",
      reasonCode: null,
      failedGuards: [],
    },
    now,
    newId,
  );
  return { subject: updated, event, transitionId: edge.id, sideEffects: edge.sideEffects };
}

/**
 * The blocker half of a task transition, and the reason `Task.blocker` is
 * never a caller-supplied string:
 *
 * - Entering `blocked` **requires** a blocker row. The request's `blocker`
 *   field creates one; if the caller supplied none, the unresolved rows that
 *   already exist are what keep the task blocked (the `blocker_present`
 *   structural guard has already refused the edge when there are neither).
 * - Leaving `blocked` for `ready` resolves the rows that were holding it
 *   — "clear resolved blocker" in the `task-ready` row. History is kept: the
 *   rows are resolved, not deleted.
 * - `Task.blocker` is then *derived* from the unresolved rows, so it cannot
 *   disagree with them.
 */
function applyTaskBlockerSideEffects(args: CommitTaskArgs): string | null {
  const { request, task } = args;
  const { store } = request;
  const at = request.now();

  if (request.blocker !== undefined) {
    store.blockers.insert({
      blockerId: request.newId(),
      createdAt: at,
      workflowId: task.workflowId,
      subjectKind: "task",
      subjectId: task.id,
      kind: request.blocker.kind,
      detail: request.blocker.detail,
      raisedBy: `${request.actor.kind}:${request.actor.identity}`,
      resolvedAt: null,
      resolvedBy: null,
      resolutionDetail: null,
    });
  }

  if (request.to === "ready" || request.to === "cancelled") {
    for (const blocker of store.blockers.unresolvedForSubject("task", task.id)) {
      store.blockers.resolve(blocker.blockerId, {
        at,
        by: `${request.actor.kind}:${request.actor.identity}`,
        detail: `resolved by ${args.edge.id}`,
      });
    }
  }

  return deriveBlockerField(store, "task", task.id);
}

/**
 * `Task.blocker`/`Phase` blocker text derived from the unresolved rows. The
 * record field holds one string, so several simultaneous reasons are joined
 * — the authoritative list is always the blocker table.
 */
export function deriveBlockerField(
  store: Store,
  subjectKind: TransitionSubjectKind,
  subjectId: string,
): string | null {
  const kinds = store.blockers.unresolvedForSubject(subjectKind, subjectId).map((b) => b.kind);
  return kinds.length === 0 ? null : [...new Set(kinds)].join(",");
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

/**
 * Request a phase transition. The only writer of `Phase.gateStatus`.
 *
 * Mirrors `transitionTask` row for row. The one extra concern is the
 * lifecycle/storage projection: the request names a lifecycle state
 * (`gating`), and the stored status is its first substage (`integrating`),
 * because "the projection is not permission to skip gating substages".
 */
export function transitionPhase(request: PhaseTransitionRequest): TransitionResult<Phase> {
  const { store, now, newId } = request;
  const evidenceRefs = request.evidenceRefs ?? [];
  const gitRevision = request.gitRevision ?? null;

  return store.write(() => {
    const phase = store.phases.get(request.phaseId);
    if (phase === undefined) {
      throw new TransitionRejected({ message: `unknown phase ${request.phaseId}`, code: "unknown_subject" });
    }
    const workflow = store.workflows.require(phase.workflowId) as Workflow;
    const from = phaseLifecycleState(phase.gateStatus);
    const before = hashRecord(phase);
    const base = {
      workflow,
      subjectKind: "phase" as const,
      subjectId: phase.id,
      fromState: from ?? phase.gateStatus,
      toState: String(request.to),
      trigger: request.trigger,
      actor: request.actor,
      taskRevision: null,
      gitRevision,
      evidenceRefs,
      beforeHash: before,
      afterHash: before,
    };

    if (from === undefined || !(PHASE_STATES as readonly string[]).includes(String(request.to))) {
      reject(
        store,
        { ...base, transitionId: null, reasonCode: "unknown_state", failedGuards: [] },
        from === undefined
          ? `phase ${phase.id} has unmapped gate status "${phase.gateStatus}"`
          : `"${request.to}" is not a phase state`,
        now,
        newId,
      );
    }
    if ((PHASE_TERMINAL_STATES as readonly string[]).includes(from)) {
      reject(
        store,
        { ...base, transitionId: null, reasonCode: "terminal_subject", failedGuards: [] },
        `phase ${phase.id} is ${from}: terminal states have no outgoing transitions`,
        now,
        newId,
      );
    }
    if (!PHASE_TRIGGERS.includes(request.trigger)) {
      reject(
        store,
        { ...base, transitionId: null, reasonCode: "unknown_trigger", failedGuards: [] },
        `"${request.trigger}" is not a phase trigger`,
        now,
        newId,
      );
    }
    const edge = findPhaseTransition(from, request.to, request.trigger);
    if (edge === undefined) {
      reject(
        store,
        { ...base, transitionId: null, reasonCode: "unlisted_edge", failedGuards: [] },
        `no listed phase transition ${from} -> ${request.to} on "${request.trigger}"`,
        now,
        newId,
      );
    }
    return commitPhaseEdge({ request, phase, workflow, edge, base, from });
  });
}

interface CommitPhaseArgs {
  readonly request: PhaseTransitionRequest;
  readonly phase: Phase;
  readonly workflow: Workflow;
  readonly edge: Transition<PhaseState>;
  readonly base: Omit<EventDraft, "disposition" | "reasonCode" | "failedGuards" | "transitionId">;
  readonly from: PhaseState;
}

function commitPhaseEdge(args: CommitPhaseArgs): TransitionResult<Phase> {
  const { request, phase, workflow, edge } = args;
  const { store, now, newId } = request;
  const base = { ...args.base, transitionId: edge.id };

  if (!edge.whoMayTrigger.includes(actorRole(request.actor))) {
    reject(
      store,
      { ...base, reasonCode: "unauthorized_actor", failedGuards: [] },
      `actor "${request.actor.kind}" may not trigger ${edge.id} (allowed: ${edge.whoMayTrigger.join(", ")})`,
      now,
      newId,
    );
  }
  if (request.expected?.status !== undefined && request.expected.status !== args.from) {
    reject(
      store,
      { ...base, reasonCode: "stale_snapshot", failedGuards: [] },
      `phase ${phase.id} moved: expected ${request.expected.status}, found ${args.from}`,
      now,
      newId,
    );
  }
  if (edge.requiredEvidence.length > 0 && base.evidenceRefs.length === 0) {
    reject(
      store,
      { ...base, reasonCode: "missing_evidence", failedGuards: [] },
      `${edge.id} requires evidence references (${edge.requiredEvidence.join("; ")}) and none were supplied`,
      now,
      newId,
    );
  }

  const context: GuardContext = {
    store,
    workflow,
    task: null,
    phase,
    gitRevision: base.gitRevision,
    actor: request.actor,
    now: now(),
    evidenceRefs: base.evidenceRefs,
    unresolvedBlockers: store.blockers.unresolvedForSubject("phase", phase.id).map((b) => b.kind),
  };
  const evaluation = evaluateGuards(edge.preconditions, withStructuralGuards(request.guards ?? {}, context), context);
  if (!evaluation.satisfied) {
    reject(
      store,
      { ...base, reasonCode: "precondition_failed", failedGuards: evaluation.failed },
      `${edge.id} rejected: unsatisfied precondition(s) ${evaluation.failed.join(", ")}`,
      now,
      newId,
    );
  }

  if (request.blocker !== undefined) {
    store.blockers.insert({
      blockerId: newId(),
      createdAt: now(),
      workflowId: phase.workflowId,
      subjectKind: "phase",
      subjectId: phase.id,
      kind: request.blocker.kind,
      detail: request.blocker.detail,
      raisedBy: `${request.actor.kind}:${request.actor.identity}`,
      resolvedAt: null,
      resolvedBy: null,
      resolutionDetail: null,
    });
  }

  const unresolved = store.blockers.unresolvedForSubject("phase", phase.id).map((b) => b.kind);
  const updated = store.phases.update(phase.id, { gateStatus: phaseGateStatusFor(request, edge, unresolved) });
  const event = appendEvent(
    store,
    { ...base, afterHash: hashRecord(updated), disposition: "accepted", reasonCode: null, failedGuards: [] },
    now,
    newId,
  );
  return { subject: updated, event, transitionId: edge.id, sideEffects: edge.sideEffects };
}

/**
 * Stored gate status for an accepted phase edge.
 *
 * `paused` is stored as `paused_cap` when the pause is a cap or budget stop
 * and `paused_approval` otherwise (docs/state-machine.md §1: "Budget stops
 * use `paused_cap` with a **budget** reason, not `all_candidates_capped`").
 * `phase-stale-evidence` returns the substage to `verifying` rather than
 * leaving it where it was.
 */
function phaseGateStatusFor(
  request: PhaseTransitionRequest,
  edge: Transition<PhaseState>,
  unresolvedBlockerKinds: readonly string[],
): PhaseGateStatus {
  if (edge.id === "phase-stale-evidence") return "verifying";
  if (request.to === "paused") {
    const capLike =
      edge.trigger === "all_candidates_capped" ||
      unresolvedBlockerKinds.some((kind) => CAP_BLOCKER_KINDS.includes(kind));
    return capLike ? "paused_cap" : "paused_approval";
  }
  return phaseStorageStatus(request.to);
}

/** Blocker kinds that store a phase pause as `paused_cap` rather than `paused_approval`. */
export const CAP_BLOCKER_KINDS: readonly string[] = ["all_candidates_capped", "budget_hard_stop"];

/**
 * Advance a gating phase to its next substage (`integrating` → `verifying`
 * → `review`). This is not a lifecycle transition — the phase stays `gating`
 * — but it is still only writable here, because a phase that jumped straight
 * to `review` would let `phase-done` be requested without the merged checks
 * having run.
 */
export function advanceGatingSubstage(args: {
  readonly store: Store;
  readonly phaseId: PhaseId;
  readonly now: () => IsoTimestamp;
}): Phase {
  const { store } = args;
  return store.write(() => {
    const phase = store.phases.require(args.phaseId) as Phase;
    const index = (GATING_SUBSTAGES as readonly PhaseGateStatus[]).indexOf(phase.gateStatus);
    if (index < 0) {
      throw new TransitionRejected({
        message: `phase ${phase.id} is "${phase.gateStatus}", not gating: substages advance only within gating`,
        code: "unlisted_edge",
      });
    }
    const next = GATING_SUBSTAGES[index + 1] as PhaseGateStatus | undefined;
    if (next === undefined) {
      throw new TransitionRejected({
        message: `phase ${phase.id} is already at the last gating substage "${phase.gateStatus}"; ` +
          `completion is phase-done, which re-evaluates the whole PHASE_DONE conjunction`,
        code: "unlisted_edge",
      });
    }
    return store.phases.update(phase.id, { gateStatus: next });
  });
}

/** Is the phase at the last gating substage, i.e. may `phase-done` be requested? */
export function isGateReviewStage(phase: Pick<Phase, "gateStatus">): boolean {
  return phase.gateStatus === GATING_SUBSTAGES[GATING_SUBSTAGES.length - 1];
}

/** Task ids whose status is not terminal, for the §5 "affected T*" rules. */
export function nonterminalTasks(store: Store, workflowId: WorkflowId): readonly Task[] {
  return store.tasks
    .findBy("workflowId", workflowId)
    .filter((task) => !(TASK_TERMINAL_STATES as readonly string[]).includes(task.status));
}

/** Phases of a workflow whose lifecycle state is not terminal. */
export function nonterminalPhases(store: Store, workflowId: WorkflowId): readonly Phase[] {
  return store.phases.forWorkflow(workflowId).filter((phase) => {
    const state = phaseLifecycleState(phase.gateStatus);
    return state !== undefined && !(PHASE_TERMINAL_STATES as readonly string[]).includes(state);
  });
}
