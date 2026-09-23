/**
 * `/korwf run` availability — recursion guard 2 at the surface where it is
 * visible to a user (issue #68; ADR 0004 "How recursive spawning is
 * prevented").
 *
 * Guard 1 (`--no-extensions`) already means this extension is never loaded in
 * a worker, so in production this code does not run there at all. Guard 2
 * exists because guard 1 is a launch flag, and a launch flag can be lost: a
 * hand-run worker, a future `-e korwf` opt-in, or a compiled-in extension
 * (ADR 0004 note on the `llama` case, docs/threat-model.md R6) would all
 * bypass it. So the extension *also* reads `KORWF_WORKER_DEPTH` at load and
 * registers no spawn surface when it is at or above `workers.maxDepth`.
 *
 * Pure: takes the environment, returns a decision. The extension entry point
 * decides what to do with it, and the test asserts on the decision.
 */
import { canSpawnWorker, readWorkerDepth, DEFAULT_MAX_DEPTH, DEPTH_ENV_VAR } from "../../workers/env.ts";
import type { Store } from "../../storage/db.ts";
import type { PhaseId, WorkflowId } from "../../storage/records.ts";
import { estimateRun, startRun, type RunEstimate, type EstimateRunParams } from "../../workflow/run.ts";
import { isApprovalValid } from "../../storage/records.ts";

type EstimateRunTokens = NonNullable<EstimateRunParams["tokensForTask"]>;
type EstimateRunPrice = NonNullable<EstimateRunParams["priceForTask"]>;

/** Whether `/korwf run` (and any future spawn tool) may be registered. */
export interface RunAvailability {
  readonly available: boolean;
  /** Depth read from the environment; 0 means "not inside a worker". */
  readonly depth: number;
  /** User-facing explanation. Always present, so a refusal is never silent. */
  readonly message: string;
}

/**
 * Decide whether this process may offer the spawn surface.
 * A malformed depth marker reads as the ceiling (`readWorkerDepth`), so a
 * corrupted value refuses rather than permits.
 */
export function runAvailability(
  env: Readonly<Record<string, string | undefined>> = process.env,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): RunAvailability {
  const depth = readWorkerDepth(env);
  const check = canSpawnWorker(env, maxDepth);
  if (check.allowed) {
    return { available: true, depth, message: "spawning is permitted at this depth" };
  }
  return {
    available: false,
    depth,
    message:
      `/korwf run is not available inside a worker: ${check.reason}. ` +
      `Unset ${DEPTH_ENV_VAR} only in an orchestrator process; raising workers.maxDepth is an explicit opt-in.`,
  };
}

/** The message shown when a worker invokes `/korwf run` anyway. */
export function runRefusalMessage(availability: RunAvailability): string {
  return availability.message;
}

// ---------------------------------------------------------------------------
// `/korwf run <phase-id | all>` (issue #74; PLAN §2.1, §2.6)
// ---------------------------------------------------------------------------

export type RunCommandStore = Pick<Store, "workflows" | "phases" | "tasks" | "approvals">;

export interface ParsedRunArgs {
  readonly ok: boolean;
  readonly target: "all" | string | null;
  readonly message: string | null;
}

/** Parse `/korwf run <phase-id | all>`. No other flags in this issue's scope. */
export function parseRunArgs(argv: readonly string[]): ParsedRunArgs {
  const target = argv[0];
  if (target === undefined || target.trim().length === 0) {
    return { ok: false, target: null, message: "Usage: /korwf run <phase-id | all>" };
  }
  return { ok: true, target: target.trim(), message: null };
}

