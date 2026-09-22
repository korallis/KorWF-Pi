/**
 * Repository identity and status (issue #33; ADR 0002 "`git/` is the only
 * place that runs git"). Read-only: this module never mutates the working
 * tree, never stashes, never writes.
 *
 * `detectRepoIdentity` is the single source of truth for "existing repo vs
 * greenfield" (PLAN §2.1, §2.7): callers never shell out to `git` themselves.
 */
import { execFileSync } from "node:child_process";

/** Repository identity as `Workflow.repoIdentity` expects it (docs/records.md). */
export interface RepoIdentity {
  readonly remoteUrl: string | null;
  readonly rootCommit: string;
  readonly name: string;
}

export type RepoDetection =
  | { readonly kind: "existing"; readonly identity: RepoIdentity; readonly dirty: boolean; readonly gitRoot: string }
  | { readonly kind: "greenfield" };

/** Minimal git invocation surface, injected so this module is testable without spawning a process. */
export interface GitRunner {
  run(args: readonly string[], cwd: string): string;
}

function tryRun(runner: GitRunner, args: readonly string[], cwd: string): string | null {
  try {
    return runner.run(args, cwd).trim();
  } catch {
    return null;
  }
}

/** Runs `git` via `execFileSync`. Never touches network, never writes. */
export const realGitRunner: GitRunner = {
  run(args, cwd) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  },
};

const EMPTY_REPO_NO_HEAD = "no commits yet";

/**
 * Detect whether `cwd` is inside a Git repository and, if so, its identity.
 *
 * "Existing repo" requires at least one commit (`git rev-parse HEAD`
 * resolves): a `git init`-only directory with zero commits has no revision
 * to plan against and is treated as greenfield (PLAN §2.7). Dirty state is
 * reported, never blocked on, per issue #33 scope ("warn, don't block").
 */
export function detectRepoIdentity(cwd: string, runner: GitRunner = realGitRunner): RepoDetection {
  const gitRoot = tryRun(runner, ["rev-parse", "--show-toplevel"], cwd);
  if (gitRoot === null) return { kind: "greenfield" };

  const rootCommit = tryRun(runner, ["rev-parse", "HEAD"], gitRoot);
  if (rootCommit === null || rootCommit.length === 0) return { kind: "greenfield" };

  const remoteUrlRaw = tryRun(runner, ["remote", "get-url", "origin"], gitRoot);
  const porcelain = tryRun(runner, ["status", "--porcelain"], gitRoot);
  const name = gitRoot.split("/").filter((s) => s.length > 0).pop() ?? gitRoot;

  return {
    kind: "existing",
    gitRoot,
    dirty: porcelain !== null && porcelain.length > 0,
    identity: {
      remoteUrl: normaliseRemoteUrl(remoteUrlRaw),
      rootCommit,
      name,
    },
  };
}

/** Strip credentials embedded in an `https://user:pass@host/...` remote URL, never persist them. */
export function normaliseRemoteUrl(raw: string | null): string | null {
  if (raw === null || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    // Non-URL remotes (scp-style `git@host:path`) have no embedded credentials to strip.
    return raw;
  }
}

export { EMPTY_REPO_NO_HEAD };
