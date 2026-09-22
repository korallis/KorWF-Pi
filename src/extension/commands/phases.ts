/**
 * `/korwf phases` (issue #43; PLAN §3.C, §4 UI).
 *
 * Renders the phase board: gate status, budget cap, integration point, task
 * counts by status, and blockers. Read-only, same guarantee as `tasks.ts`.
 */
import type { Store } from "../../storage/db.ts";
import type { WorkflowId } from "../../storage/records.ts";
import { buildPhaseBoard, type PhaseBoardFilter, type PhaseBoardRow } from "../../workflow/boards.ts";
import { renderBoardTable, type BoardTable } from "../ui/board.ts";
import { resolveBoardWorkflow, type WorkflowReadStore } from "./workflow-select.ts";

export type PhasesCommandStore = WorkflowReadStore & Pick<Store, "phases" | "tasks" | "blockers">;

export interface PhasesCommandArgs {
  readonly status?: string;
  readonly workflowId?: string;
}

/** Parse `/korwf phases [--status <gateStatus>] [--workflow <id>]`. */
export function parsePhasesArgs(argv: readonly string[]): PhasesCommandArgs {
  const out: { status?: string; workflowId?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--status") {
      const value = argv[i + 1];
      if (value !== undefined) out.status = value;
      i += 1;
    } else if (arg === "--workflow") {
      const value = argv[i + 1];
      if (value !== undefined) out.workflowId = value;
      i += 1;
    }
  }
  return out;
}

function budgetSummary(row: PhaseBoardRow): string {
  const b = row.phase.budgetCap;
  const parts: string[] = [];
  if (b.maxSpendUsd !== null) parts.push(`$${b.maxSpendUsd}`);
  if (b.maxTokens !== null) parts.push(`${b.maxTokens}tok`);
  if (b.maxRequests !== null) parts.push(`${b.maxRequests}req`);
  if (b.maxConcurrency !== null) parts.push(`c${b.maxConcurrency}`);
  if (b.maxElapsedMs !== null) parts.push(`${Math.round(b.maxElapsedMs / 1000)}s`);
  return parts.length === 0 ? "none" : parts.join(" ");
}

function taskCountSummary(row: PhaseBoardRow): string {
  if (row.taskTotal === 0) return "0";
  const parts = Object.entries(row.taskCounts)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${status}:${n}`);
  return `${row.taskTotal} (${parts.join(", ")})`;
}

function blockerSummary(row: PhaseBoardRow): string {
  if (row.blockers.length === 0) return "-";
  return row.blockers.map((b) => `${b.kind}: ${b.detail}`).join("; ");
}

/** Build the `BoardTable` for `/korwf phases`. Pure. */
export function phaseBoardTable(rows: readonly PhaseBoardRow[]): BoardTable {
  return {
    title: "Phases",
    columns: [
      { header: "id" },
      { header: "order", align: "right" },
      { header: "gate" },
      { header: "integration" },
      { header: "budget" },
      { header: "tasks" },
      { header: "blockers" },
      { header: "goal" },
    ],
    rows: rows.map((row) => [
      row.phase.id,
      String(row.phase.order),
      row.phase.gateStatus,
      `${row.phase.integrationPoint.branch}@${row.phase.integrationPoint.baseRevision.slice(0, 8)}`,
      budgetSummary(row),
      taskCountSummary(row),
      blockerSummary(row),
      row.phase.goal,
    ]),
  };
}

/** Render `/korwf phases`. */
export function phasesMessage(
  store: PhasesCommandStore,
  args: PhasesCommandArgs,
): { readonly ok: boolean; readonly message: string } {
  const resolved = resolveBoardWorkflow(store, args.workflowId);
  if (!resolved.ok) return resolved;

  const filter: Record<string, unknown> = {};
  if (args.status !== undefined) filter.status = args.status;
  const rows = buildPhaseBoard(store, resolved.workflowId as WorkflowId, filter as PhaseBoardFilter);
  return { ok: true, message: renderBoardTable(phaseBoardTable(rows)) };
}