/** Resolve the target phases, in plan order. `all` means every non-terminal phase. */
export function resolveRunTargets(
  store: RunCommandStore,
  workflowId: WorkflowId,
  target: "all" | string,
): { readonly ok: true; readonly phaseIds: readonly PhaseId[] } | { readonly ok: false; readonly message: string } {
  const phases = store.phases.forWorkflow(workflowId);
  if (target === "all") {
    const ids = phases.filter((p) => p.gateStatus !== "passed" && p.gateStatus !== "cancelled").map((p) => p.id);
    if (ids.length === 0) return { ok: false, message: "No pending phases to run." };
    return { ok: true, phaseIds: ids };
  }
  const found = phases.find((p) => p.id === target);
  if (found === undefined) return { ok: false, message: `No phase "${target}" in this workflow.` };
  return { ok: true, phaseIds: [found.id] };
}

/**
 * Is the plan approved at its current revision (PLAN §2.1 "user reviews /
 * edits / approves plan")? A valid, unexpired, non-invalidated `Approval`
 * whose scope is `plan` or `workflow`, pinned to the live `planRevision`, or
 * the workflow already having moved past `planning` (persisted by
 * `persistPlan`/`revisePlan`, #37 — the only path that flips it) both count:
 * either is evidence a human actually reviewed this exact revision.
 */
export function planApproved(store: RunCommandStore, workflowId: WorkflowId, now: string): boolean {
  const workflow = store.workflows.require(workflowId);
  if (workflow.status !== "planning") return true;
  const approvals = store.approvals.findBy("workflowId", workflowId);
  return approvals.some(
    (a) =>
      (a.scope.kind === "plan" || a.scope.kind === "workflow") &&
      isApprovalValid(a, { task: null, planRevision: workflow.planRevision, now: now as never }),
  );
}

export interface RunEstimateSummary {
  readonly estimate: RunEstimate;
  readonly text: string;
}

/** Render the estimate the user sees BEFORE anything is spent (PLAN §2.6). */
export function formatRunEstimate(estimate: RunEstimate): string {
  const lines = [
    `Cost estimate for ${estimate.tasks} task(s) across ${estimate.perPhase.length} phase(s):`,
    `  known:     $${estimate.knownUsd.toFixed(2)}`,
    `  estimated: $${estimate.estimatedUsd.toFixed(2)}`,
    `  unknown:   ${estimate.unknownTasks} task(s) with no price data — not $0, genuinely unpriced`,
  ];
  for (const p of estimate.perPhase) {
    lines.push(
      `    ${p.phaseId}: ${p.tasks} task(s), known $${p.knownUsd.toFixed(2)}, estimated $${p.estimatedUsd.toFixed(2)}, ${p.unknownTasks} unknown`,
    );
  }
  return lines.join("\n");
}

/**
 * Estimate over cap → refused unless approved (issue #74 AC2). Compares the
 * estimate's known+estimated total against `Workflow.budgets.maxSpendUsd`
 * (`null` = uncapped, so nothing to refuse). Unknown-cost tasks never count
 * toward the cap check — they are not $0, but they are also not a known
 * overage; `#81` enforces the hard stop once real spend is measured.
 */
export function estimateExceedsCap(estimate: RunEstimate, maxSpendUsd: number | null): boolean {
  if (maxSpendUsd === null) return false;
  return estimate.knownUsd + estimate.estimatedUsd > maxSpendUsd;
}

/**
 * Has a human granted `spend_over_estimate` for this workflow at the current
 * plan revision? The only override this command honours for an over-cap
 * estimate (PLAN §2.6: a hard cap is still a hard stop regardless of this
 * class — this only ever widens *pre-run* consent, never the ledger's
 * runtime enforcement in #30/#81).
 */
export function spendOverEstimateApproved(store: RunCommandStore, workflowId: WorkflowId, now: string): boolean {
  const workflow = store.workflows.require(workflowId);
  const approvals = store.approvals.findBy("workflowId", workflowId);
  return approvals.some(
    (a) =>
      a.permittedAction === "spend_over_estimate" &&
      isApprovalValid(a, { task: null, planRevision: workflow.planRevision, now: now as never }),
  );
}

