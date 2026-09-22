/**
 * `/korwf tasks` (issue #43; PLAN §3.C, §4 UI).
 *
 * Renders the task board: status, dependencies, blockers (with why),
 * evidence count, and model used. Read-only — see `src/workflow/boards.ts`
 * for the "boards never mutate state" guarantee.
 */
import type { Store } from "../../storage/db.ts";
import type { WorkflowId } from "../../storage/records.ts";
import { buildTaskBoard, type TaskBoardFilter, type TaskBoardRow } from "../../workflow/boards.ts";
import { checkStateMarker, renderBoardTable, type BoardTable } from "../ui/board.ts";
import { resolveBoardWorkflow, type WorkflowReadStore } from "./workflow-select.ts";

export type TasksCommandStore = WorkflowReadStore & Pick<Store, "tasks" | "phases" | "evidence" | "attempts" | "blockers">;

export interface TasksCommandArgs {
  readonly phase?: string;
  readonly status?: string;
  readonly blocked?: boolean;
  readonly workflowId?: string;
  /** Current worktree revision (issue #51), from `src/git/`; `null` if unknown. */
  readonly currentSha?: string | null;
}

/** Parse `/korwf tasks [--phase <id>] [--status <status>] [--blocked] [--workflow <id>]`. */
export function parseTasksArgs(argv: readonly string[]): TasksCommandArgs {
  const out: { phase?: string; status?: string; blocked?: boolean; workflowId?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--phase") {
      const value = argv[i + 1];
      if (value !== undefined) out.phase = value;
      i += 1;
    } else if (arg === "--status") {
      const value = argv[i + 1];
      if (value !== undefined) out.status = value;
      i += 1;
    } else if (arg === "--blocked") {
      out.blocked = true;
    } else if (arg === "--workflow") {
      const value = argv[i + 1];
      if (value !== undefined) out.workflowId = value;
      i += 1;
    }
  }
  return out;
}

function blockerSummary(row: TaskBoardRow): string {
  if (row.blockers.length === 0) return "-";
  return row.blockers.map((b) => `${b.kind}: ${b.detail}`).join("; ");
}

function dependencySummary(row: TaskBoardRow): string {
  if (row.dependencies.length === 0) return "-";
  const unmet = new Set(row.unmetDependencies);
  return row.dependencies.map((d) => (unmet.has(d) ? `${d}*` : d)).join(", ");
}

/**
 * One entry per check plus one per uncovered criterion, so `flaky`,
 * `missing`, `unavailable` and an uncovered criterion are all visibly
 * distinct on the board (issue #51; PLAN §3.F).
 */
function checksSummary(row: TaskBoardRow): string {
  const parts: string[] = row.checkSummary.checks.map(
    (c) => `${c.checkId}:${checkStateMarker(c.status)}`,
  );
  for (const criterionId of row.checkSummary.uncoveredCriteria) {
    parts.push(`${criterionId}:UNCOVERED`);
  }
  return parts.length === 0 ? "-" : parts.join(", ");
}

/** Build the `BoardTable` for `/korwf tasks`. Pure, so it is tested without a store. */
export function taskBoardTable(rows: readonly TaskBoardRow[]): BoardTable {
  return {
    title: "Tasks (dependency* = not yet done)",
    columns: [
      { header: "id" },
      { header: "status" },
      { header: "phase" },
      { header: "dependencies" },
      { header: "blockers" },
      { header: "checks" },
      { header: "evidence", align: "right" },
      { header: "model" },
      { header: "goal" },
    ],
    rows: rows.map((row) => [
      row.task.id,
      row.task.status,
      row.task.phaseId,
      dependencySummary(row),
      blockerSummary(row),
      checksSummary(row),
      String(row.evidenceCount),
      row.lastModel ?? "-",
      row.task.goal,
    ]),
  };
}

/** Render `/korwf tasks`. Returns an error message and `ok: false` if there is nothing to show. */
export function tasksMessage(
  store: TasksCommandStore,
  args: TasksCommandArgs,
): { readonly ok: boolean; readonly message: string } {
  const resolved = resolveBoardWorkflow(store, args.workflowId);
  if (!resolved.ok) return resolved;

  const filter: Record<string, unknown> = {};
  if (args.phase !== undefined) filter.phaseId = args.phase;
  if (args.status !== undefined) filter.status = args.status;
  if (args.blocked !== undefined) filter.blockedOnly = args.blocked;
  const rows = buildTaskBoard(
    store,
    resolved.workflowId as WorkflowId,
    filter as TaskBoardFilter,
    args.currentSha ?? null,
  );
  return { ok: true, message: renderBoardTable(taskBoardTable(rows)) };
}
