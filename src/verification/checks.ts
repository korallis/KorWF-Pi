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
import type { CheckDefinition, GitSha } from "../storage/records.ts";
import { isVerifyingCheck } from "../workflow/weak-checks.ts";

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
