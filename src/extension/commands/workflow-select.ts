/**
 * Resolving which `Workflow` the boards/export commands show (issue #43).
 *
 * There is no separate "current workflow" record (PLAN §5 doesn't define
 * one): a project has zero or more `Workflow` rows, most of the time one.
 * `--workflow <id>` selects explicitly; otherwise the most recently updated
 * non-terminal workflow wins, falling back to the most recently updated
 * workflow of any status if none is active. This never guesses across
 * projects — it only reads what is already in the caller's store.
 */
import type { Store } from "../../storage/db.ts";
import type { Workflow, WorkflowId } from "../../storage/records.ts";

export type WorkflowReadStore = Pick<Store, "workflows">;

const ACTIVE_STATUSES = new Set<Workflow["status"]>(["planning", "ready", "running", "paused"]);

export type ResolveWorkflowResult =
  | { readonly ok: true; readonly workflowId: WorkflowId; readonly workflow: Workflow }
  | { readonly ok: false; readonly message: string };

/** Pick the workflow the boards should show, or explain why none can be. */
export function resolveBoardWorkflow(store: WorkflowReadStore, workflowId?: string): ResolveWorkflowResult {
  const all = store.workflows.list();
  if (all.length === 0) {
    return { ok: false, message: "No workflow found. Run /korwf plan <goal> first." };
  }

  if (workflowId !== undefined && workflowId !== "") {
    const found = store.workflows.get(workflowId);
    if (found === undefined) {
      return { ok: false, message: `No workflow with id "${workflowId}".` };
    }
    return { ok: true, workflowId: found.id, workflow: found };
  }

  const byRecency = [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const active = byRecency.find((w) => ACTIVE_STATUSES.has(w.status));
  const chosen = active ?? byRecency[0];
  if (chosen === undefined) {
    return { ok: false, message: "No workflow found. Run /korwf plan <goal> first." };
  }
  return { ok: true, workflowId: chosen.id, workflow: chosen };
}
