/**
 * `/korwf approvals` (issue #49; PLAN §2.6, §7).
 *
 * The queue has to be *visible*, because PLAN §2.6's "queue and continue" is
 * only honest if the user can find out what is waiting when they come back.
 *
 * Read-only by construction: this module opens nothing, writes nothing and
 * takes a read store. Answering a question is `/korwf approve` /
 * `/korwf deny`, which go through `src/workflow/approvals.ts` so every grant
 * is re-validated against the live revisions before a record exists.
 */
import type { Store } from "../../storage/db.ts";
import type { IsoTimestamp, WorkflowId } from "../../storage/records.ts";
import { approvalQueue, type ApprovalQueueRow, type ApprovalReadStore } from "../../workflow/approvals.ts";
import { renderBoardTable, type BoardTable } from "../ui/board.ts";
import { resolveBoardWorkflow, type WorkflowReadStore } from "./workflow-select.ts";

export type ApprovalsCommandStore = WorkflowReadStore & ApprovalReadStore & Pick<Store, "approvalRequests" | "tasks">;

export interface ApprovalsCommandArgs {
  readonly workflowId?: string;
  /** Show only the PLAN §7 classes. */
  readonly highRiskOnly?: boolean;
  readonly now: string;
}

/** Parse `/korwf approvals [--workflow <id>] [--high-risk]`. */
export function parseApprovalsArgs(argv: readonly string[], now: string): ApprovalsCommandArgs {
  const out: { workflowId?: string; highRiskOnly?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workflow") {
      const value = argv[i + 1];
      if (value !== undefined) out.workflowId = value;
      i += 1;
    } else if (arg === "--high-risk") {
      out.highRiskOnly = true;
    }
  }
  return { ...out, now };
}

/** Build the `BoardTable` for the queue. Pure, so it is tested without a store. */
export function approvalsBoardTable(rows: readonly ApprovalQueueRow[]): BoardTable {
  return {
    title: "Pending approvals (STOP = the phase is stopped until answered)",
    columns: [
      { header: "request" },
      { header: "disposition" },
      { header: "class" },
      { header: "scope" },
      { header: "action" },
      { header: "rev", align: "right" },
      { header: "state" },
      { header: "summary" },
    ],
    rows: rows.map((row) => {
      const r = row.request;
      const scope =
        r.scope.kind === "task" ? r.scope.taskId : r.scope.kind === "phase" ? r.scope.phaseId : r.scope.kind;
      return [
        r.requestId,
        row.highRisk ? "HIGH-RISK/STOP" : row.stopsPhase ? "STOP" : "QUEUED",
        r.classId,
        scope,
        r.permittedAction,
        String(r.taskRevision ?? "-"),
        row.staleReason === null ? "live" : `STALE:${row.staleReason}`,
        r.summary,
      ];
    }),
  };
}

/** Render `/korwf approvals`. */
export function approvalsMessage(
  store: ApprovalsCommandStore,
  args: ApprovalsCommandArgs,
): { readonly ok: boolean; readonly message: string } {
  const resolved = resolveBoardWorkflow(store, args.workflowId);
  if (!resolved.ok) return resolved;
  const all = approvalQueue(store, resolved.workflowId as WorkflowId, args.now as IsoTimestamp);
  const rows = args.highRiskOnly === true ? all.filter((r) => r.highRisk) : all;
  const table = renderBoardTable(approvalsBoardTable(rows));
  const note =
    rows.length === 0
      ? "\n\nNothing is waiting on a human."
      : "\n\nA STALE request cannot be granted: the revision, mode or policy moved since it was asked.";
  return { ok: true, message: `${table}${note}` };
}
