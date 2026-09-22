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

/**
 * A running worker. Owns the RPC framing, progress forwarding, usage
 * accumulation and the three-tier cancellation ladder.
 */
export class WorkerHandle {
  readonly contract: WorkerContract;
  readonly proc: ChildProcess;
  readonly env: Readonly<Record<string, string>>;
  readonly argv: readonly string[];
  readonly usage: WorkerUsage = { inputTokens: 0, outputTokens: 0, requests: 0, spendUsd: 0 };
  readonly messages: RpcMessage[] = [];
  exit: WorkerExit | undefined;
  /** Set when we asked for the exit, so it is not reported as a crash. */
  private cancelled = false;
  private buffer = "";
  private nextId = 1;
  private waiters: { match: (m: RpcMessage) => boolean; resolve: (m: RpcMessage) => void }[] = [];
  private readonly ops: ProcessOps;
  private readonly onMessage: ((m: RpcMessage) => void) | undefined;

  constructor(params: {
    contract: WorkerContract;
    proc: ChildProcess;
    env: Readonly<Record<string, string>>;
    argv: readonly string[];
    ops: ProcessOps;
    onMessage?: ((m: RpcMessage) => void) | undefined;
  }) {
    this.contract = params.contract;
    this.proc = params.proc;
    this.env = params.env;
    this.argv = params.argv;
    this.ops = params.ops;
    this.onMessage = params.onMessage;
    this.proc.stdout?.setEncoding("utf8");
    // LF-only framing: Pi's rpc.md states readline is non-compliant because it
    // also splits on U+2028/U+2029, which may occur inside a JSON string.
    this.proc.stdout?.on("data", (chunk: string) => this.onChunk(chunk));
    this.proc.on("exit", (code, signal) => this.onExit(code, signal));
  }

  /** The worker's pid, or -1 if the process never started. */
  get pid(): number {
    return this.proc.pid ?? -1;
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim() === "") continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        continue; // a non-JSON line is noise, never a protocol error we escalate
      }
      this.deliver(message);
    }
  }

  private deliver(message: RpcMessage): void {
    this.messages.push(message);
    this.accumulateUsage(message);
    this.onMessage?.(message);
    const i = this.waiters.findIndex((w) => w.match(message));
    if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(message);
  }

  private accumulateUsage(message: RpcMessage): void {
    const data = message.data as { usage?: Record<string, unknown> } | undefined;
    const usage = data?.usage;
    if (usage === undefined) return;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    this.usage.inputTokens += num(usage.inputTokens ?? usage.input_tokens);
    this.usage.outputTokens += num(usage.outputTokens ?? usage.output_tokens);
    this.usage.spendUsd += num(usage.costUsd ?? usage.cost);
    this.usage.requests += 1;
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    // Crash detection (ADR 0004): a non-zero code or a signal we did not ask
    // for is a crash. Pending waiters resolve with a synthetic message so
    // nothing hangs on a dead worker.
    this.exit = { code, signal, crashed: !this.cancelled && (code !== 0 || signal !== null) };
    for (const w of this.waiters.splice(0)) w.resolve({ type: "worker_exit", code, signal });
  }

  /** Wait for a matching message, the worker's exit, or the timeout. */
  expect(match: (m: RpcMessage) => boolean, timeoutMs = 30_000): Promise<RpcMessage> {
    if (this.exit !== undefined) {
      return Promise.resolve({ type: "worker_exit", code: this.exit.code, signal: this.exit.signal });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped);
        reject(new Error("timed out waiting for worker RPC message"));
      }, timeoutMs);
      const wrapped = (m: RpcMessage): void => {
        clearTimeout(timer);
        resolve(m);
      };
      this.waiters.push({ match, resolve: wrapped });
    });
  }

  /** Write one JSONL command to the worker's stdin. */
  send(command: Record<string, unknown>): void {
    this.proc.stdin?.write(`${JSON.stringify(command)}\n`);
  }

  /** Send a command and await its correlated response. */
  call(command: Record<string, unknown>, timeoutMs?: number): Promise<RpcMessage> {
    const id = (command.id as string | undefined) ?? `korwf-${this.nextId++}`;
    const full = { ...command, id };
    const pending = this.expect(
      (m) => (m.type === "response" && m.id === id) || m.type === "worker_exit",
      timeoutMs,
    );
    this.send(full);
    return pending;
  }

  /**
   * Hand the worker its task. The role contract and termination criteria go
   * in the prompt body, not on the command line, so the task text never
   * appears in `ps` (ADR 0004 "Invocation shape").
   */
  prompt(text: string = composePrompt(this.contract)): void {
    this.send({ id: `korwf-prompt-${this.nextId++}`, type: "prompt", message: text });
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    return waitUntil(() => this.exit !== undefined, timeoutMs);
  }

  /**
   * Three-tier cancellation (ADR 0004). The descendant snapshot is taken
   * **before** any signal, because after SIGKILL the parent links are gone
   * and Pi's detached commands have reparented to PID 1.
   *
   * 1. cooperative: RPC `abort` + `abort_bash`, wait for the worker to stop;
   * 2. graceful: SIGTERM to the process group and pid, wait `graceMs` — Pi's
   *    own signal handler reaps its tracked children here;
   * 3. hard: SIGKILL group and pid, then sweep every pid in the snapshot that
   *    is still alive.
   */
  async cancel(reason: string = "cancelled"): Promise<CancelResult> {
    void reason;
    this.cancelled = true;
    const snapshot = snapshotTree(this.pid, this.ops);
    const graceMs = this.contract.termination.graceMs;

    if (this.exit === undefined) {
      this.send({ id: `korwf-abort-${this.nextId++}`, type: "abort" });
      this.send({ id: `korwf-abort-bash-${this.nextId++}`, type: "abort_bash" });
      const stopped = await this.waitForExit(graceMs);
      if (stopped) {
        const sweep = await sweepSnapshot(snapshot, graceMs, this.ops);
        return { tier: "cooperative", snapshot, survivors: sweep.survivors };
      }
    } else {
      const sweep = await sweepSnapshot(snapshot, graceMs, this.ops);
      return { tier: "cooperative", snapshot, survivors: sweep.survivors };
    }

    signalWorker(this.pid, "SIGTERM", this.ops);
    if (await this.waitForExit(graceMs)) {
      const sweep = await sweepSnapshot(snapshot, graceMs, this.ops);
      return { tier: "graceful", snapshot, survivors: sweep.survivors };
    }

    signalWorker(this.pid, "SIGKILL", this.ops);
    await this.waitForExit(graceMs);
    const sweep = await sweepSnapshot(snapshot, graceMs, this.ops);
    return { tier: "hard", snapshot, survivors: sweep.survivors };
  }
}

