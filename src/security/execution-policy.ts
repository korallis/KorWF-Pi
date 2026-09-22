/**
 * Execution policy: what a worker of a given role may do (issue #69;
 * PLAN §7 "Execution policy"; §3.E "bounded roles"; threat model B4).
 *
 * > All mutation routes tested (bash, custom tools); disabling `edit`/`write`
 * > alone is not read-only enforcement.
 *
 * This module is the pure predicate behind that sentence. It answers one
 * question — *may this tool call happen?* — from facts only: the role, the
 * tool name and input, the worktree, and the store layout. No model output,
 * no worker claim, and **no Jev probability** is an input: PLAN §7's first
 * bullet ("permissions come from user-approved rules and execution
 * isolation, not semantic confidence") is expressed here as the absence of
 * such a parameter, and `test/security/execution-policy.test.ts` asserts that
 * no field of the input type carries one.
 *
 * Layering, from strongest to weakest (defence in depth, threat model R7):
 *
 * 1. `--tools` on the worker command line (#68) — a read-only role is never
 *    given `bash`, `write` or `edit` at all, so the route does not exist.
 * 2. This policy, applied in the `tool_call` hook (`src/workers/tool-gate.ts`)
 *    — catches anything that reached a tool the allowlist did not remove:
 *    custom tools, tools added by an extension, a widened allowlist.
 * 3. Path boundaries — even a writing role may only touch its own worktree
 *    and its own artifact directory.
 * 4. A sandbox, when the platform provides one; KorWF ships none and records
 *    its absence (`sandboxStatus`).
 */
import { classifyCommand, type ShellVerdict } from "./bash-classifier.ts";
import { DenyMatcher } from "./deny-list.ts";
import { isReadOnlyRole, roleTools, type RoleId } from "../workers/roles.ts";

/** The routes by which a worker could change state. Enumerated, not guessed. */
export const MUTATION_ROUTES = ["edit", "write", "shell", "custom_tool", "git", "store"] as const;
export type MutationRoute = (typeof MUTATION_ROUTES)[number];

/** Why a call was refused. One code per independent rule. */
export type ExecutionDenyRule =
  | "tool_not_in_role_allowlist"
  | "mutation_tool_for_read_only_role"
  | "shell_for_read_only_role"
  | "shell_command_mutates"
  | "unknown_tool_default_deny"
  | "path_outside_worktree"
  | "path_in_deny_list"
  | "git_outside_git_module"
  | "store_write_outside_storage_module"
  | "spawn_tool";

