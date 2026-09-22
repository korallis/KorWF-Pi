/**
 * Worker launch and lifecycle (issue #68; ADR 0004 "Invocation shape",
 * "How recursive spawning is prevented", "Cancellation and process-tree
 * termination").
 *
 * A worker is a `pi --mode rpc` subprocess with an explicit model, role tool
 * allowlist, cwd and resource inheritance. Nothing about the launch is
 * implicit: every flag comes from the validated contract, and the task text
 * is sent as the first RPC `prompt` rather than argv, so it never appears in
 * `ps` output.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { buildWorkerEnv } from "./env.ts";
import { validateContract, type ContractError, type ContractPolicy, type WorkerContract } from "./contract.ts";
import { loadRole } from "./roles.ts";
import {
  realProcessOps,
  signalWorker,
  snapshotTree,
  sweepSnapshot,
  waitUntil,
  type ProcessOps,
  type TreeSnapshot,
} from "./process-tree.ts";

/** One decoded RPC message from the worker's stdout. */
export interface RpcMessage {
  readonly type: string;
  readonly id?: string;
  readonly command?: string;
  readonly success?: boolean;
  readonly data?: unknown;
  readonly [key: string]: unknown;
}

/** How a worker run ended. */
export interface WorkerExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** True when the exit was neither a clean stop nor a cancellation we asked for. */
  readonly crashed: boolean;
}

/** Token/cost accounting accumulated from `message_update.usage`. */
export interface WorkerUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  spendUsd: number;
}

/** Which tier of the ADR 0004 ladder ended the worker. */
export type CancelTier = "cooperative" | "graceful" | "hard";

/** Outcome of a cancellation, including what the tree sweep found. */
export interface CancelResult {
  readonly tier: CancelTier;
  readonly snapshot: TreeSnapshot;
  readonly survivors: readonly number[];
}

/** Everything `spawnWorker` needs beyond the contract itself. */
export interface SpawnOptions {
  readonly policy: ContractPolicy;
  /** Path or name of the Pi binary. Defaults to `pi` on PATH, or `KORWF_PI_BIN`. */
  readonly piBin?: string;
  /** Parent environment to scrub. Defaults to `process.env`. */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Injection seam for tests and for the Windows path. */
  readonly processOps?: ProcessOps;
  /** Injection seam: replaces `child_process.spawn`. */
  readonly spawnFn?: typeof nodeSpawn;
  /** Called for every decoded RPC message (progress capture). */
  readonly onMessage?: (message: RpcMessage) => void;
  /** Best-effort visibility surface; failures never fail the worker (ADR 0004). */
  readonly surface?: (contract: WorkerContract) => void | Promise<void>;
}

/** Refusal from `spawnWorker` before any process existed. */
export class ContractRejectedError extends Error {
  readonly errors: readonly ContractError[];
  constructor(errors: readonly ContractError[]) {
    super(`worker contract rejected: ${errors.map((e) => `${e.code}: ${e.message}`).join("; ")}`);
    this.name = "ContractRejectedError";
    this.errors = errors;
  }
}

/**
 * Build the worker's argv from a validated contract (ADR 0004 "Invocation
 * shape"). The three isolation flags are unconditional: `--no-extensions` is
 * recursion guard 1 and is emitted even when the contract loads role
 * extensions with `-e`, because `-e` adds explicit paths to an otherwise
 * empty set rather than re-enabling discovery.
 */
export function buildWorkerArgv(contract: WorkerContract): readonly string[] {
  const argv: string[] = ["--mode", "rpc"];

  if (contract.sessionDir === null) argv.push("--no-session");
  else argv.push("--session-dir", contract.sessionDir);

  argv.push("--no-extensions");
  for (const ext of contract.inheritance.extensions) argv.push("-e", ext);

  argv.push("--no-skills");
  for (const skill of contract.inheritance.skills) argv.push("--skill", skill);
  if (!contract.inheritance.promptTemplates) argv.push("--no-prompt-templates");
  if (!contract.inheritance.contextFiles) argv.push("--no-context-files");

  const slash = contract.model.indexOf("/");
  argv.push("--provider", contract.model.slice(0, slash));
  argv.push("--model", contract.model.slice(slash + 1));
  if (contract.thinking != null && contract.thinking !== "") argv.push("--thinking", contract.thinking);

  argv.push("--tools", contract.tools.join(","));
  argv.push("--name", `korwf-${contract.role}-${contract.workerId}`);
  return argv;
}
