/**
 * Persisting a validated `PlanDocument` into `Phase` and `Task` records
 * (issue #37; PLAN §2.2, §3.C; docs/records.md §5).
 *
 * Rules this module implements, all of them in code rather than convention:
 *
 * - **Nothing partial ever lands.** Every write happens inside one
 *   `store.write()` transaction; a rejected record rolls the whole plan back.
 * - **A task with no checks is `proposed` with blocker `no_checks`** (PLAN
 *   §2.3). Persisting it any other way is impossible: the status is derived
 *   from `taskReadiness`, not supplied by the caller.
 * - **Re-planning produces revision N+1.** `Workflow.planRevision` is bumped,
 *   tasks that survive keep their id (bumping `Task.revision` only when
 *   `goal`/`acceptanceCriteria`/`checks` changed, per docs/records.md §5.1),
 *   tasks that disappear are marked `cancelled` with blocker `superseded`, and
 *   every approval invalidated by those changes is written in the same
 *   transaction.
 *
 * The store is the only writer (ADR 0006); this module holds no connection of
 * its own and never runs git.
 */
import type { Store } from "../storage/db.ts";
import type {
  AcceptanceCriterion,
  ApprovalInvalidation,
  CheckDefinition,
  IsoTimestamp,
  Phase,
  PhaseId,
  Task,
  TaskId,
  TaskStatus,
  Workflow,
  WorkflowId,
} from "../storage/records.ts";
import { RECORDS_SCHEMA_VERSION } from "../storage/records.ts";
import { canonicalJson } from "../storage/repos/base.ts";
import {
  NO_CHECKS_BLOCKER,
  OUTPUT_BUDGET_BLOCKER,
  WEAK_CHECK_BLOCKER,
  SUPERSEDED_BLOCKER,
  taskReadiness,
  type PlanDocument,
  type PlanTask,
} from "./plan-schema.ts";
import { validateGraph } from "./graph.ts";

/** Branch name used when the planner declares no integration branch. */
export function defaultIntegrationBranch(phaseOrder: number): string {
  return `korwf/phase-${phaseOrder}`;
}

/** Status a freshly persisted task gets: never `ready`, per PLAN §2.3 and the state machine. */
export const INITIAL_TASK_STATUS: TaskStatus = "proposed";

/** Mapping from a planner-local id to the record id it was persisted as. */
export interface IdMapping {
  readonly phases: ReadonlyMap<string, PhaseId>;
  readonly tasks: ReadonlyMap<string, TaskId>;
}

/** What one `persistPlan` call did. */
export interface PersistPlanResult {
  readonly workflowId: WorkflowId;
  readonly planRevision: number;
  readonly phases: readonly Phase[];
  readonly tasks: readonly Task[];
  /** Task ids persisted `proposed` with the `no_checks` blocker (PLAN §2.3). */
  readonly blockedForNoChecks: readonly TaskId[];
  /** Task ids persisted `proposed` with the `output_budget` blocker (#124). */
  readonly blockedForOutputBudget: readonly TaskId[];
  /** Task ids persisted `proposed` with the `weak_check` blocker (#44). */
  readonly blockedForWeakChecks: readonly TaskId[];
  /** Tasks present in the previous revision and absent from this one. */
  readonly supersededTasks: readonly TaskId[];
  /** Tasks whose revision was bumped because their definition of done changed. */
  readonly revisedTasks: readonly TaskId[];
  /** Approvals invalidated by this write, with the reason each was given. */
  readonly invalidatedApprovals: readonly { readonly approvalId: string; readonly reason: ApprovalInvalidation["reason"] }[];
  readonly idMapping: IdMapping;
}

