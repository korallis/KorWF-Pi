/**
 * `/korwf cancel` (issue #71; PLAN §3.E "Propagate cancellation and terminate
 * child process trees").
 *
 * Cancellation goes through `WorkerRun.cancel`, which runs #68's three-tier
 * ladder over a descendant snapshot taken *before* the first signal. This
 * command reports the tier that ended each worker and, crucially, any
 * **survivors** the sweep could not reap: a cancellation that leaves a
 * process behind must say so rather than print a reassuring "cancelled".
 */
import { resolveTargets, type WorkerCommandArgs, type WorkerCommandResult } from "./pause.ts";
import type { WorkerRegistry } from "../../workers/lifecycle.ts";

export { parseWorkerCommandArgs } from "./pause.ts";
export type { WorkerCommandArgs, WorkerCommandResult } from "./pause.ts";

/** Render `/korwf cancel`. Awaits the ladder so the report is a fact, not a hope. */
export async function cancelMessage(
  registry: WorkerRegistry,
  args: WorkerCommandArgs,
): Promise<WorkerCommandResult> {
  const resolved = resolveTargets(registry, args);
  if (!("runs" in resolved)) return resolved;
  const reason = args.reason ?? "cancelled by user";
  const lines: string[] = [];
  let survivorsTotal = 0;
  for (const run of resolved.runs) {
    const id = run.handle.contract.workerId;
    const result = await run.cancel(reason);
    const settled = run.finish();
    registry.remove(id);
    survivorsTotal += result.survivors.length;
    const swept = result.snapshot.pids.length;
    lines.push(
      `${id}: cancelled at the ${result.tier} tier; ` +
        `${swept} descendant process${swept === 1 ? "" : "es"} swept, ` +
        `${result.survivors.length} surviving. ` +
        `Usage settled: ${describeUsage(settled.usage)}.`,
    );
  }
  if (survivorsTotal > 0) {
    lines.push(
      `WARNING: ${survivorsTotal} process(es) survived the sweep and may still be running. ` +
        "This is reported rather than hidden; check them before starting more work.",
    );
  }
  return { ok: survivorsTotal === 0, message: lines.join("\n") };
}

/** Never print `$0.00` for a cost nothing stated (#56, #30). */
function describeUsage(usage: { spendUsd: number | null; costBasis: string; requests: number }): string {
  const spend = usage.spendUsd === null ? "cost unknown" : `$${usage.spendUsd.toFixed(4)} (${usage.costBasis})`;
  return `${usage.requests} request(s), ${spend}`;
}
