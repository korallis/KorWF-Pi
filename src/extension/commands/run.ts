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
