/**
 * `/korwf export [--plan|--todo] <path>` (issue #43; PLAN §3.C, §4 UI).
 *
 * Writes the persisted plan out as Markdown so it can be reviewed outside
 * Pi. `--plan` produces a PLAN-like document (phases, goals, acceptance
 * criteria, tasks with dependencies and checks); `--todo` produces a
 * TODO-like checklist (one line per task, checked when `done`). Read-only
 * against the store — this only ever writes the target file.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Store } from "../../storage/db.ts";
import type { Task, WorkflowId } from "../../storage/records.ts";
import { resolveBoardWorkflow, type WorkflowReadStore } from "./workflow-select.ts";

export type ExportCommandStore = WorkflowReadStore & Pick<Store, "phases" | "tasks">;

export type ExportFormat = "plan" | "todo";

export interface ExportCommandArgs {
  readonly ok: true;
  readonly format: ExportFormat;
  readonly path: string;
  readonly workflowId?: string;
}

export interface ExportParseError {
  readonly ok: false;
  readonly message: string;
}

/** Parse `/korwf export [--plan|--todo] <path> [--workflow <id>]`. */
export function parseExportArgs(argv: readonly string[]): ExportCommandArgs | ExportParseError {
  let format: ExportFormat = "plan";
  let path: string | undefined;
  let workflowId: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--plan") {
      format = "plan";
    } else if (arg === "--todo") {
      format = "todo";
    } else if (arg === "--workflow") {
      workflowId = argv[i + 1];
      i += 1;
    } else if (arg !== undefined && arg !== "") {
      path = arg;
    }
  }
  if (path === undefined) {
    return { ok: false, message: "Usage: /korwf export [--plan|--todo] <path> [--workflow <id>]" };
  }
  return workflowId === undefined ? { ok: true, format, path } : { ok: true, format, path, workflowId };
}

function checksBlock(task: Task): string {
  if (task.checks.length === 0) return "  - checks: none\n";
  return task.checks
    .map(
      (c) =>
        `  - check \`${c.id}\` (${c.kind}${c.required ? ", required" : ""}): \`${c.command}\` in \`${c.cwd}\` → exit ${c.expectedExitCode}`,
    )
    .join("\n") + "\n";
}

function criteriaBlock(task: Task): string {
  if (task.acceptanceCriteria.length === 0) return "";
  return (
    task.acceptanceCriteria.map((c) => `  - acceptance \`${c.id}\`: ${c.text}`).join("\n") + "\n"
  );
}

/** Build the PLAN-like export: phases, goals, acceptance criteria, tasks, checks. */
export function buildPlanMarkdown(
  store: ExportCommandStore,
  workflowId: WorkflowId,
  workflowGoal: string,
): string {
  const phases = store.phases.forWorkflow(workflowId);
  const lines: string[] = [`# Plan: ${workflowGoal}`, ""];
  for (const phase of phases) {
    lines.push(`## Phase ${phase.order}: ${phase.goal} (\`${phase.id}\`, gate: ${phase.gateStatus})`);
    if (phase.acceptanceCriteria.length > 0) {
      lines.push("", "Acceptance criteria:");
      for (const c of phase.acceptanceCriteria) lines.push(`- \`${c.id}\`: ${c.text}`);
    }
    lines.push("", "Tasks:");
    const tasks = store.tasks.forPhase(phase.id);
    if (tasks.length === 0) lines.push("(none)");
    for (const task of tasks) {
      lines.push(`- \`${task.id}\` [${task.status}] ${task.goal}`);
      if (task.dependencies.length > 0) lines.push(`  - depends on: ${task.dependencies.join(", ")}`);
      const criteria = criteriaBlock(task);
      if (criteria !== "") lines.push(criteria.trimEnd());
      lines.push(checksBlock(task).trimEnd());
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Build the TODO-like export: one checkbox line per task, checked when `done`. */
export function buildTodoMarkdown(store: ExportCommandStore, workflowId: WorkflowId, workflowGoal: string): string {
  const phases = store.phases.forWorkflow(workflowId);
  const lines: string[] = [`# TODO: ${workflowGoal}`, ""];
  for (const phase of phases) {
    lines.push(`## Phase ${phase.order}: ${phase.goal}`, "");
    const tasks = store.tasks.forPhase(phase.id);
    for (const task of tasks) {
      const box = task.status === "done" ? "x" : " ";
      const checkIds = task.checks.map((c) => c.id).join(", ") || "none";
      lines.push(`- [${box}] \`${task.id}\` ${task.goal} (status: ${task.status}; checks: ${checkIds})`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Run `/korwf export`: resolve the workflow, build the document, write it to `args.path`. */
export function runExport(
  store: ExportCommandStore,
  args: ExportCommandArgs,
): { readonly ok: boolean; readonly message: string } {
  const resolved = resolveBoardWorkflow(store, args.workflowId);
  if (!resolved.ok) return resolved;

  const markdown =
    args.format === "plan"
      ? buildPlanMarkdown(store, resolved.workflowId as WorkflowId, resolved.workflow.goal)
      : buildTodoMarkdown(store, resolved.workflowId as WorkflowId, resolved.workflow.goal);

  const target = resolve(args.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, markdown, "utf8");
  return { ok: true, message: `Wrote ${args.format} export to ${target}` };
}
