/**
 * Dependency-aware scheduler (issue #75; PLAN §3.E "Single-worker,
 * sequential, parallel, and dependency-aware workflows. Enforce concurrency
 * limits." and "Declared ownership conflicts detected in code; Jev adds a
 * semantic-coupling signal; default to serial when coupling is uncertain").
 *
 * This module turns the persisted task graph into a stream of dispatches. It
 * does not re-derive anything that already exists on main:
 *
 * - dependency order and the ready set come from `graph.ts` (#40);
 * - every task status write goes through `state.ts` (#41) — including the
 *   claim, so a second claim of the same task loses on the stale-snapshot
 *   check rather than on a mutex invented here;
 * - the concurrency ceiling is enforced by the #30 ledger's atomic
 *   `BEGIN IMMEDIATE` reservation, which is what makes two schedulers safe;
 *   the in-process count below is a *pre-filter*, never the authority;
 * - worker launch, progress and crash reconciliation are #68/#71/#72 and
 *   reach this module only through the injected `dispatch` hook.
 *
 * Pi's RPC `prompt` is asynchronous — it returns on acceptance and events
 * stream afterwards — so `dispatch` returns a promise that the loop keeps
 * in flight. N workers therefore run concurrently from one coordinator; the
 * loop never awaits one dispatch before starting the next.
 */
import type { PhaseId, Task, TaskId, WorkflowId } from "../storage/records.ts";
import type { Store } from "../storage/db.ts";
import type { IsoTimestamp } from "../storage/records.ts";
import type { TransitionActor } from "../storage/transition-log.ts";
import { readySet, topoOrder } from "./graph.ts";
import { couplingSignalFrom, pathsIntersect, type CouplingCache } from "./coupling.ts";
import { hasExecutableCheck, TransitionRejected, transitionTask } from "./state.ts";

/** Why a ready task was not dispatched on this pass. */
export type HoldReason =
  | "concurrency_cap"
  | "ownership_conflict"
  | "coupling_uncertain"
  | "coupled"
  | "budget_refused"
  | "claim_lost"
  | "cancelled";

/** A task the scheduler considered but did not dispatch, and why. */
export interface HeldTask {
  readonly taskId: TaskId;
  readonly reason: HoldReason;
  readonly detail: string;
}

/** Semantic-coupling verdict for a pair of tasks (Jev's signal, #78/PLAN §3.E). */
export type CouplingVerdict = "independent" | "coupled" | "unknown";

/** What the scheduler is allowed to run right now, and what it is holding back. */
export interface DispatchPlan {
  readonly dispatch: readonly TaskId[];
  readonly held: readonly HeldTask[];
  /** In-flight count the plan was computed against. */
  readonly inFlight: number;
  /** Effective ceiling; `null` means uncapped by config. */
  readonly limit: number | null;
}

// ---------------------------------------------------------------------------
// Declared ownership overlap (PLAN §3.E, "detected in code")
// ---------------------------------------------------------------------------

/** The declared paths and components two tasks both claim. */
export interface OwnershipOverlap {
  readonly paths: readonly string[];
  readonly components: readonly string[];
}

/**
 * Declared ownership overlap between two tasks: exactly the paths and
 * components both `Task.ownership` lists name. No normalisation beyond
 * pattern intersection.
 *
 * Path comparison is delegated to `coupling.ts` (#76), which decides whether
 * two declared *patterns* could ever match a common file: identical strings,
 * subtree containment (`src/workflow` vs `src/workflow/graph.ts`) and glob
 * intersection all count. Exact string equality, which is what this function
 * used before #76, matched only the first of those. `plan-schema.ts` still
 * warns on the exact-equality case at plan time; this is a strict superset,
 * so the two cannot disagree about a pair the planner warned on.
 */
export function ownershipOverlap(a: Task, b: Task): OwnershipOverlap {
  const components = new Set(a.ownership.components);
  return {
    paths: b.ownership.paths.filter((pb) => a.ownership.paths.some((pa) => pathsIntersect(pa, pb) !== null)),
    components: b.ownership.components.filter((c) => components.has(c)),
  };
}

/** `true` when the two tasks declare any path or component in common. */
export function conflictsOnOwnership(a: Task, b: Task): boolean {
  const overlap = ownershipOverlap(a, b);
  return overlap.paths.length > 0 || overlap.components.length > 0;
}

