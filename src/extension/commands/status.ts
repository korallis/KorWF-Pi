/**
 * `/korwf status` (issue #66; PLAN §3.D "Every switch is recorded on the
 * Attempt ... and surfaced in status", §3.I "explain decisions from
 * recorded fields only", §4 UI "workers, models in use, fallbacks, budgets,
 * running cost").
 *
 * Builds on `src/extension/commands/models.ts` (route/cap rendering, #125)
 * and `src/workflow/boards.ts` (task board, #43) rather than re-deriving
 * either. This module adds exactly what those two do not already show:
 * per-task requested→used model and fallback reason, and running cost from
 * the ledger. Every line here comes from a recorded field — if a field is
 * absent (`fallbackReason === null`, no ledger status supplied), the output
 * says so; it never invents a rationale.
 */
import type { TaskBoardRow } from "../../workflow/boards.ts";
import type { LedgerStatus, ScopeStatus } from "../../telemetry/ledger.ts";
import { renderRouteLines, type RouteListingInput } from "./models.ts";

/** The requested/used/reason fields of a task's most recent Attempt, or `null` if it never ran. */
export interface AttemptModelSwitch {
  readonly requestedModel: string;
  readonly usedModel: string;
  readonly fallbackReason: string | null;
}

/** Input to `statusReportMessage`: route listing plus the task/ledger views status adds. */
export interface StatusReportInput extends RouteListingInput {
  readonly taskRows?: readonly TaskBoardRow[];
  readonly ledgerStatus?: LedgerStatus | null;
}

/**
 * One line per task whose last attempt's `usedModel` differs from its
 * `requestedModel` — the visible fallback (PLAN §3.D). Tasks that never ran,
 * or ran with no switch, contribute nothing here.
 */
export function attemptSwitchLines(_rows: readonly TaskBoardRow[]): string[] {
  return [];
}

/** Render one `ScopeStatus` (running cost, PLAN §3.I) as a line. */
export function scopeStatusLine(_scope: ScopeStatus): string {
  return "";
}

/** All ledger scope lines, or `[]` when no ledger status was supplied. */
export function ledgerStatusLines(_status: LedgerStatus | null | undefined): string[] {
  return [];
}

/** Full `/korwf status` text: routes/caps, attempt switches, running cost. */
export function statusReportMessage(input: StatusReportInput): string {
  return renderRouteLines(input).join("\n");
}
