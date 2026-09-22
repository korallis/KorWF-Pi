/**
 * `/korwf resume` (issue #71; PLAN §3.E "Pause, resume, cancel").
 *
 * The mirror of `pause.ts`, sharing its argument parser and target
 * resolution so the two commands cannot drift apart in what `--all` or a
 * bare invocation means.
 */
import { resolveTargets, type WorkerCommandArgs, type WorkerCommandResult } from "./pause.ts";
import type { WorkerRegistry } from "../../workers/lifecycle.ts";

export { parseWorkerCommandArgs } from "./pause.ts";
export type { WorkerCommandArgs, WorkerCommandResult } from "./pause.ts";

/** Render `/korwf resume`. Resuming a running worker is reported, not faked. */
export function resumeMessage(registry: WorkerRegistry, args: WorkerCommandArgs): WorkerCommandResult {
  const resolved = resolveTargets(registry, args);
  if (!("runs" in resolved)) return resolved;
  const reason = args.reason ?? "resumed by user";
  const resumed: string[] = [];
  const refused: string[] = [];
  for (const run of resolved.runs) {
    const id = run.handle.contract.workerId;
    if (run.resume(reason)) resumed.push(id);
    else refused.push(`${id} (${run.state})`);
  }
  const lines: string[] = [];
  if (resumed.length > 0) lines.push(`Resumed: ${resumed.join(", ")}.`);
  if (refused.length > 0) lines.push(`Not paused: ${refused.join(", ")}.`);
  return { ok: resumed.length > 0, message: lines.join("\n") };
}
