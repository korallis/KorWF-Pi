/**
 * Check registration and execution (issue #45; PLAN §3.F, §2.4 (1);
 * `docs/gates.md` §2 "registered check", §4 "check states").
 *
 * A *registered* check is an element of `Task.checks` — the planner writes it
 * before the task can become `ready`, and adding one bumps `Task.revision`,
 * which invalidates every earlier piece of evidence. Project-wide checks from
 * config (`npm test`, `npm run lint`) are merged into that list here, so a
 * project check is registered on exactly the same terms as a task check and
 * is equally unwaivable.
 *
 * `runCheck` executes one registered check in the task's worktree and returns
 * an `EvidenceDraft` pinned to the revision the worktree was at *at that
 * moment*. It never returns `pass` for a command it could not run, it kills
 * the whole process tree when a deadline expires, and everything it captured
 * has been through the redactor before it leaves this module.
 *
 * Boundaries this module respects (ADR 0002):
 * - all git goes through `src/git/` (`readLiveRepoState`);
 * - "is this a real check" is `isVerifyingCheck` from `src/workflow/weak-checks.ts`,
 *   the single definition (#44); there is no second one here;
 * - redaction is `src/security/redact.ts` (#22).
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readLiveRepoState } from "../git/revision.ts";
import type { GitRunner } from "../git/status.ts";
import { realGitRunner } from "../git/status.ts";
import type { CheckDefinition, EvidenceExitStatus, GitSha } from "../storage/records.ts";
import { isVerifyingCheck } from "../workflow/weak-checks.ts";
import {
  DEFAULT_SHELL,
  buildEvidenceDraft,
  capturedOutput,
  classifyOutcome,
  fingerprintEnvironment,
  runStatusOf,
} from "./evidence.ts";
import type {
  CapturedStream,
  CheckRunStatus,
  CommandOutcome,
  EnvironmentFingerprint,
  EvidenceDraft,
  EvidenceSubject,
  UnavailableReason,
} from "./evidence.ts";

// ---------------------------------------------------------------------------
// Registration: project-wide checks merged with the task's own
// ---------------------------------------------------------------------------

/**
 * A project-wide check as a user declares it (`npm test`, `npm run lint`).
 *
 * Deliberately the same shape as a `CheckDefinition` minus the fields that
 * only make sense per task: a project check covers no specific acceptance
 * criterion (it applies to all of them) and gets its id prefixed so it can
 * never collide with, or be shadowed by, a planner-chosen id.
 */
export interface ProjectCheckConfig {
  readonly id: string;
  readonly kind?: CheckDefinition["kind"];
  readonly command: string;
  /** Repository-relative; defaults to the repository root. */
  readonly cwd?: string;
  readonly expectedExitCode?: number;
  /** Project checks are required by default: they are the project's own floor. */
  readonly required?: boolean;
  /** Per-check deadline override, in milliseconds. */
  readonly timeoutMs?: number;
}

/** Id prefix that marks a check as coming from project configuration. */
export const PROJECT_CHECK_PREFIX = "project:";

/** Is this a project-wide check rather than one the planner wrote? */
export function isProjectCheck(check: Pick<CheckDefinition, "id">): boolean {
  return check.id.startsWith(PROJECT_CHECK_PREFIX);
}

/** Normalise one configured project check into a full `CheckDefinition`. */
export function projectCheckDefinition(config: ProjectCheckConfig): CheckDefinition {
  return {
    id: `${PROJECT_CHECK_PREFIX}${config.id}`,
    kind: config.kind ?? "command",
    command: config.command,
    cwd: config.cwd ?? ".",
    expectedExitCode: config.expectedExitCode ?? 0,
    // A project check applies to the whole task rather than to one criterion.
    coversCriteria: [],
    required: config.required ?? true,
  };
}

/**
 * The checks that actually run for a task: its registered checks plus the
 * project-wide ones.
 *
 * Merge rules, in the order they matter:
 *
 * 1. Task checks come first, in plan order, because they are what the gate's
 *    criterion coverage is computed from.
 * 2. A project check is **never dropped** because a task check looks like it.
 *    Namespacing the id is what makes that safe: a plan cannot silence
 *    `npm test` by registering its own check called `test`. Weakening the
 *    project's own floor from inside a plan is precisely the bypass PLAN §2.4
 *    forbids.
 * 3. Two project checks with the same id are one check; the later declaration
 *    wins, so a project layer can override an inherited one.
 */