/** One tool call, as the `tool_call` hook sees it. */
export interface ToolCallFacts {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** Everything the policy is evaluated against. All of it is computed by code. */
export interface ExecutionContext {
  readonly role: RoleId;
  /** Absolute path of the worker's worktree (ADR 0009). */
  readonly worktree: string;
  /** Absolute path of the KorWF storage root, usually `<project>/.korwf`. */
  readonly storageRoot?: string;
  /** Attempt id; the worker may write to `<storageRoot>/artifacts/<attemptId>`. */
  readonly attemptId?: string;
  /** Extra deny globs from config. Shipped globs always apply. */
  readonly denyPaths?: readonly string[];
  /** Present sandbox, when one was detected. Recorded, never relied on. */
  readonly sandbox?: SandboxStatus;
}

/** Whether an out-of-process sandbox is present (ADR 0001 row 3). */
export interface SandboxStatus {
  readonly present: boolean;
  readonly mechanism: string | null;
}

/** The verdict. Always explicit: there is no "undefined means allow". */
export interface ExecutionDecision {
  readonly allow: boolean;
  readonly route: MutationRoute | "read";
  readonly rule: ExecutionDenyRule | "allowed";
  readonly reason: string;
  /** Paths the call was found to target, normalised. Empty when none. */
  readonly paths: readonly string[];
  /** Shell verdict when the call was a shell command, else `null`. */
  readonly shell: ShellVerdict | null;
}

/**
 * Tools that are known to be read-only. Everything not named here and not in
 * {@link WRITE_TOOLS} or {@link SHELL_TOOLS} is an unknown tool and is denied
 * for every role that did not have it in its `--tools` list: a custom tool
 * whose behaviour we cannot see is not assumed benign.
 */
export const READ_TOOLS = ["read", "grep", "find", "ls", "glob", "search", "tree", "list"] as const;

/** Built-in tools that write to the filesystem. */
export const WRITE_TOOLS = ["write", "edit", "multiedit", "multi_edit", "apply_patch", "notebook_edit"] as const;

/** Built-in tools that execute a shell command. */
export const SHELL_TOOLS = ["bash", "shell", "sh", "run", "exec", "run_command", "terminal"] as const;

/** Tool names that would start another agent. Never permitted at any depth. */
export const SPAWN_TOOLS = ["korwf_spawn_worker", "agent", "subagent", "spawn", "task", "dispatch_agent"] as const;

/** Input keys that conventionally carry a path. Checked on every tool. */
export const PATH_INPUT_KEYS = [
  "path",
  "file",
  "filePath",
  "file_path",
  "filename",
  "fileName",
  "target",
  "targetPath",
  "dest",
  "destination",
  "output",
  "outputPath",
  "out",
  "dir",
  "directory",
  "cwd",
  "paths",
  "files",
] as const;

const has = (list: readonly string[], name: string): boolean => list.includes(name.toLowerCase());

/**
 * Classify which route a tool call travels by.
 *
 * `"custom_tool"` is the default for any name we do not recognise, and
 * `decideToolCall` treats that route as deny-by-default. That is the whole
 * point of this issue: a role is not read-only because `edit` is absent, it
 * is read-only because every route — including the ones nobody enumerated —
 * is closed unless explicitly opened.
 */
export function routeOf(toolName: string): MutationRoute | "read" {
  const name = toolName.toLowerCase();
  if (has(SPAWN_TOOLS, name)) return "custom_tool";
  if (name === "edit" || name === "multiedit" || name === "multi_edit" || name === "apply_patch") return "edit";
  if (has(WRITE_TOOLS, name)) return "write";
  if (has(SHELL_TOOLS, name)) return "shell";
  if (name.startsWith("git") || name.endsWith("_git")) return "git";
  if (name.startsWith("korwf_store") || name.endsWith("_store")) return "store";
  if (has(READ_TOOLS, name)) return "read";
  return "custom_tool";
}

/** Every path-shaped value in a tool input, flattened and de-duplicated. */
export function extractPaths(input: Readonly<Record<string, unknown>>): readonly string[] {
  const out: string[] = [];
  for (const key of PATH_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") out.push(value);
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string" && v !== "") out.push(v);
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) {
        if (typeof v === "string" && v !== "") out.push(v);
      }
    }
  }
  // `edit`-style tools take an array of {path, ...} edits.
  for (const key of ["edits", "changes", "operations"]) {
    const value = input[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (entry === null || typeof entry !== "object") continue;
      for (const k of PATH_INPUT_KEYS) {
        const v = (entry as Record<string, unknown>)[k];
        if (typeof v === "string" && v !== "") out.push(v);
      }
    }
  }
  return [...new Set(out)];
}

/** The directories a writing role may write into. */
export function writableRoots(ctx: ExecutionContext): readonly string[] {
  const roots = [normalise(ctx.worktree)];
  if (ctx.storageRoot !== undefined && ctx.attemptId !== undefined) {
    roots.push(normalise(`${ctx.storageRoot}/artifacts/${ctx.attemptId}`));
  }
  return roots;
}

/** Collapse separators and resolve `.`/`..` without touching the filesystem. */
export function normalise(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  return (absolute ? "/" : "") + parts.join("/");
}

