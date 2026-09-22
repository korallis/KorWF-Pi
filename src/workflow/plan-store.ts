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
import {
  NO_CHECKS_BLOCKER,
  SUPERSEDED_BLOCKER,
  taskReadiness,
  type PlanDocument,
  type PlanTask,
} from "./plan-schema.ts";

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
export function initialStatusFor(task: PlanTask): { status: TaskStatus; blocker: string | null } {
  const readiness = taskReadiness(task);
  return readiness.canBecomeReady
    ? { status: INITIAL_TASK_STATUS, blocker: null }
    : { status: INITIAL_TASK_STATUS, blocker: readiness.blocker ?? NO_CHECKS_BLOCKER };
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
}): Task {
  const { status, blocker } = initialStatusFor(args.plan);
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

/** Stable comparison of the fields that define "done" (docs/records.md §5.1). */
export function definitionOfDoneChanged(before: Task, next: PlanTask): boolean {
  if (before.goal !== next.goal) return true;
  if (JSON.stringify(before.acceptanceCriteria) !== JSON.stringify(toCriteria(next.acceptanceCriteria))) return true;
  if (JSON.stringify(before.checks) !== JSON.stringify(toChecks(next))) return true;
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
  const { store, workflowId, plan } = options;
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

interface WriteTasksArgs extends WriteArgs {
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

  const tasks: Task[] = [];
  const blockedForNoChecks: TaskId[] = [];
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
      const record = store.tasks.insert(buildTask({ id, workflowId, phaseId, plan: planTask, dependencies, now }));
      tasks.push(record);
      if (record.blocker === NO_CHECKS_BLOCKER) blockedForNoChecks.push(record.id);
      continue;
    }

    const { status, blocker } = initialStatusFor(planTask);
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
    supersededTasks,
    revisedTasks,
    invalidatedApprovals,
    idMapping: { phases: phaseIds, tasks: taskIds },
  };
}
