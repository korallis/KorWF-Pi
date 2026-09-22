/**
 * `/korwf pause` (issue #71; PLAN §3.E "Pause, resume, cancel").
 *
 * Pure over the worker registry: takes the parsed arguments and the live
 * runs, returns the message. The extension entry point owns the `ctx.ui`
 * call, so this is testable without Pi and never renders unredacted text.
 */
import type { WorkerRegistry, WorkerRun } from "../../workers/lifecycle.ts";

/** Parsed `/korwf pause` / `/korwf resume` / `/korwf cancel` arguments. */
export interface WorkerCommandArgs {
  /** Worker id to act on; `null` when `--all` or nothing was given. */
  readonly workerId: string | null;
  readonly all: boolean;
  readonly reason: string | null;
}

/** Result of a worker command: what to show and whether it succeeded. */
export interface WorkerCommandResult {
  readonly ok: boolean;
  readonly message: string;
}

/** Parse `<workerId> | --all [--reason <text>]`. */
export function parseWorkerCommandArgs(argv: readonly string[]): WorkerCommandArgs {
  let workerId: string | null = null;
  let all = false;
  let reason: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || arg === "") continue;
    if (arg === "--all") {
      all = true;
    } else if (arg === "--reason") {
      const rest = argv.slice(i + 1).join(" ").trim();
      if (rest.length > 0) reason = rest;
      break;
    } else if (!arg.startsWith("--") && workerId === null) {
      workerId = arg;
    }
  }
  return { workerId, all, reason };
}

/** Shared resolution: which runs a command addresses, or an explanation. */
export function resolveTargets(
  registry: WorkerRegistry,
  args: WorkerCommandArgs,
): { readonly ok: true; readonly runs: readonly WorkerRun[] } | WorkerCommandResult {
  if (args.all) {
    const runs = registry.active();
    if (runs.length === 0) return { ok: false, message: "No active workers." };
    return { ok: true, runs };
  }
  if (args.workerId === null) {
    const active = registry.active();
    if (active.length === 0) return { ok: false, message: "No active workers." };
    if (active.length > 1) {
      return {
        ok: false,
        message:
          `${active.length} workers are active; name one or pass --all: ` +
          active.map((r) => r.handle.contract.workerId).join(", "),
      };
    }
    return { ok: true, runs: active };
  }
  const run = registry.get(args.workerId);
  if (run === undefined) return { ok: false, message: `No worker '${args.workerId}'.` };
  return { ok: true, runs: [run] };
}

/**
 * Render `/korwf pause`.
 *
 * Pausing a finished or already-paused worker is reported, not silently
 * treated as success: "paused" must mean the process is actually stopped.
 */
export function pauseMessage(registry: WorkerRegistry, args: WorkerCommandArgs): WorkerCommandResult {
  const resolved = resolveTargets(registry, args);
  if (!("runs" in resolved)) return resolved;
  const reason = args.reason ?? "paused by user";
  const paused: string[] = [];
  const refused: string[] = [];
  for (const run of resolved.runs) {
    const id = run.handle.contract.workerId;
    if (run.pause(reason)) paused.push(id);
    else refused.push(`${id} (${run.state})`);
  }
  const lines: string[] = [];
  if (paused.length > 0) lines.push(`Paused: ${paused.join(", ")}. Wall-clock limits are suspended while paused.`);
  if (refused.length > 0) lines.push(`Not pausable: ${refused.join(", ")}.`);
  return { ok: paused.length > 0, message: lines.join("\n") };
}
