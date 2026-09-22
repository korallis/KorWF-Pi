/**
 * Worker visibility surface (issue #68; ADR 0004 "Worker visibility in
 * Herdr", added after an incident).
 *
 * A headless worker (`--mode rpc`) is not in a terminal pane, so the host's
 * agent panel cannot see it: a correctly running fleet looks identical to a
 * dead orchestrator. The fix is to open the worker's **own worktree** as a
 * Space, which nests under the project because grouping is by git worktree
 * identity.
 *
 * Two rules are structural here, not advisory:
 *
 * - **Never split the caller's pane.** `pane split --current` targets
 *   whichever pane the orchestrator was launched from — the user's. This
 *   module has no code path that can emit it, and
 *   `scripts/orchestrate/check-layout.mjs` scans `src/workers/` for it.
 * - **Best effort.** Visibility must never be able to fail the work, so every
 *   failure here is swallowed and reported in the result, and the host binary
 *   is never required to exist.
 *
 * Closing: only a Space this module opened is closed (`alreadyOpen === false`),
 * and never a tab — closing a tab kills every agent inside it.
 */
import { execFile } from "node:child_process";

/** What the surface attempt did. Never throws; the caller may log this. */
export interface SurfaceResult {
  readonly opened: boolean;
  /** True when a Space for this worktree already existed, so we do not own it. */
  readonly alreadyOpen: boolean;
  readonly reason: string | null;
}

/** Injection seam: runs the host CLI. Resolves with exit code and stdout. */
export type HostRunner = (
  args: readonly string[],
) => Promise<{ readonly code: number; readonly stdout: string }>;

/** Host CLI binary name, overridable by env for tests and unusual installs. */
export function hostBinary(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.KORWF_HOST_BIN ?? "herdr";
}

/** Default runner: invoke the host CLI, resolving (never rejecting) on failure. */
export function defaultHostRunner(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HostRunner {
  const bin = hostBinary(env);
  return (args) =>
    new Promise((resolve) => {
      execFile(bin, [...args], { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
        if (error) {
          resolve({ code: typeof error.code === "number" ? error.code : 1, stdout: String(stdout ?? "") });
          return;
        }
        resolve({ code: 0, stdout: String(stdout ?? "") });
      });
    });
}

/** Inputs for {@link surfaceWorktree}. */
export interface SurfaceParams {
  /** Absolute path of the worker's worktree. */
  readonly worktree: string;
  /** Skip entirely when false (unattended batch runs that nobody is watching). */
  readonly enabled?: boolean;
  readonly run?: HostRunner;
}

/**
 * Open the worker's worktree as its own Space. The only command this function
 * can issue is `worktree open --path <dir>`; there is deliberately no
 * parameterised subcommand, so no caller can steer it into splitting a pane.
 */
export async function surfaceWorktree(params: SurfaceParams): Promise<SurfaceResult> {
  if (params.enabled === false) {
    return { opened: false, alreadyOpen: false, reason: "surface disabled by configuration" };
  }
  if (!params.worktree.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(params.worktree)) {
    return { opened: false, alreadyOpen: false, reason: "worktree path is not absolute" };
  }
  const run = params.run ?? defaultHostRunner();
  try {
    const result = await run(["worktree", "open", "--path", params.worktree]);
    if (result.code !== 0) {
      return { opened: false, alreadyOpen: false, reason: `host exited ${result.code}` };
    }
    const alreadyOpen = /already\s+open/i.test(result.stdout);
    return { opened: true, alreadyOpen, reason: null };
  } catch (error) {
    // Host absent, not on PATH, or refusing: the worker still runs.
    return { opened: false, alreadyOpen: false, reason: (error as Error).message };
  }
}

/** Inputs for {@link closeSurface}. */
export interface CloseSurfaceParams {
  readonly worktree: string;
  /** The result returned when the Space was opened. Ownership is tracked, not assumed. */
  readonly openedResult: SurfaceResult;
  readonly run?: HostRunner;
}

/**
 * Close a Space this process opened. Refuses when the Space pre-existed
 * (`alreadyOpen`), because closing something we did not create can destroy
 * work that is not ours.
 */
export async function closeSurface(params: CloseSurfaceParams): Promise<SurfaceResult> {
  const { openedResult } = params;
  if (!openedResult.opened || openedResult.alreadyOpen) {
    return { opened: false, alreadyOpen: openedResult.alreadyOpen, reason: "not owned by this process" };
  }
  const run = params.run ?? defaultHostRunner();
  try {
    const result = await run(["workspace", "close", "--path", params.worktree]);
    return { opened: false, alreadyOpen: false, reason: result.code === 0 ? null : `host exited ${result.code}` };
  } catch (error) {
    return { opened: false, alreadyOpen: false, reason: (error as Error).message };
  }
}
