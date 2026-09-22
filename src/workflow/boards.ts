/**
 * Read-only board data for `/korwf tasks` and `/korwf phases` (issue #43;
 * PLAN §3.C, §4 UI).
 *
 * This module only reads: `Store.tasks`/`phases`/`evidence`/`attempts`/
 * `blockers`.list()/forSubject(), never `write()`, `transitionTask`, or
 * `transitionPhase`. That is what "the boards are a VIEW" means in code, not
 * just in the issue text — nothing here can change a status.
 */
import type { Store } from "../storage/db.ts";
import type { Phase, PhaseId, Task, TaskId, WorkflowId } from "../storage/records.ts";
import type { BlockerRow } from "../storage/transition-log.ts";

/** One row of the `/korwf tasks` board. */
export interface TaskBoardRow {
  readonly task: Task;
  /** Unresolved blockers only — resolved history is available via `/korwf why`. */
  readonly blockers: readonly BlockerRow[];
  readonly dependencies: readonly TaskId[];
  /** Dependency ids not yet `done`, i.e. what is actually holding this task up. */
  readonly unmetDependencies: readonly TaskId[];
  readonly evidenceCount: number;
  /** Most recent attempt's `usedModel`, or `null` if the task never ran. */
  readonly lastModel: string | null;
}

export interface TaskBoardFilter {
  readonly phaseId?: PhaseId;
  readonly status?: Task["status"];
  /** Only tasks with at least one unresolved blocker. */
  readonly blockedOnly?: boolean;
}

/** One row of the `/korwf phases` board. */
export interface PhaseBoardRow {
  readonly phase: Phase;
  readonly blockers: readonly BlockerRow[];
  readonly taskCounts: Readonly<Record<Task["status"], number>>;
  readonly taskTotal: number;
}

export interface PhaseBoardFilter {
  readonly status?: Phase["gateStatus"];
}

const ZERO_TASK_COUNTS: Record<Task["status"], number> = {
  proposed: 0,
  ready: 0,
  running: 0,
  verifying: 0,
  review: 0,
  done: 0,
  blocked: 0,
  failed: 0,
  cancelled: 0,
  needs_changes: 0,
  paused_cap: 0,
};

/** The store surfaces board building needs — read-only by type. */
export type BoardReadStore = Pick<Store, "tasks" | "phases" | "evidence" | "attempts" | "blockers">;

function taskDoneStatuses(): ReadonlySet<Task["status"]> {
  return new Set(["done"]);
}

function unmetDependencyIds(store: BoardReadStore, dependencies: readonly TaskId[]): readonly TaskId[] {
  const done = taskDoneStatuses();
  return dependencies.filter((depId) => {
    const dep = store.tasks.get(depId);
    return dep === undefined || !done.has(dep.status);
  });
}

function lastAttemptModel(store: BoardReadStore, taskId: TaskId): string | null {
  const attempts = store.attempts.forTask(taskId);
  if (attempts.length === 0) return null;
  const last = [...attempts].sort((a, b) => a.timestamps.startedAt.localeCompare(b.timestamps.startedAt)).at(-1);
  return last?.usedModel ?? null;
}

function evidenceCountForTask(store: BoardReadStore, taskId: TaskId): number {
  return store.evidence.list().filter((e) => e.taskId === taskId).length;
}

/** Build the rows for `/korwf tasks`, optionally filtered. */
export function buildTaskBoard(
  store: BoardReadStore,
  workflowId: WorkflowId,
  filter: TaskBoardFilter = {},
): readonly TaskBoardRow[] {
  const phases = store.phases.forWorkflow(workflowId);
  const phaseIds = new Set(phases.map((p) => p.id));
  const allTasks = store.tasks.list().filter((t) => phaseIds.has(t.phaseId));

  const rows: TaskBoardRow[] = [];
  for (const task of allTasks) {
    if (filter.phaseId !== undefined && task.phaseId !== filter.phaseId) continue;
    if (filter.status !== undefined && task.status !== filter.status) continue;
    const blockers = store.blockers.unresolvedForSubject("task", task.id);
    if (filter.blockedOnly === true && blockers.length === 0) continue;
    rows.push({
      task,
      blockers,
      dependencies: task.dependencies,
      unmetDependencies: unmetDependencyIds(store, task.dependencies),
      evidenceCount: evidenceCountForTask(store, task.id),
      lastModel: lastAttemptModel(store, task.id),
    });
  }
  return rows;
}

/** Build the rows for `/korwf phases`, optionally filtered by gate status. */
export function buildPhaseBoard(
  store: BoardReadStore,
  workflowId: WorkflowId,
  filter: PhaseBoardFilter = {},
): readonly PhaseBoardRow[] {
  const phases = store.phases.forWorkflow(workflowId);
  const rows: PhaseBoardRow[] = [];
  for (const phase of phases) {
    if (filter.status !== undefined && phase.gateStatus !== filter.status) continue;
    const tasks = store.tasks.forPhase(phase.id);
    const counts: Record<Task["status"], number> = { ...ZERO_TASK_COUNTS };
    for (const t of tasks) counts[t.status] += 1;
    rows.push({
      phase,
      blockers: store.blockers.unresolvedForSubject("phase", phase.id),
      taskCounts: counts,
      taskTotal: tasks.length,
    });
  }
  return rows;
}
