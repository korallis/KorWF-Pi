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