export interface PersistPlanOptions {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly plan: PlanDocument;
  /** Clock, injected so persistence is replayable in tests. */
  readonly now: () => IsoTimestamp;
  /** Id generator for new records. Must return unique opaque strings. */
  readonly newId: (kind: "phase" | "task") => string;
  /** Git revision the phases integrate onto; defaults to `Workflow.baseRevision`. */
  readonly baseRevision?: string;
  /**
   * Planner-local ids of tasks whose expected output cannot be produced within
   * the worker model's per-turn ceiling as planned (#124) — pass
   * `tasksNeedingDecomposition(sizePlanTasks(plan, limits))`.
   *
   * Such a task is persisted `proposed` with the `output_budget` blocker: a
   * worker dispatched on it would be truncated before its tool call is
   * emitted and would write nothing, so it must be split first. The
   * `no_checks` blocker takes precedence, since a task with neither checks nor
   * a feasible size needs checks before anything else.
   */
  readonly outputBudgetBlocked?: readonly string[];
}

/** Thrown when a plan cannot be persisted. The transaction is already rolled back. */
export class PlanPersistError extends Error {
  override readonly name = "PlanPersistError";
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Record construction
// ---------------------------------------------------------------------------

function toCriteria(criteria: readonly { id: string; text: string }[]): readonly AcceptanceCriterion[] {
  return criteria.map((c) => ({ id: c.id, text: c.text }));
}

function toChecks(task: PlanTask): readonly CheckDefinition[] {
  return task.checks.map((c) => ({
    id: c.id,
    kind: c.kind,
    command: c.command,
    cwd: c.cwd,
    expectedExitCode: c.expectedExitCode,
    coversCriteria: c.coversCriteria,
    required: c.required,
  }));
}

/**
 * Status and blocker for a task about to be written.
 *
 * There is no parameter that can make this return `ready`: readiness is a
 * transition the engine performs later, and PLAN §2.3's rule is applied here
 * as well so a checkless task carries its blocker from the moment it exists.
 */
export function initialStatusFor(
  task: PlanTask,
  outputBudgetBlocked: ReadonlySet<string> = new Set(),
): { status: TaskStatus; blocker: string | null } {
  const readiness = taskReadiness(task);
  if (!readiness.canBecomeReady) {
    return { status: INITIAL_TASK_STATUS, blocker: readiness.blocker ?? NO_CHECKS_BLOCKER };
  }
  if (outputBudgetBlocked.has(task.id)) {
    return { status: INITIAL_TASK_STATUS, blocker: OUTPUT_BUDGET_BLOCKER };
  }
  return { status: INITIAL_TASK_STATUS, blocker: null };
}

function buildPhase(args: {
  id: PhaseId;
  workflowId: WorkflowId;
  plan: PlanDocument["phases"][number];
  baseRevision: string;
  now: IsoTimestamp;
}): Phase {
  return {
    id: args.id,
    createdAt: args.now,
    updatedAt: args.now,
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "mutable",
    workflowId: args.workflowId,
    order: args.plan.order,
    goal: args.plan.goal,
    acceptanceCriteria: toCriteria(args.plan.acceptanceCriteria),
    budgetCap: { maxSpendUsd: null, maxTokens: null, maxRequests: null, maxConcurrency: null, maxElapsedMs: null },
    integrationPoint: {
      branch: args.plan.integrationBranch ?? defaultIntegrationBranch(args.plan.order),
      baseRevision: args.baseRevision,
    },
    gateStatus: "pending",
    report: null,
  };
}

function buildTask(args: {
  id: TaskId;
  workflowId: WorkflowId;
  phaseId: PhaseId;
  plan: PlanTask;
  dependencies: readonly TaskId[];
  now: IsoTimestamp;
  outputBudgetBlocked: ReadonlySet<string>;
}): Task {
  const { status, blocker } = initialStatusFor(args.plan, args.outputBudgetBlocked);
  return {
    id: args.id,
    createdAt: args.now,
    updatedAt: args.now,
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "mutable",
    workflowId: args.workflowId,
    phaseId: args.phaseId,
    revision: 1,
    goal: args.plan.goal,
    dependencies: args.dependencies,
    ownership: { paths: args.plan.ownership.paths, components: args.plan.ownership.components },
    acceptanceCriteria: toCriteria(args.plan.acceptanceCriteria),
    checks: toChecks(args.plan),
    riskClass: args.plan.riskClass,
    status,
    blocker,
  };
}

/**
 * Stable comparison of the fields that define "done" (docs/records.md §5.1).
 *
 * Uses the store's own canonical JSON: a record read back from SQLite has its
 * object keys sorted, so a plain `JSON.stringify` comparison against a freshly
 * built object would differ on key order alone, bump every task's revision on
 * every re-plan, and invalidate every approval on a no-op revision.
 */
export function definitionOfDoneChanged(before: Task, next: PlanTask): boolean {
  if (before.goal !== next.goal) return true;
  if (canonicalJson(before.acceptanceCriteria) !== canonicalJson(toCriteria(next.acceptanceCriteria))) return true;
  if (canonicalJson(before.checks) !== canonicalJson(toChecks(next))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist a plan as revision 1 of a workflow that has none yet.
 *
 * Rejects (without writing anything) if the workflow already has phases —
 * that is a revision, and `revisePlan` is the function for it.
 */
export function persistPlan(options: PersistPlanOptions): PersistPlanResult {
  const { store, workflowId } = options;
  return store.write(() => {
    const workflow = store.workflows.require(workflowId) as Workflow;
    const existing = store.phases.forWorkflow(workflowId);
    if (existing.length > 0) {
      throw new PlanPersistError(
        `workflow ${workflowId} already has ${existing.length} phase(s) at plan revision ` +
          `${workflow.planRevision}; use revisePlan to produce revision ${workflow.planRevision + 1}`,
      );
    }
    return writePlan({ ...options, workflow, previousTasks: [], previousPhases: [] });
  });
}

interface WriteArgs extends PersistPlanOptions {
  readonly workflow: Workflow;
  readonly previousTasks: readonly Task[];
  readonly previousPhases: readonly Phase[];
}

/**
 * The single write path used by both `persistPlan` and `revisePlan`. Runs
 * inside the caller's transaction; a throw anywhere rolls back every row.
 */
function writePlan(args: WriteArgs): PersistPlanResult {
  const { store, workflowId, plan, workflow } = args;
  const now = args.now();
  const baseRevision = args.baseRevision ?? workflow.baseRevision;
  const isRevision = args.previousPhases.length > 0 || args.previousTasks.length > 0;
  const planRevision = isRevision ? workflow.planRevision + 1 : Math.max(workflow.planRevision, 1);

  // Phases: match by goal+order so a stable phase keeps its record id.
  const phaseIds = new Map<string, PhaseId>();
  const phases: Phase[] = [];
  const reusedPhaseIds = new Set<string>();
  for (const planPhase of plan.phases) {
    const previous = args.previousPhases.find((p) => p.order === planPhase.order && p.goal === planPhase.goal);
    if (previous !== undefined) {
      reusedPhaseIds.add(previous.id);
      phaseIds.set(planPhase.id, previous.id);
      const updated = store.phases.update(previous.id, {
        goal: planPhase.goal,
        acceptanceCriteria: toCriteria(planPhase.acceptanceCriteria),
        integrationPoint: {
          branch: planPhase.integrationBranch ?? previous.integrationPoint.branch,
          baseRevision,
        },
      });
      phases.push(updated);
      continue;
    }
    const id = args.newId("phase") as PhaseId;
    phaseIds.set(planPhase.id, id);
    phases.push(store.phases.insert(buildPhase({ id, workflowId, plan: planPhase, baseRevision, now })));
  }

  const result = writeTasks({ ...args, now, planRevision, phaseIds, phases, reusedPhaseIds });
  store.workflows.update(workflowId, {
    planRevision,
    status: workflow.status === "planning" ? "ready" : workflow.status,
  });
  return result;
}

interface WriteTasksArgs extends Omit<WriteArgs, "now"> {
  readonly now: IsoTimestamp;
  readonly planRevision: number;
  readonly phaseIds: ReadonlyMap<string, PhaseId>;
  readonly phases: readonly Phase[];
  readonly reusedPhaseIds: ReadonlySet<string>;
}

/**
 * Write tasks, reusing the record id of a task that already exists under the
 * same planner-local id (`externalId` is carried in the previous plan's
 * mapping, supplied by the caller through `previousTasks`' goals — see
 * `matchPreviousTask`). Dependencies are resolved after all ids exist, so a
 * forward reference within the document resolves correctly.
 */
function writeTasks(args: WriteTasksArgs): PersistPlanResult {
  const { store, workflowId, plan, now, planRevision, phaseIds } = args;

  // Pass 1: decide the record id for every planner task, so dependencies can
  // be resolved before anything is written.
  const taskIds = new Map<string, TaskId>();
  const matched = new Map<string, Task>();
  const takenPrevious = new Set<string>();
  for (const planTask of plan.tasks) {
    const previous = matchPreviousTask(planTask, args.previousTasks, takenPrevious);
    if (previous !== undefined) {
      takenPrevious.add(previous.id);
      matched.set(planTask.id, previous);
      taskIds.set(planTask.id, previous.id as TaskId);
      continue;
    }
    taskIds.set(planTask.id, args.newId("task") as TaskId);
  }

  const outputBudgetBlocked = new Set(args.outputBudgetBlocked ?? []);
  const tasks: Task[] = [];
  const blockedForNoChecks: TaskId[] = [];
  const blockedForOutputBudget: TaskId[] = [];
  const blockedForWeakChecks: TaskId[] = [];
  const revisedTasks: TaskId[] = [];

  for (const planTask of plan.tasks) {
    const id = taskIds.get(planTask.id) as TaskId;
    const phaseId = phaseIds.get(planTask.phaseId);
    if (phaseId === undefined) {
      throw new PlanPersistError(`task "${planTask.id}" references unknown phase "${planTask.phaseId}"`);
    }
    const dependencies = planTask.dependencies.map((dep) => {
      const depId = taskIds.get(dep);
      if (depId === undefined) throw new PlanPersistError(`task "${planTask.id}" depends on unknown task "${dep}"`);
      return depId;
    });

    const previous = matched.get(planTask.id);
    if (previous === undefined) {
      const record = store.tasks.insert(
        buildTask({ id, workflowId, phaseId, plan: planTask, dependencies, now, outputBudgetBlocked }),
      );
      tasks.push(record);
      if (record.blocker === NO_CHECKS_BLOCKER) blockedForNoChecks.push(record.id);
      if (record.blocker === OUTPUT_BUDGET_BLOCKER) blockedForOutputBudget.push(record.id);
      if (record.blocker === WEAK_CHECK_BLOCKER) blockedForWeakChecks.push(record.id);
      continue;
    }

    const { status, blocker } = initialStatusFor(planTask, outputBudgetBlocked);
    const changed = definitionOfDoneChanged(previous, planTask);
    const patch: Partial<Task> = {
      phaseId,
      dependencies,
      ownership: { paths: planTask.ownership.paths, components: planTask.ownership.components },
      riskClass: planTask.riskClass,
      ...(changed
        ? {
            goal: planTask.goal,
            acceptanceCriteria: toCriteria(planTask.acceptanceCriteria),
            checks: toChecks(planTask),
            revision: previous.revision + 1,
            status,
            blocker,
          }
        : { blocker }),
    };
    const record = store.tasks.update(previous.id, patch);
    tasks.push(record);
    if (changed) revisedTasks.push(record.id);
    if (record.blocker === NO_CHECKS_BLOCKER) blockedForNoChecks.push(record.id);
    if (record.blocker === OUTPUT_BUDGET_BLOCKER) blockedForOutputBudget.push(record.id);
    if (record.blocker === WEAK_CHECK_BLOCKER) blockedForWeakChecks.push(record.id);
  }

  // Dependency-graph validation on the *persisted* records (#40; PLAN §3.C).
  // `plan-schema.ts` already validated the planner-local graph before this
  // point; this re-checks the graph as written — record ids, resolved
  // phases — so an invalid graph can never reach the store regardless of
  // caller. A throw here rolls back the whole transaction: nothing partial
  // lands.
  const graph = validateGraph(tasks, args.phases);
  if (!graph.ok) {
    throw new PlanPersistError(
      `plan rejected: invalid task dependency graph:\n` + graph.issues.map((i) => `  ! ${i.message} [${i.rule}]`).join("\n"),
    );
  }

  const supersededTasks = supersedeDroppedTasks(store, args.previousTasks, takenPrevious, now);
  const invalidatedApprovals = invalidateApprovals({
    store,
    workflowId,
    now,
    planRevision,
    revisedTasks,
    supersededTasks,
    isRevision: args.previousTasks.length > 0 || args.previousPhases.length > 0,
  });

  return {
    workflowId,
    planRevision,
    phases: args.phases,
    tasks,
    blockedForNoChecks,
    blockedForOutputBudget,
    blockedForWeakChecks,
    supersededTasks,
    revisedTasks,
    invalidatedApprovals,
    idMapping: { phases: phaseIds, tasks: taskIds },
  };
}

/**
 * Identity across revisions (docs/records.md §5.1: "Replanning that changes
 * what a task *is* keeps the id… a genuinely new piece of work gets a new
 * id"). Matching is by exact goal first, then by an unambiguous ownership
 * overlap: those are the two signals available without the planner being
 * asked to remember record ids it never saw.
 */
function matchPreviousTask(
  planTask: PlanTask,
  previous: readonly Task[],
  taken: ReadonlySet<string>,
): Task | undefined {
  const available = previous.filter((t) => !taken.has(t.id));
  const byGoal = available.find((t) => t.goal === planTask.goal);
  if (byGoal !== undefined) return byGoal;
  if (planTask.ownership.paths.length === 0) return undefined;
  const wanted = new Set(planTask.ownership.paths);
  const overlapping = available.filter((t) => t.ownership.paths.some((p) => wanted.has(p)));
  // Only an unambiguous match counts: two candidates means we cannot tell
  // which task this is, and inventing continuity would silently carry an
  // approval across a scope change.
  return overlapping.length === 1 ? overlapping[0] : undefined;
}

/**
 * Tasks the new revision dropped. They are `cancelled` with blocker
 * `superseded` rather than deleted: their attempts, evidence and audit trail
 * remain readable, which is what `/korwf why` and replay need.
 */
function supersedeDroppedTasks(
  store: Store,
  previous: readonly Task[],
  taken: ReadonlySet<string>,
  _now: IsoTimestamp,
): readonly TaskId[] {
  const superseded: TaskId[] = [];
  for (const task of previous) {
    if (taken.has(task.id)) continue;
    if (task.status === "cancelled" || task.status === "done") continue;
    const updated = store.tasks.update(task.id, { status: "cancelled", blocker: SUPERSEDED_BLOCKER });
    superseded.push(updated.id);
  }
  return superseded;
}

/**
 * Write the invalidations a plan revision forces (docs/records.md §6, Stage 1
 * rules in `src/workflow/transitions.ts`), inside the same transaction as the
 * change that caused them.
 *
 * - A task whose revision was bumped invalidates its own approvals with
 *   `task_revision_changed`, and so do the approvals of a task this revision
 *   dropped.
 * - Every other still-valid approval in the workflow is pinned to the old
 *   `planRevision` and is invalidated with `plan_revision_changed`.
 *
 * A first-time plan (`isRevision === false`) invalidates nothing: there was
 * no approved plan to invalidate.
 */
function invalidateApprovals(args: {
  store: Store;
  workflowId: WorkflowId;
  now: IsoTimestamp;
  planRevision: number;
  revisedTasks: readonly TaskId[];
  supersededTasks: readonly TaskId[];
  isRevision: boolean;
}): readonly { approvalId: string; reason: ApprovalInvalidation["reason"] }[] {
  if (!args.isRevision) return [];
  const changed = new Set<string>([...args.revisedTasks, ...args.supersededTasks]);
  const out: { approvalId: string; reason: ApprovalInvalidation["reason"] }[] = [];
  for (const approval of args.store.approvals.findBy("workflowId", args.workflowId)) {
    if (approval.invalidation !== null) continue;
    const touchesChangedTask = approval.scope.kind === "task" && changed.has(approval.scope.taskId);
    const reason: ApprovalInvalidation["reason"] = touchesChangedTask
      ? "task_revision_changed"
      : "plan_revision_changed";
    args.store.approvals.invalidate(approval.id, {
      reason,
      at: args.now,
      detail: `plan revision ${args.planRevision}`,
    });
    out.push({ approvalId: approval.id, reason });
  }
  return out;
}

/**
 * Persist a new revision of an existing plan (issue #37 Scope: "re-running
 * produces revision N+1 and marks superseded tasks").
 *
 * Everything happens in one transaction: phases, tasks, the workflow's
 * `planRevision` bump, supersessions and approval invalidations either all
 * land or none do.
 */
export function revisePlan(options: PersistPlanOptions): PersistPlanResult {
  const { store, workflowId } = options;
  return store.write(() => {
    const workflow = store.workflows.require(workflowId) as Workflow;
    const previousPhases = store.phases.forWorkflow(workflowId);
    const previousTasks = store.tasks.findBy("workflowId", workflowId);
    if (previousPhases.length === 0 && previousTasks.length === 0) {
      throw new PlanPersistError(
        `workflow ${workflowId} has no plan to revise; use persistPlan for the first revision`,
      );
    }
    return writePlan({ ...options, workflow, previousPhases, previousTasks });
  });
}

/** Persist a first plan, or revise an existing one, whichever applies. */
export function persistOrRevisePlan(options: PersistPlanOptions): PersistPlanResult {
  const { store, workflowId } = options;
  return store.write(() => {
    const hasPlan =
      store.phases.forWorkflow(workflowId).length > 0 || store.tasks.findBy("workflowId", workflowId).length > 0;
    return hasPlan ? revisePlan(options) : persistPlan(options);
  });
}

// ---------------------------------------------------------------------------
// Reading a stored plan back
// ---------------------------------------------------------------------------

/** A stored plan as `/korwf plan --show` and the boards read it. */
export interface StoredPlan {
  readonly workflow: Workflow;
  readonly phases: readonly { readonly phase: Phase; readonly tasks: readonly Task[] }[];
}

/** Read the current plan revision back out of the store, in phase order. */
export function readStoredPlan(store: Store, workflowId: WorkflowId): StoredPlan {
  const workflow = store.workflows.require(workflowId) as Workflow;
  const phases = store.phases.forWorkflow(workflowId).map((phase) => ({
    phase,
    tasks: store.tasks.forPhase(phase.id),
  }));
  return { workflow, phases };
}

/** Human-readable summary of a persisted plan, for `/korwf` output and tests. */
export function summarisePersistedPlan(result: PersistPlanResult): string {
  const lines = [
    `Plan revision ${result.planRevision}: ${result.phases.length} phase(s), ${result.tasks.length} task(s).`,
  ];
  if (result.blockedForNoChecks.length > 0) {
    lines.push(
      `  ${result.blockedForNoChecks.length} task(s) have no verification checks and stay "proposed" with ` +
        `blocker "${NO_CHECKS_BLOCKER}" until checks are added (PLAN \u00a72.3): ${result.blockedForNoChecks.join(", ")}`,
    );
  }
  if (result.blockedForWeakChecks.length > 0) {
    lines.push(
      `  ${result.blockedForWeakChecks.length} task(s) register only checks that cannot fail and stay "proposed" ` +
        `with blocker "${WEAK_CHECK_BLOCKER}" until a real check is added (PLAN §2.3, §7): ` +
        `${result.blockedForWeakChecks.join(", ")}`,
    );
  }
  if (result.blockedForOutputBudget.length > 0) {
    lines.push(
      `  ${result.blockedForOutputBudget.length} task(s) expect more output than one worker turn can emit and ` +
        `stay "proposed" with blocker "${OUTPUT_BUDGET_BLOCKER}" until they are split (#124): ` +
        `${result.blockedForOutputBudget.join(", ")}`,
    );
  }
  if (result.revisedTasks.length > 0) {
    lines.push(`  ${result.revisedTasks.length} task(s) changed definition and had their revision bumped.`);
  }
  if (result.supersededTasks.length > 0) {
    lines.push(`  ${result.supersededTasks.length} task(s) were superseded and cancelled: ${result.supersededTasks.join(", ")}`);
  }
  if (result.invalidatedApprovals.length > 0) {
    lines.push(`  ${result.invalidatedApprovals.length} approval(s) invalidated by this revision.`);
  }
  return lines.join("\n");
}
