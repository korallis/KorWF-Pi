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
import { taskCheckSummary, type TaskCheckSummary } from "../verification/flaky.ts";

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
  /**
   * Requested/used model and fallback reason of the most recent attempt
   * (issue #66; PLAN §3.D "Every switch is recorded on the Attempt ... and
   * surfaced in status"). `null` when the task never ran. Read straight off
   * the Attempt row — never recomputed or inferred — so a switch this board
   * reports is exactly what the store recorded.
   */
  readonly lastModelSwitch: TaskModelSwitch | null;
  /**
   * Per-check state (pass/fail/flaky/missing/unavailable/timeout) plus
   * uncovered acceptance criteria (issue #51; PLAN §3.F). `null` when no
   * current revision was supplied to `buildTaskBoard` — every check then
   * reports `missing`, which is the honest answer for "we don't know".
   */
  readonly checkSummary: TaskCheckSummary;
}

/** Requested/used model and fallback reason of one Attempt, exactly as recorded (#66). */
export interface TaskModelSwitch {
  readonly requestedModel: string;
  readonly usedModel: string;
  /** `null` means the store recorded no fallback — `usedModel === requestedModel`. */
  readonly fallbackReason: string | null;
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
  /**
   * Earliest `ModelAvailability.estimatedReset` among the phase's unresolved
   * `all_candidates_capped` blockers' watched routes, parsed back out of the
   * `task-cap`/`phase-cap` evidence refs (#63; PLAN §3.D "status shows
   * earliest estimated reset"). `null` when the phase is not cap-paused, or
   * when every capped route's reset is unknown.
   */
  readonly earliestCapReset: string | null;
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

/** The store surfaces `buildTaskBoard` needs — read-only by type. */
export type TaskBoardReadStore = Pick<Store, "tasks" | "phases" | "evidence" | "attempts" | "blockers">;

/** The store surfaces `buildPhaseBoard` needs — read-only by type. */
export type PhaseBoardReadStore = Pick<Store, "tasks" | "phases" | "blockers" | "transitionLog">;

/** @deprecated use `TaskBoardReadStore` or `PhaseBoardReadStore`. Kept for callers needing both. */
export type BoardReadStore = TaskBoardReadStore & PhaseBoardReadStore;

function taskDoneStatuses(): ReadonlySet<Task["status"]> {
  return new Set(["done"]);
}

function unmetDependencyIds(store: TaskBoardReadStore, dependencies: readonly TaskId[]): readonly TaskId[] {
  const done = taskDoneStatuses();
  return dependencies.filter((depId) => {
    const dep = store.tasks.get(depId);
    return dep === undefined || !done.has(dep.status);
  });
}

function lastAttempt(store: TaskBoardReadStore, taskId: TaskId) {
  const attempts = store.attempts.forTask(taskId);
  if (attempts.length === 0) return undefined;
  return [...attempts].sort((a, b) => a.timestamps.startedAt.localeCompare(b.timestamps.startedAt)).at(-1);
}

function lastAttemptModel(store: TaskBoardReadStore, taskId: TaskId): string | null {
  return lastAttempt(store, taskId)?.usedModel ?? null;
}

/**
 * Requested/used/reason off the most recent attempt (#66), read verbatim
 * from the Attempt row `recordFallbackSwitch` (`src/models/cap-pause.ts`)
 * and `selectModel` (`src/models/select.ts`) wrote — never recomputed.
 */
function lastModelSwitchFor(store: TaskBoardReadStore, taskId: TaskId): TaskModelSwitch | null {
  const last = lastAttempt(store, taskId);
  if (last === undefined) return null;
  return {
    requestedModel: last.requestedModel,
    usedModel: last.usedModel,
    fallbackReason: last.fallbackReason,
  };
}

function evidenceCountForTask(store: TaskBoardReadStore, taskId: TaskId): number {
  return store.evidence.list().filter((e) => e.taskId === taskId).length;
}

/**
 * Build the rows for `/korwf tasks`, optionally filtered.
 *
 * `currentSha` comes from the caller (`src/git/`, never from this module,
 * which stays read-only over the store): `null` when no live revision is
 * known, in which case every check reports `missing` rather than the board
 * guessing a revision.
 */
export function buildTaskBoard(
  store: TaskBoardReadStore,
  workflowId: WorkflowId,
  filter: TaskBoardFilter = {},
  currentSha: string | null = null,
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
    const taskEvidence = store.evidence.forTaskRevision(task.id, task.revision);
    rows.push({
      task,
      blockers,
      dependencies: task.dependencies,
      unmetDependencies: unmetDependencyIds(store, task.dependencies),
      evidenceCount: evidenceCountForTask(store, task.id),
      lastModel: lastAttemptModel(store, task.id),
      lastModelSwitch: lastModelSwitchFor(store, task.id),
      checkSummary: taskCheckSummary(task, taskEvidence, currentSha),
    });
  }
  return rows;
}

/**
 * Earliest estimated cap reset for a phase (#63; PLAN §3.D "status shows
 * earliest estimated reset"), read from the evidence refs `applyCapPause`
 * (`src/models/cap-pause.ts`) recorded on the most recent accepted
 * `phase-cap`/`all_candidates_capped` transition — this module stays
 * read-only (module doc), so it parses what was already written rather than
 * asking `src/models/availability.ts` again. `null` when the phase has no
 * such pause, or the pause's reset was `unknown`.
 */
function earliestCapResetFor(store: PhaseBoardReadStore, phaseId: string): string | null {
  const events = store.transitionLog
    .forSubject("phase", phaseId)
    .filter((e) => e.disposition === "accepted" && e.trigger === "all_candidates_capped");
  if (events.length === 0) return null;
  const latest = events[events.length - 1]!;
  for (const ref of latest.evidenceRefs) {
    const match = /^availability:earliest_reset=(.+)$/.exec(ref);
    if (match !== null) return match[1] === "unknown" ? null : match[1]!;
  }
  return null;
}

/** Build the rows for `/korwf phases`, optionally filtered by gate status. */
export function buildPhaseBoard(
  store: PhaseBoardReadStore,
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
      earliestCapReset: phase.gateStatus === "paused_cap" ? earliestCapResetFor(store, phase.id) : null,
    });
  }
  return rows;
}
