/**
 * Process-tree enumeration and termination (issue #68; ADR 0004
 * "Cancellation and process-tree termination").
 *
 * The fact this module exists is the finding from the #16 probe: Pi spawns
 * each shell command `detached: true`, and its SIGTERM handler reaps those
 * children — but **SIGKILL does not**. A killed worker's commands reparent to
 * PID 1 and keep running, and a negative-pid kill of the worker's group does
 * not reach them either, because each command has its own group.
 *
 * Therefore the descendant list is **snapshotted before** the kill, while the
 * parent links still exist, and swept afterwards. Do not "simplify" this to
 * `proc.kill("SIGKILL")` (ADR 0004 Consequences).
 */
import { execFileSync } from "node:child_process";

/** Injection seam: everything this module does to the OS, in one interface. */
export interface ProcessOps {
  /** Whole process table as pid → ppid. */
  table(): Map<number, number>;
  /** Send a signal; must swallow ESRCH (already gone). */
  kill(pid: number, signal: NodeJS.Signals): void;
  /** Is the pid still alive? */
  alive(pid: number): boolean;
  /** Windows-only whole-tree kill; `null` on POSIX. */
  killTreeNative: ((pid: number) => void) | null;
}

const IS_WIN = process.platform === "win32";

/** Read the process table via `ps` (POSIX) or `wmic`/PowerShell (Windows). */
export function readProcessTable(): Map<number, number> {
  const table = new Map<number, number>();
  try {
    if (IS_WIN) {
      // `Win32_Process` is the documented enumeration (ADR 0004 row 11).
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }",
        ],
        { encoding: "utf8", windowsHide: true },
      );
      for (const line of out.split(/\r?\n/)) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (pid) table.set(pid, ppid);
      }
      return table;
    }
    const out = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid) table.set(pid, ppid);
    }
  } catch {
    // An unreadable process table degrades to "no descendants known"; the
    // caller still signals the worker itself. It must never throw during a
    // cancellation.
  }
  return table;
}

/** Default ops, bound to the real OS. */
export const realProcessOps: ProcessOps = {
  table: readProcessTable,
  kill(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  },
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  killTreeNative: IS_WIN
    ? (pid: number): void => {
        try {
          execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          /* already gone */
        }
      }
    : null,
};

/** Transitive children of `root` from a table snapshot, breadth-first. */
export function descendantsOf(root: number, table: ReadonlyMap<number, number>): readonly number[] {
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const queue: number[] = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
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

/** Snapshot of a worker's descendants, taken before any signal is sent. */
export interface TreeSnapshot {
  readonly rootPid: number;
  readonly pids: readonly number[];
  readonly takenAt: number;
}

/** Take a snapshot. Cheap enough to retake before each escalation tier. */
export function snapshotTree(rootPid: number, ops: ProcessOps = realProcessOps): TreeSnapshot {
  return { rootPid, pids: descendantsOf(rootPid, ops.table()), takenAt: Date.now() };
}

/** What a sweep did and what, if anything, survived it. */
export interface SweepResult {
  readonly signalled: readonly number[];
  readonly survivors: readonly number[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `pred` until true or `timeoutMs` elapses. Returns the final value. */
export async function waitUntil(pred: () => boolean, timeoutMs: number, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return pred();
    await sleep(Math.min(stepMs, Math.max(1, deadline - Date.now())));
  }
}

/**
 * SIGKILL every pid in the snapshot that is still alive, then verify.
 * This is the step that closes the orphan hole ADR 0004 records.
 */
export async function sweepSnapshot(
  snapshot: TreeSnapshot,
  timeoutMs: number,
  ops: ProcessOps = realProcessOps,
): Promise<SweepResult> {
  const signalled: number[] = [];
  for (const pid of snapshot.pids) {
    if (!ops.alive(pid)) continue;
    signalled.push(pid);
    if (ops.killTreeNative !== null) ops.killTreeNative(pid);
    else ops.kill(pid, "SIGKILL");
  }
  await waitUntil(() => snapshot.pids.every((pid) => !ops.alive(pid)), timeoutMs);
  return { signalled, survivors: snapshot.pids.filter((pid) => ops.alive(pid)) };
}

/**
 * Signal the worker itself: its process group first (negative pid, POSIX
 * only, reaching anything that stayed in the group), then the pid. On Windows
 * the group concept does not apply and `taskkill /T /F` is the whole
 * operation.
 */
export function signalWorker(pid: number, signal: NodeJS.Signals, ops: ProcessOps = realProcessOps): void {
  if (ops.killTreeNative !== null) {
    ops.killTreeNative(pid);
    return;
  }
  ops.kill(-pid, signal);
  ops.kill(pid, signal);
}
