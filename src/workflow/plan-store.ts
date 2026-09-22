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