/**
 * The worker's opening prompt: its shipped role contract, then the task, then
 * the termination criteria. Composed here rather than passed on the command
 * line so the task text stays out of `ps`, and so every worker provably gets
 * the incremental-write rules `roles.ts` enforces.
 */
export function composePrompt(contract: WorkerContract): string {
  const role = loadRole(contract.role);
  const artifacts =
    contract.termination.artifacts.length > 0
      ? `\nExpected artifacts:\n${contract.termination.artifacts.map((a) => `- ${a}`).join("\n")}`
      : "";
  return [
    role.body.trimEnd(),
    "",
    "# Your task",
    "",
    contract.task.trim(),
    "",
    "# Termination",
    "",
    contract.termination.completionStatement.trim() + artifacts,
    "",
    `You are worker ${contract.workerId} in ${contract.cwd}. You may not start other agents.`,
  ].join("\n");
}

/**
 * Validate the contract, then launch the worker.
 *
 * Ordering matters and mirrors #60's: policy is enforced **before** the
 * process exists. A contract naming a model outside the allowlist, a tool
 * outside its role, or an extension outside `permittedExtensions` throws
 * {@link ContractRejectedError} and nothing is spawned — there is no code
 * path that spawns first and checks after.
 */
export async function spawnWorker(
  contract: WorkerContract,
  options: SpawnOptions,
): Promise<WorkerHandle> {
  const validation = validateContract(contract, options.policy);
  if (!validation.ok) throw new ContractRejectedError(validation.errors);

  const argv = buildWorkerArgv(contract);
  const parentEnv = options.parentEnv ?? process.env;
  const env = buildWorkerEnv({
    parentEnv,
    workerId: contract.workerId,
    role: contract.role,
    depth: contract.depth,
    offline: contract.offline,
  });

  const spawnFn = options.spawnFn ?? nodeSpawn;
  const piBin = options.piBin ?? parentEnv.KORWF_PI_BIN ?? "pi";
  const proc = spawnFn(piBin, [...argv], {
    cwd: contract.cwd,
    // Own process group on POSIX so tier 2/3 can address the group; Windows
    // has no equivalent and uses `taskkill /T /F` instead.
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...env },
  });

  const handle = new WorkerHandle({
    contract,
    proc,
    env,
    argv,
    ops: options.processOps ?? realProcessOps,
    onMessage: options.onMessage,
  });

  // Visibility is pure observability: if the surface fails or Herdr is absent,
  // the worker still runs (ADR 0004 "Worker visibility in Herdr" rule 3).
  if (options.surface !== undefined) {
    try {
      await options.surface(contract);
    } catch {
      /* best effort only */
    }
  }

  return handle;
}