export function registeredChecks(
  taskChecks: readonly CheckDefinition[],
  projectChecks: readonly ProjectCheckConfig[] = [],
): readonly CheckDefinition[] {
  const byId = new Map<string, CheckDefinition>();
  for (const check of projectChecks) {
    const definition = projectCheckDefinition(check);
    byId.set(definition.id, definition);
  }
  return [...taskChecks, ...byId.values()];
}

// ---------------------------------------------------------------------------
// Process-tree termination (ADR 0004 "cancellation and process-tree kill")
// ---------------------------------------------------------------------------

const IS_WINDOWS = process.platform === "win32";

/** `pid -> ppid` for every visible process. Empty map when it cannot be read. */
export function processTable(): Map<number, number> {
  const table = new Map<number, number>();
  try {
    if (IS_WINDOWS) {
      const out = execFileSync("wmic", ["process", "get", "ProcessId,ParentProcessId"], {
        encoding: "utf8",
        windowsHide: true,
      });
      for (const line of out.split("\n").slice(1)) {
        const [ppid, pid] = line.trim().split(/\s+/).map(Number);
        if (pid && ppid !== undefined && Number.isFinite(ppid)) table.set(pid, ppid);
      }
      return table;
    }
    const out = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid && ppid !== undefined && Number.isFinite(ppid)) table.set(pid, ppid);
    }
  } catch {
    // No `ps`: the snapshot is empty and termination falls back to the group
    // kill. Reported as a caveat rather than silently pretended away.
  }
  return table;
}

/** Transitive children of `root` from a process-table snapshot. */
export function descendantPids(root: number, table: Map<number, number> = processTable()): number[] {
  const out: number[] = [];
  const queue: number[] = [root];
  const seen = new Set<number>([root]);
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const [pid, ppid] of table) {
      if (ppid === parent && !seen.has(pid)) {
        seen.add(pid);
        out.push(pid);
        queue.push(pid);
      }
    }
  }
  return out;
}

/** Is this pid still alive? `kill(pid, 0)` is the portable liveness probe. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone, or not ours. Liveness is re-checked by the caller.
  }
}

/**
 * Kill a check's whole process tree, and prove it.
 *
 * ADR 0004 recorded the finding that makes the snapshot mandatory: a child
 * spawned `detached` sits in its own process group, so a `SIGKILL` to the
 * direct child reparents its descendants to PID 1 and they keep running. The
 * enumeration therefore happens **before** the kill, while the parent links
 * still exist; afterwards there is nothing left to walk.
 *
 * Escalation follows ADR 0004's tiers: `SIGTERM` to the group, grace, then
 * `SIGKILL` to the group, then `SIGKILL` to every snapshotted pid that is
 * still alive.
 */
export async function killProcessTree(
  pid: number,
  options: { readonly graceMs?: number; readonly snapshot?: readonly number[] } = {},
): Promise<readonly number[]> {
  const graceMs = options.graceMs ?? 300;
  const snapshot = options.snapshot ?? descendantPids(pid);
  const targets = [pid, ...snapshot];

  if (IS_WINDOWS) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      // Fall through to the per-pid sweep below.
    }
  } else {
    // Negative pid = the process group, which is what `detached: true` gave
    // the child. The direct pid is signalled too in case the group could not
    // be created.
    signal(-pid, "SIGTERM");
    signal(pid, "SIGTERM");
    await delay(graceMs);
    if (targets.some(isAlive)) {
      signal(-pid, "SIGKILL");
      signal(pid, "SIGKILL");
    }
  }

  // Tier 3: anything from the snapshot that outlived the group kill — the
  // orphans ADR 0004 warns about — is killed individually.
  await delay(graceMs);
  for (const target of targets) {
    if (isAlive(target)) signal(target, "SIGKILL");
  }
  await delay(Math.min(graceMs, 200));
  return targets.filter((target) => !isAlive(target));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    // Never hold the event loop open for a grace period.
    timer.unref?.();
  });
}

// ---------------------------------------------------------------------------
// Running one check
// ---------------------------------------------------------------------------

/** Default per-check deadline. Overridable per check and per call. */
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;

/** What a caller must supply to run a check. */
export interface RunCheckOptions {
  /** Worktree the check runs in. The revision is read from here, at run time. */
  readonly cwd: string;
  /** Workflow/task identity for the resulting evidence row. */
  readonly subject: EvidenceSubject;
  /** Per-check deadline; falls back to `DEFAULT_CHECK_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Cooperative cancellation. An aborted check is `timed_out`, never `pass`. */
  readonly signal?: AbortSignal;
  /** Environment for the child. Defaults to the engine's own, minus nothing. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Byte cap per captured stream. */
  readonly outputLimitBytes?: number;
  /** Injected for tests; all git still goes through `src/git/`. */
  readonly gitRunner?: GitRunner;
  /** Grace period between SIGTERM and SIGKILL on timeout. */
  readonly killGraceMs?: number;
}

