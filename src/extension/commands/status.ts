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

/** Input to `statusReportMessage`: route listing plus the task/ledger views status adds. */
export interface StatusReportInput extends RouteListingInput {
  /** Task board rows (`buildTaskBoard`, #43); omit to show routes/caps only. */
  readonly taskRows?: readonly TaskBoardRow[];
  /** Running cost per scope (`Ledger.status`, #30); `null`/omitted when no ledger was opened. */
  readonly ledgerStatus?: LedgerStatus | null;
}

/**
 * One line per task whose last attempt's `usedModel` differs from its
 * `requestedModel` — the visible fallback (PLAN §3.D). Tasks that never ran,
 * or ran with no switch (`fallbackReason === null`), contribute nothing
 * here: reporting "no switch" for every task would bury the ones that did.
 */
export function attemptSwitchLines(rows: readonly TaskBoardRow[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    const sw = row.lastModelSwitch;
    if (sw === null) continue;
    if (sw.usedModel === sw.requestedModel && sw.fallbackReason === null) continue;
    const reason = sw.fallbackReason === null ? "no reason recorded" : sw.fallbackReason;
    lines.push(`  ${row.task.id}: requested ${sw.requestedModel} \u2192 used ${sw.usedModel} (${reason})`);
  }
  return lines;
}

/** Render one `ScopeStatus` (running cost, PLAN §3.I) as a line. */
export function scopeStatusLine(scope: ScopeStatus): string {
  const spend =
    scope.spendUsd.limit === null
      ? `$${scope.spendUsd.used.toFixed(2)} spent (no cap)`
      : `$${scope.spendUsd.used.toFixed(2)} / $${scope.spendUsd.limit.toFixed(2)} spent`;
  const unknown = scope.hasUnknownCost ? `, ${scope.unknownCostRequests} request(s) with unpriced cost` : "";
  return `  ${scope.scope} ${scope.id}: ${spend}${unknown}`;
}

/** All ledger scope lines, or `[]` when no ledger status was supplied. */
export function ledgerStatusLines(status: LedgerStatus | null | undefined): string[] {
  if (status === null || status === undefined) return [];
  if (status.scopes.length === 0) return [];
  return ["running cost:", ...status.scopes.map(scopeStatusLine)];
}

/**
 * Full `/korwf status` text: routes/caps (#125), attempt requested\u2192used
 * switches (#66), and running cost (#30). Sections that had nothing to
 * report are omitted rather than printed empty, so an idle workflow's
 * status stays short.
 */
export function statusReportMessage(input: StatusReportInput): string {
  const routeSection = renderRouteLines(input).join("\n");
  const sections = [routeSection];

  const switches = input.taskRows === undefined ? [] : attemptSwitchLines(input.taskRows);
  if (switches.length > 0) sections.push(["model switches:", ...switches].join("\n"));

  const ledgerLines = ledgerStatusLines(input.ledgerStatus);
  if (ledgerLines.length > 0) sections.push(ledgerLines.join("\n"));

  return sections.join("\n\n");
}