/** True when `candidate`, resolved against `base`, stays under one of `roots`. */
export function withinRoots(candidate: string, base: string, roots: readonly string[]): boolean {
  const resolved = candidate.startsWith("/") ? normalise(candidate) : normalise(`${base}/${candidate}`);
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}/`));
}

const decision = (
  allow: boolean,
  route: MutationRoute | "read",
  rule: ExecutionDenyRule | "allowed",
  reason: string,
  paths: readonly string[] = [],
  shell: ShellVerdict | null = null,
): ExecutionDecision => ({ allow, route, rule, reason, paths, shell });

/**
 * Decide one tool call. Pure: same inputs, same answer, no clock, no I/O.
 *
 * The order of the checks is the order of the guarantees. Role allowlist
 * first (a call to a tool the role does not have is refused before its input
 * is even read), then route-specific rules, then path boundaries, which apply
 * to *every* role including the implementer.
 */
export function decideToolCall(call: ToolCallFacts, ctx: ExecutionContext): ExecutionDecision {
  const name = call.toolName;
  const route = routeOf(name);
  const readOnly = isReadOnlyRole(ctx.role);

  if (has(SPAWN_TOOLS, name)) {
    return decision(false, route, "spawn_tool", `tool '${name}' can start another agent and is never permitted`);
  }

  // 1. The role's own allowlist. This is the same table `--tools` is built
  //    from, re-checked here so a widened or bypassed command line still
  //    cannot let a call through.
  const allowed = roleTools(ctx.role);
  if (!allowed.includes(name)) {
    const rule: ExecutionDenyRule =
      readOnly && route !== "read" && route !== "custom_tool"
        ? "mutation_tool_for_read_only_role"
        : route === "custom_tool"
          ? "unknown_tool_default_deny"
          : "tool_not_in_role_allowlist";
    return decision(
      false,
      route,
      rule,
      `role '${ctx.role}' may call only [${allowed.join(", ")}]; '${name}' is not among them`,
    );
  }

  // 2. Shell. A read-only role has no shell tool at all, so reaching here
  //    means the allowlist was widened; refuse anyway, then classify.
  if (route === "shell") {
    if (readOnly) {
      return decision(false, route, "shell_for_read_only_role", `read-only role '${ctx.role}' may not run shell commands`);
    }
    const command = typeof call.input["command"] === "string" ? (call.input["command"] as string) : "";
    const verdict = classifyCommand(command);
    const gitDecision = decideShellForWritingRole(command, verdict, ctx);
    if (gitDecision !== null) return gitDecision;
  }

  // 3. Paths, for every role. A read-only role reaching a write tool was
  //    already refused above; this bounds the roles that legitimately write.
  const paths = extractPaths(call.input);
  const pathDecision = decidePaths(paths, route, ctx);
  if (pathDecision !== null) return pathDecision;

  return decision(true, route, "allowed", `'${name}' is permitted for role '${ctx.role}'`, paths);
}

/**
 * Shell rules that apply to roles that *do* have a shell. Returns `null` when
 * the command raises no objection of its own and the path check should run.
 *
 * Two refusals live here even for an implementer:
 * - **git.** ADR 0002 makes `src/git/` the only place that runs git, so a
 *   worker shelling out to `git commit` is bypassing checkpointing,
 *   ownership and the approval classes. It is refused at this gate rather
 *   than merely discouraged in a prompt.
 * - **the store.** `.korwf/` and any `sqlite3` invocation: the database has
 *   invariants (append-only tables, triggers, single writer per ADR 0006)
 *   that only `src/storage/` upholds.
 */
function decideShellForWritingRole(
  command: string,
  verdict: ShellVerdict,
  ctx: ExecutionContext,
): ExecutionDecision | null {
  void ctx;
  if (verdict.rule === "git-mutate" || verdict.rule === "gh-mutate") {
    return decision(
      false,
      "git",
      "git_outside_git_module",
      `git is invoked only through src/git/ (ADR 0002); refused: ${verdict.reason}`,
      [],
      verdict,
    );
  }
  if (verdict.rule === "sqlite" || verdict.rule === "korwf-store") {
    return decision(
      false,
      "store",
      "store_write_outside_storage_module",
      `the KorWF store is written only through src/storage (${verdict.reason})`,
      [],
      verdict,
    );
  }
  if (verdict.rule === "env-file") {
    return decision(false, "shell", "path_in_deny_list", verdict.reason, [], verdict);
  }
  // Any other mutating command is allowed for a writing role only insofar as
  // the path check below permits its targets; the shell verdict is carried
  // through for the audit row either way.
  return null;
}

/**
 * Path boundary. Applies to every role and to reads as well as writes: ADR
 * 0009 makes the worktree the worker's world, and an implementer writing
 * outside it is the second acceptance criterion of this issue.
 *
 * Two independent tests per path, in this order:
 *
 * 1. **Containment.** The path, resolved against the worktree, must land
 *    under the worktree or under this attempt's own artifact directory.
 *    `..` is resolved before the test, so traversal is not a separate case.
 * 2. **Deny globs.** Credential-shaped and store-internal files are refused
 *    even inside the worktree — a `.env` in the worktree is still a `.env`.
 *    The attempt's artifact directory is exempt from the `.korwf` deny glob
 *    and *only* that directory: the SQLite store, the config and the traces
 *    beside it stay denied, because they are written through `src/storage/`
 *    and nothing else (ADR 0006).
 */
function decidePaths(
  paths: readonly string[],
  route: MutationRoute | "read",
  ctx: ExecutionContext,
): ExecutionDecision | null {
  if (paths.length === 0) return null;
  const roots = writableRoots(ctx);
  const artifactRoot = roots.length > 1 ? roots[1] : null;
  const matcher = new DenyMatcher(
    ctx.denyPaths === undefined ? { denyAbsolute: false } : { denyPaths: ctx.denyPaths, denyAbsolute: false },
  );

  for (const path of paths) {
    const resolved = path.startsWith("/") ? normalise(path) : normalise(`${ctx.worktree}/${path}`);
    if (!withinRoots(resolved, ctx.worktree, roots)) {
      return decision(
        false,
        route,
        "path_outside_worktree",
        `'${path}' resolves to '${resolved}', outside the worker's roots [${roots.join(", ")}]`,
        [resolved],
      );
    }
    const inOwnArtifacts =
      artifactRoot !== null && (resolved === artifactRoot || resolved.startsWith(`${artifactRoot}/`));
    const verdict = matcher.verdict(resolved);
    if (verdict.denied && verdict.rule !== "absolute") {
      if (inOwnArtifacts && verdict.glob === "**/.korwf/**") continue;
      return decision(
        false,
        route,
        "path_in_deny_list",
        `'${path}' matches deny entry '${verdict.glob ?? verdict.rule}'`,
        [resolved],
      );
    }
  }
  return null;
}

/**
 * Sandbox presence (ADR 0001 row 3: KorWF ships none). Reported so the
 * residual risk is visible rather than assumed away; nothing in the policy
 * becomes laxer when a sandbox is present.
 */
export const NO_SANDBOX: SandboxStatus = Object.freeze({ present: false, mechanism: null });

/**
 * Detect an out-of-process sandbox from the tool metadata Pi exposes. A
 * sandbox replaces the `bash` tool, so a `bash` entry whose description or
 * provenance names a sandbox mechanism is the signal.
 */
export function detectSandbox(
  tools: readonly { readonly name: string; readonly description?: string; readonly source?: string }[],
): SandboxStatus {
  for (const tool of tools) {
    const text = `${tool.description ?? ""} ${tool.source ?? ""}`.toLowerCase();
    for (const mechanism of ["sandbox-runtime", "bubblewrap", "bwrap", "sandbox-exec", "seatbelt", "sandbox"]) {
      if (text.includes(mechanism)) return { present: true, mechanism };
    }
  }
  return NO_SANDBOX;
}