/** The outcome of running one check: a draft row plus what a reporter needs. */
export interface CheckRunResult {
  readonly checkId: string;
  readonly status: CheckRunStatus;
  readonly exitStatus: EvidenceExitStatus;
  /** `null` only when the worktree has no revision at all (see `no_revision`). */
  readonly revision: GitSha | null;
  readonly stdout: CapturedStream;
  readonly stderr: CapturedStream;
  readonly durationMs: number;
  readonly fingerprint: EnvironmentFingerprint;
  /** Pids the deadline enforcement had to kill, for the audit trail. */
  readonly killedPids: readonly number[];
  /** Append-ready evidence. `null` for a `human` check — see `requestHumanCheck`. */
  readonly evidence: EvidenceDraft | null;
  readonly caveats: readonly string[];
}

/**
 * Read the revision of the worktree the check is about to run in.
 *
 * Called immediately before every run and never cached: `Evidence.revision`
 * has to be what `git rev-parse HEAD` said *at run time*, because that is the
 * value `docs/gates.md` §2 compares against `SHA(T)` to decide whether the
 * evidence is fresh. A cached revision would make evidence from before a
 * commit look current.
 */
export function revisionAt(cwd: string, runner: GitRunner = realGitRunner): GitSha | null {
  const state = readLiveRepoState(cwd, runner);
  if (state.kind !== "repo") return null;
  return state.head as GitSha | null;
}

/** Resolve a check's repository-relative `cwd` against the worktree root. */
export function resolveCheckCwd(worktree: string, checkCwd: string): string {
  if (checkCwd.length === 0 || checkCwd === ".") return worktree;
  // PLAN §7: a check may not name an absolute path, which would be
  // machine-specific and would escape the task's worktree.
  if (isAbsolute(checkCwd)) return worktree;
  return resolve(worktree, checkCwd);
}

/**
 * Execute a command line under a shell and capture its output.
 *
 * `detached: true` puts the child in its own process group so the whole tree
 * can be signalled at once; without it a `SIGTERM` reaches only the shell and
 * leaves the real work running (ADR 0004).
 */
export function executeCommand(args: {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly killGraceMs?: number;
}): Promise<CommandOutcome> {
  const startedAt = Date.now();
  return new Promise<CommandOutcome>((settle) => {
    let child;
    try {
      child = spawn(args.command, {
        cwd: args.cwd,
        env: args.env as NodeJS.ProcessEnv,
        shell: DEFAULT_SHELL,
        detached: !IS_WINDOWS,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      settle(spawnFailure(error, Date.now() - startedAt));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killedPids: readonly number[] = [];
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // The snapshot is taken while the process tree is still connected: after
    // a SIGKILL the descendants have reparented and cannot be enumerated.
    const terminate = async (): Promise<void> => {
      timedOut = true;
      const pid = child.pid;
      if (pid === undefined) return;
      const snapshot = descendantPids(pid);
      killedPids = await killProcessTree(pid, { graceMs: args.killGraceMs ?? 300, snapshot });
    };

    const timer = setTimeout(() => {
      void terminate();
    }, args.timeoutMs);
    const onAbort = (): void => {
      void terminate();
    };
    args.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, sig: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onAbort);
      settle({
        exitCode,
        signal: sig,
        timedOut,
        unavailable: null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        killedPids,
      });
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onAbort);
      settle({ ...spawnFailure(error, Date.now() - startedAt), stdout, stderr });
    });
    child.on("close", (code, sig) => {
      finish(code, sig);
    });
  });
}

/**
 * A process that never started.
 *
 * `ENOENT` here is the shell itself being missing, not the command inside it
 * — either way the check did not run, so the answer is `unavailable`. There
 * is no branch in this function that can produce a pass.
 */
function spawnFailure(error: unknown, durationMs: number): CommandOutcome {
  const code = (error as NodeJS.ErrnoException).code;
  const reason: UnavailableReason =
    code === "ENOENT" ? "command_not_found" : code === "EACCES" ? "not_executable" : "spawn_failed";
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    unavailable: reason,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    durationMs,
    killedPids: [],
  };
}