/**
 * Semantic-coupling signal, supplied by the caller (Jev, issue #78).
 *
 * Returning `"unknown"` — or having no signal at all, which is what happens
 * with no Jev key — means the pair is treated as coupled and therefore
 * serialised: PLAN §3.E's "default to serial when coupling is uncertain".
 * The deterministic fallback is the conservative one, so the product works
 * unchanged with Jev disabled.
 */
export type CouplingSignal = (a: Task, b: Task) => CouplingVerdict;

/** The no-Jev default: every pair is uncertain, so every pair serialises. */
export const UNCERTAIN_COUPLING: CouplingSignal = () => "unknown";

/**
 * The signal one pass uses: the #76 cache when one was supplied, otherwise
 * the caller's raw signal, otherwise the uncertain default. When both a
 * cache and a signal are given, `couplingSignalFrom` prefers the cached
 * verdict and falls back to the signal on a miss.
 */
function resolveCouplingSignal(params: PlanPassParams): CouplingSignal {
  if (params.couplingCache === undefined) return params.coupling ?? UNCERTAIN_COUPLING;
  return couplingSignalFrom({
    cache: params.couplingCache,
    ...(params.coupling === undefined ? {} : { signal: params.coupling }),
  });
}

/**
 * May `candidate` run at the same time as `other`? Declared ownership
 * overlap is decided in code and is not overridable by any signal — a
 * coupling verdict of `"independent"` cannot unblock two tasks that both
 * claim `src/foo.ts`. Only when there is no declared overlap does the
 * semantic signal get a say, and there `unknown` means no.
 */
export function mayRunConcurrently(
  candidate: Task,
  other: Task,
  coupling: CouplingSignal,
): { readonly ok: boolean; readonly reason: HoldReason | null; readonly detail: string } {
  const overlap = ownershipOverlap(candidate, other);
  if (overlap.paths.length > 0 || overlap.components.length > 0) {
    const what = [...overlap.paths, ...overlap.components].join(", ");
    return {
      ok: false,
      reason: "ownership_conflict",
      detail: `task ${candidate.id} and ${other.id} both declare ownership of ${what}`,
    };
  }
  const verdict = coupling(candidate, other);
  if (verdict === "coupled") {
    return {
      ok: false,
      reason: "coupled",
      detail: `task ${candidate.id} is semantically coupled to ${other.id}; running serially`,
    };
  }
  if (verdict === "unknown") {
    return {
      ok: false,
      reason: "coupling_uncertain",
      detail:
        `coupling between ${candidate.id} and ${other.id} is uncertain; ` +
        `defaulting to serial (PLAN §3.E)`,
    };
  }
  return { ok: true, reason: null, detail: "" };
}

// ---------------------------------------------------------------------------
// Ready-task selection
// ---------------------------------------------------------------------------

/** Inputs to one scheduling pass. Everything is read fresh from the store. */
export interface PlanPassParams {
  readonly store: Store;
  readonly phaseIds: readonly PhaseId[];
  /** Tasks already dispatched by this loop and not yet settled. */
  readonly inFlight: readonly TaskId[];
  /** Concurrency ceiling from config (`budgets.workflow.maxConcurrency`); `null` = uncapped. */
  readonly limit: number | null;
  /** Semantic-coupling signal; omitted means "uncertain", i.e. serial. */
  readonly coupling?: CouplingSignal;
  /**
   * Memoised `tasks.coupling@1` verdicts (#76). Consulted before `coupling`
   * and, like it, only for pairs whose declared ownership is already
   * disjoint. A pair the cache has never seen reads as `"unknown"` and
   * therefore serialises, so passing a cold cache is exactly as safe as
   * passing none.
   */
  readonly couplingCache?: CouplingCache;
}