export interface RunCommandDeps {
  readonly store: RunCommandStore & Parameters<typeof startRun>[0]["store"];
  readonly workflowId: WorkflowId;
  readonly target: "all" | string;
  readonly now: () => string;
  readonly newId: () => string;
  /** `ctx.ui.confirm`-shaped. `undefined`/non-`true` never proceeds (PLAN §2.6: decline before spend). */
  readonly confirm: (title: string, body: string) => Promise<boolean> | boolean;
  readonly maxSpendUsd?: number | null;
  readonly tokensForTask?: EstimateRunTokens;
  readonly priceForTask?: EstimateRunPrice;
}

export interface RunCommandResult {
  readonly ok: boolean;
  readonly message: string;
  /** `null` when nothing started (refused or declined) — never a run id for a run that never began. */
  readonly runId: string | null;
}

/**
 * `/korwf run <phase-id | all>` end to end (issue #74 Scope):
 *
 * 1. Resolve the target phase(s).
 * 2. Refuse if the plan is not approved at its current revision (AC1).
 * 3. Compute the cost estimate and refuse if it exceeds the workflow's
 *    budget cap, unless `spend_over_estimate` was granted (AC2).
 * 4. Show the estimate and require confirmation — BEFORE `startRun` touches
 *    anything (the ordering itself is the acceptance criterion: an estimate
 *    computed after spending is worthless).
 * 5. Start each phase and report per-phase outcomes.
 */
export async function runCommand(deps: RunCommandDeps): Promise<RunCommandResult> {
  const { store, workflowId, target, now, newId, confirm } = deps;
  const nowIso = now();

  const targets = resolveRunTargets(store, workflowId, target);
  if (!targets.ok) return { ok: false, message: targets.message, runId: null };

  if (!planApproved(store, workflowId, nowIso)) {
    return {
      ok: false,
      message: "Refused: the plan is not approved at its current revision. Run /korwf plan and approve it first.",
      runId: null,
    };
  }

  const estimate = estimateRun({
    store,
    workflowId,
    phaseIds: targets.phaseIds,
    ...(deps.tokensForTask === undefined ? {} : { tokensForTask: deps.tokensForTask }),
    ...(deps.priceForTask === undefined ? {} : { priceForTask: deps.priceForTask }),
  });

  const maxSpendUsd = deps.maxSpendUsd ?? null;
  if (estimateExceedsCap(estimate, maxSpendUsd) && !spendOverEstimateApproved(store, workflowId, nowIso)) {
    return {
      ok: false,
      message:
        `Refused: the estimate ($${(estimate.knownUsd + estimate.estimatedUsd).toFixed(2)}) exceeds the ` +
        `budget cap ($${(maxSpendUsd as number).toFixed(2)}). Grant the "spend_over_estimate" approval to override ` +
        `(a hard cap during the run still stops it — PLAN §2.6).\n\n${formatRunEstimate(estimate)}`,
      runId: null,
    };
  }

  const estimateText = formatRunEstimate(estimate);
  let answer: unknown;
  try {
    answer = await confirm("KorWF-Pi: confirm run", `${estimateText}\n\nProceed?`);
  } catch {
    answer = false;
  }
  if (answer !== true) {
    return { ok: false, message: `Declined. Nothing was started.\n\n${estimateText}`, runId: null };
  }

  const outcome = startRun({
    store,
    workflowId,
    phaseIds: targets.phaseIds,
    actor: { kind: "user", identity: "cli" },
    now: now as () => never,
    newId,
    authorizationCurrent: () => true,
  });
  const started = outcome.results.filter((r) => r.ok).map((r) => r.phaseId);
  const refused = outcome.results.filter((r) => !r.ok);
  // Printed so the user can refer to this run in /korwf status, /korwf pause
  // and /korwf cancel (issue #74 Scope "print the run id").
  const lines = [`Run id: ${outcome.runId}`, "", estimateText, ""];
  if (started.length > 0) lines.push(`Started: ${started.join(", ")}.`);
  if (refused.length > 0) {
    lines.push(...refused.map((r) => `Not started: ${r.phaseId} (${r.reason ?? "unknown reason"})`));
  }
  return { ok: started.length > 0, message: lines.join("\n"), runId: outcome.runId };
}