/**
 * The tasks that may be dispatched right now, computed from a **freshly
 * read** task set — never from a ready-set the caller cached. A stale ready
 * set is how a dependency that failed after the last pass gets its dependent
 * dispatched anyway, so this function takes ids and re-reads the rows.
 *
 * Order of restriction, all of which must hold:
 *  1. `graph.readySet` — every dependency `done`, no cycle (#40);
 *  2. `state.hasExecutableCheck` — #37's rule, the same predicate #41's
 *     `checks_registered` guard uses, so a task the transition would refuse
 *     is not offered here either;
 *  3. topological order from `graph.topoOrder`, so dispatch order is stable
 *     and dependency-respecting;
 *  4. ownership/coupling against both in-flight tasks and the tasks already
 *     selected on this pass;
 *  5. the concurrency ceiling.
 *
 * This is a pure projection: it writes nothing. The claim that actually
 * prevents a duplicate dispatch is `claimTask` below.
 */
export function planPass(params: PlanPassParams): DispatchPlan {
  const { store, phaseIds, limit } = params;
  const coupling = resolveCouplingSignal(params);
  const inFlight = [...new Set(params.inFlight)];

  const tasks = phaseIds.flatMap((phaseId) => store.tasks.forPhase(phaseId));
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const held: HeldTask[] = [];

  const order = topoOrder(tasks);
  const rank = new Map(order.order.map((id, index) => [id, index] as const));
  const ready = [...readySet(tasks)].sort(
    (a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
  );

  // Held tasks the loop must not run alongside: in-flight ones plus the ones
  // selected on this same pass.
  const blocking: Task[] = inFlight.flatMap((id) => {
    const task = byId.get(id);
    return task === undefined ? [] : [task];
  });
  const selected: TaskId[] = [];

  for (const taskId of ready) {
    const task = byId.get(taskId);
    if (task === undefined) continue;
    if (!hasExecutableCheck(task)) {
      held.push({
        taskId,
        reason: "claim_lost",
        detail: `task ${taskId} has no executable check and cannot be dispatched (PLAN §2.3)`,
      });
      continue;
    }
    if (limit !== null && inFlight.length + selected.length >= limit) {
      held.push({
        taskId,
        reason: "concurrency_cap",
        detail: `concurrency limit ${limit} reached`,
      });
      continue;
    }
    const conflict = blocking
      .map((other) => mayRunConcurrently(task, other, coupling))
      .find((verdict) => !verdict.ok);
    if (conflict !== undefined && conflict.reason !== null) {
      held.push({ taskId, reason: conflict.reason, detail: conflict.detail });
      continue;
    }
    selected.push(taskId);
    blocking.push(task);
  }

  return { dispatch: selected, held, inFlight: inFlight.length, limit };
}

// ---------------------------------------------------------------------------
// Claiming: the duplicate-dispatch prevention
// ---------------------------------------------------------------------------

export interface ClaimParams {
  readonly store: Store;
  readonly taskId: TaskId;
  readonly actor: TransitionActor;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
  /** `authorization_current` (PLAN §2.4); resolved by the caller against live approvals. */
  readonly authorizationCurrent: (task: Task) => boolean;
  /**
   * `dispatch_allowed`: allowlist, pin, capability, budget and model
   * availability. Supplied by the caller because those live in `models/`
   * (#60, #63, #65) and `telemetry/` (#30), not here. Ownership is the one
   * part of that precondition this module decides, and `planPass` has
   * already decided it for the ids it returns.
   */
  readonly dispatchAllowed: (task: Task) => boolean;
  readonly evidenceRefs?: readonly string[];
}

/** Outcome of a claim attempt. `ok: false` is an ordinary, expected result. */
export interface ClaimResult {
  readonly taskId: TaskId;
  readonly ok: boolean;
  readonly task: Task | null;
  readonly reason: string | null;
}

/**
 * Claim a ready task for dispatch: `task-dispatch` (`ready` → `running`)
 * through `state.ts`, the only writer of `Task.status`.
 *
 * **This is what prevents a duplicate dispatch**, and it is worth being
 * precise about how, because it is not a lock this module holds. The
 * transition runs inside the store's write transaction and carries
 * `expected: { status: "ready", revision }` — the snapshot the scheduler
 * selected against. Two claims of the same task therefore serialise in
 * SQLite: the first commits `running`, and the second finds the row no
 * longer `ready`, is rejected with `stale_snapshot`, and returns `ok: false`
 * here. No in-process set could give that guarantee across two coordinator
 * processes; the transaction does.
 *
 * A rejected claim is returned, not thrown: losing a race is a normal
 * scheduling outcome and the loop simply moves on to the next ready task.
 */
export function claimTask(params: ClaimParams): ClaimResult {
  const { store, taskId, actor, now, newId } = params;
  const task = store.tasks.get(taskId);
  if (task === undefined) {
    return { taskId, ok: false, task: null, reason: `unknown task ${taskId}` };
  }
  if (task.status !== "ready") {
    return {
      taskId,
      ok: false,
      task: null,
      reason: `task ${taskId} is ${task.status}, not ready: nothing to claim`,
    };
  }
  try {
    const result = transitionTask({
      store,
      taskId,
      to: "running",
      trigger: "dispatch",
      actor,
      now,
      newId,
      // The snapshot the selection was made against. If the row moved
      // underneath us — another coordinator claimed it, or it was blocked —
      // the transition is refused rather than applied to a changed subject.
      expected: { status: "ready", revision: task.revision },
      evidenceRefs: params.evidenceRefs ?? [`dispatch:${taskId}@${task.revision}`],
      guards: {
        authorization_current: () => params.authorizationCurrent(task),
        dispatch_allowed: () => params.dispatchAllowed(task),
      },
    });
    return { taskId, ok: true, task: result.subject, reason: null };
  } catch (error) {
    if (error instanceof TransitionRejected) {
      return { taskId, ok: false, task: null, reason: error.message };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** One dispatched task, as reported by the caller's worker layer. */
export interface DispatchOutcome {
  readonly taskId: TaskId;
  /** `true` when the worker ran to a settled end; `false` on any failure. */
  readonly ok: boolean;
  readonly detail?: string;
}

/** What one `runScheduler` call did. */
export interface SchedulerResult {
  readonly dispatched: readonly TaskId[];
  readonly outcomes: readonly DispatchOutcome[];
  /** Tasks held back on the final pass, with the reason each was held. */
  readonly held: readonly HeldTask[];
  /** Highest number of workers in flight at any instant during the run. */
  readonly peakConcurrency: number;
  /** `true` when the loop stopped because cancellation was requested. */
  readonly cancelled: boolean;
  /** Tasks the drain moved to `cancelled`. */
  readonly cancelledTasks: readonly TaskId[];
}

/** A budget reservation the scheduler holds for the life of one dispatch. */
export interface DispatchReservation {
  /** Called exactly once when the dispatch settles, however it settles. */
  readonly release: () => void;
}

export interface RunSchedulerParams extends ClaimHooks {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly phaseIds: readonly PhaseId[];
  /**
   * Concurrency ceiling from config (`budgets.workflow.maxConcurrency`).
   * `null` means config sets no ceiling — the ledger's own reservation is
   * still the authority, via `reserve` below.
   */
  readonly limit: number | null;
  /**
   * Atomic budget reservation (#30 `Ledger.reserve`). Return `null` to refuse
   * the dispatch: the task is held with `budget_refused` and the loop does
   * not spawn a worker for it. This, not the in-process counter, is what
   * makes two schedulers safe against the same remaining budget — the
   * counter cannot see another process.
   */
  readonly reserve: (task: Task) => DispatchReservation | null;
  /**
   * Launch the worker (#68/#71 over Pi RPC, ADR 0004). Pi's `prompt` is
   * asynchronous, so this returns as soon as the worker is accepted and the
   * promise settles when the attempt does. The loop keeps N of these in
   * flight at once and never awaits one before starting the next.
   */
  readonly dispatch: (task: Task) => Promise<DispatchOutcome>;
  readonly coupling?: CouplingSignal;
  /** Cooperative cancellation. Polled between passes and before each claim. */
  readonly signal?: { readonly aborted: boolean };
  /** Asks a running worker to stop. Awaited during the drain. */
  readonly cancelWorker?: (taskId: TaskId) => Promise<void> | void;
}

/** The claim-time hooks `runScheduler` forwards to `claimTask`. */
export interface ClaimHooks {
  readonly actor: TransitionActor;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
  readonly authorizationCurrent: (task: Task) => boolean;
  readonly dispatchAllowed: (task: Task) => boolean;
}

interface InFlightEntry {
  readonly taskId: TaskId;
  readonly settled: Promise<DispatchOutcome>;
}

interface PassResult {
  readonly started: number;
  readonly holds: readonly HeldTask[];
}

/**
 * Reserve, claim and launch every task the plan selected, in order, adding
 * each to `inFlight`. Returns how many actually started plus the holds that
 * only became visible at claim time (a lost race, a refused reservation).
 *
 * Nothing here awaits a worker: `dispatch` is started and its promise stored.
 * That is the whole point of Pi's asynchronous `prompt` — acceptance is fast,
 * events stream later, so one coordinator holds N of these open at once.
 */
function startPass(
  plan: DispatchPlan,
  params: RunSchedulerParams,
  inFlight: Map<TaskId, InFlightEntry>,
  dispatched: TaskId[],
): PassResult {
  const holds: HeldTask[] = [];
  let started = 0;

  for (const taskId of plan.dispatch) {
    if (params.signal?.aborted === true) {
      holds.push({ taskId, reason: "cancelled", detail: "cancellation requested; no new dispatch" });
      continue;
    }
    const selected = params.store.tasks.get(taskId);
    if (selected === undefined) {
      holds.push({ taskId, reason: "claim_lost", detail: `task ${taskId} no longer exists` });
      continue;
    }

    // The atomic reservation is taken *before* the status claim, so a refusal
    // leaves the task exactly where it was: `ready`, and dispatchable on a
    // later pass once budget frees up. Claiming first would strand it in
    // `running` with no worker, and `state.ts` has no edge back to `ready`.
    const reservation = params.reserve(selected);
    if (reservation === null) {
      holds.push({
        taskId,
        reason: "budget_refused",
        detail: `budget reservation refused for task ${taskId}; not dispatched`,
      });
      continue;
    }

    const claim = claimTask({
      store: params.store,
      taskId,
      actor: params.actor,
      now: params.now,
      newId: params.newId,
      authorizationCurrent: params.authorizationCurrent,
      dispatchAllowed: params.dispatchAllowed,
    });
    if (!claim.ok || claim.task === null) {
      // Lost the race (or a guard refused): give the budget straight back so
      // a refused claim cannot shrink the remaining budget.
      reservation.release();
      holds.push({ taskId, reason: "claim_lost", detail: claim.reason ?? "claim refused" });
      continue;
    }
    const task = claim.task;

    const settled = startDispatch(params, task, reservation);
    inFlight.set(taskId, { taskId, settled });
    dispatched.push(taskId);
    started += 1;
  }
  return { started, holds };
}

/**
 * Start one worker and guarantee its reservation is released exactly once,
 * whether the dispatch resolves, rejects, or the process asks it to stop. A
 * reservation leaked on a rejected dispatch would permanently shrink the
 * remaining concurrency for every later task.
 */
function startDispatch(
  params: RunSchedulerParams,
  task: Task,
  reservation: DispatchReservation,
): Promise<DispatchOutcome> {
  let releaseD = false;
  const release = (): void => {
    if (releaseD) return;
    releaseD = true;
    reservation.release();
  };
  return Promise.resolve()
    .then(() => params.dispatch(task))
    .then(
      (outcome) => {
        release();
        return outcome;
      },
      (error: unknown) => {
        release();
        return {
          taskId: task.id,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        } satisfies DispatchOutcome;
      },
    );
}

/**
 * Wait for everything still running to settle, asking each worker to stop
 * first when the loop is draining because of a cancellation. Returns the
 * outcomes and the ids that were in flight, so the caller can cancel their
 * task rows.
 */
async function drainInFlight(
  inFlight: Map<TaskId, InFlightEntry>,
  params: RunSchedulerParams,
  cancelling: boolean,
): Promise<{ readonly outcomes: readonly DispatchOutcome[]; readonly taskIds: readonly TaskId[] }> {
  const taskIds: readonly TaskId[] = [...inFlight.keys()];
  if (cancelling && params.cancelWorker !== undefined) {
    const cancelWorker = params.cancelWorker;
    await Promise.all(taskIds.map(async (id) => cancelWorker(id)));
  }
  const outcomes = await Promise.all([...inFlight.values()].map((e) => e.settled));
  inFlight.clear();
  return { outcomes, taskIds };
}

/**
 * Run the dependency-aware dispatch loop until no task can be dispatched and
 * nothing is in flight, or until cancellation is requested.
 *
 * Each pass: re-read the tasks, recompute the ready set through `graph.ts`,
 * claim each selected task transactionally, reserve budget, and start the
 * worker **without awaiting it**. Only when the pass has nothing further to
 * start does the loop await the *first* settlement (`Promise.race`) and go
 * round again — so a completed task's dependents are admitted as soon as it
 * finishes, while its siblings keep running.
 *
 * The ready set is recomputed from the store on every pass. Nothing is
 * carried over between passes, which is what "never schedule from a stale
 * ready-set" means operationally: a task whose dependency failed while this
 * pass was running simply does not appear in the next one.
 */
export async function runScheduler(params: RunSchedulerParams): Promise<SchedulerResult> {
  const { store, phaseIds, limit } = params;
  const inFlight = new Map<TaskId, InFlightEntry>();
  const dispatched: TaskId[] = [];
  const outcomes: DispatchOutcome[] = [];
  let held: readonly HeldTask[] = [];
  let peakConcurrency = 0;
  let cancelled = false;

  const aborted = (): boolean => params.signal?.aborted === true;

  while (true) {
    if (aborted()) {
      cancelled = true;
      break;
    }

    const plan = planPass({
      store,
      phaseIds,
      inFlight: [...inFlight.keys()],
      limit,
      coupling: params.coupling ?? UNCERTAIN_COUPLING,
    });
    held = plan.held;

    const startedThisPass = startPass(plan, params, inFlight, dispatched);
    if (startedThisPass.holds.length > 0) held = [...held, ...startedThisPass.holds];
    peakConcurrency = Math.max(peakConcurrency, inFlight.size);

    if (inFlight.size === 0) {
      // Nothing running and nothing startable: either the phase is complete
      // or everything left is blocked. Either way this loop is done; it is
      // not the scheduler's job to invent a way forward.
      if (startedThisPass.started === 0) break;
      continue;
    }
    if (startedThisPass.started > 0) continue;

    // Nothing more can start right now, so wait for the first worker to
    // settle before recomputing. Awaiting the race (not each dispatch in
    // turn) is what keeps the other N-1 workers running.
    const settled = await Promise.race([...inFlight.values()].map((e) => e.settled));
    inFlight.delete(settled.taskId);
    outcomes.push(settled);
  }

  const drain = await drainInFlight(inFlight, params, cancelled);
  outcomes.push(...drain.outcomes);

  // Every task this scheduler dispatched is offered to the cancel edge, not
  // just the ones still in flight at the instant of the drain: a worker that
  // settled while cancellation was propagating left its task `running` with
  // nobody to carry it further, and leaving that behind would be the
  // "half-cancelled run" the acceptance criterion rules out. Tasks that
  // legitimately moved on are refused by the edge and skipped.
  const cancelledTasks = cancelled ? cancelRemaining(params, dispatched) : [];
  return { dispatched, outcomes, held, peakConcurrency, cancelled, cancelledTasks };
}

/**
 * Move the tasks this run dispatched to `cancelled`, through `state.ts`'s
 * `task-cancel` edge — the same single writer used everywhere else, so the
 * transition is recorded and the worktree and artifacts are retained
 * (`task-cancel` side effects).
 *
 * A task that reached a terminal state before the drain got to it (`done`,
 * or already `cancelled`) is left alone rather than forced: `state.ts`
 * refuses the edge and that refusal is the correct answer, not an error to
 * swallow. Only the ids actually moved are returned. Everything this run
 * never dispatched is untouched and still `ready`, which is what lets
 * `/korwf run` be re-invoked and resume.
 */
function cancelRemaining(params: RunSchedulerParams, taskIds: readonly TaskId[]): readonly TaskId[] {
  const out: TaskId[] = [];
  for (const taskId of taskIds) {
    try {
      transitionTask({
        store: params.store,
        taskId,
        to: "cancelled",
        trigger: "cancel",
        actor: params.actor,
        now: params.now,
        newId: params.newId,
        evidenceRefs: [`cancel:${taskId}`, "scheduler:cancellation_requested"],
        guards: { cancellation_requested: () => true },
      });
      out.push(taskId);
    } catch (error) {
      if (error instanceof TransitionRejected) continue;
      throw error;
    }
  }
  return out;
}
