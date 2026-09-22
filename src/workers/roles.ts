/**
 * Worker role contracts (issue #124 AC5; PLAN §3.E "bounded roles",
 * "explicit worker contracts").
 *
 * The contracts themselves are shipped Markdown under `resources/roles/`, so
 * they are versioned data rather than string literals in code (ADR 0002:
 * `resources/` is shipped, versioned data). This module loads them and
 * asserts, at load time, that every contract carries the incremental-write
 * rules — a role file that silently loses them would reintroduce the failure
 * PRD §3.3 documents.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The six bounded roles from PLAN §3.E. */
export const ROLE_IDS = [
  "scout",
  "planner",
  "implementer",
  "verifier",
  "reviewer",
  "integrator",
] as const;

export type RoleId = (typeof ROLE_IDS)[number];

/**
 * Sentences every role contract must contain. Matched case-insensitively as
 * substrings, so wording around them may evolve while the instruction cannot
 * be dropped.
 */
export const INCREMENTAL_WRITE_RULES = [
  "create each file with a short write",
  "extend it with successive small edits",
  "commit after each file",
  "keep replies to one or two lines",
  "stopreason",
] as const;

/** A loaded contract: the role id and the full Markdown body. */
export interface WorkerRoleContract {
  readonly id: RoleId;
  readonly body: string;
}

/** Absolute path of a shipped role contract. Resolved from this module, never from cwd. */
export function roleContractPath(id: RoleId): string {
  return fileURLToPath(new URL(`../../resources/roles/${id}.md`, import.meta.url));
}

/**
 * Load one role contract and verify it still instructs incremental writes.
 * Throws rather than returning a degraded contract: shipping a role that
 * omits the rule is a defect, not a runtime condition to tolerate.
 */
export function loadRole(id: RoleId): WorkerRoleContract {
  if (!(ROLE_IDS as readonly string[]).includes(id)) {
    throw new Error(`loadRole: unknown role '${id}'`);
  }
  const body = readFileSync(roleContractPath(id), "utf8");
  const lower = body.toLowerCase();
  const missing = INCREMENTAL_WRITE_RULES.filter((rule) => !lower.includes(rule));
  if (missing.length > 0) {
    throw new Error(
      `role contract '${id}' is missing required incremental-write instruction(s): ${missing.join("; ")}`,
    );
  }
  return { id, body };
}

/** Load every shipped role contract, in declaration order. */
export function loadAllRoles(): readonly WorkerRoleContract[] {
  return ROLE_IDS.map(loadRole);
}

/* ------------------------------------------------------------------ *
 * Role -> tool allowlist (issue #68; ADR 0004 "How recursive spawning
 * is prevented", guard 3; PLAN §3.E "explicit worker contracts: …
 * tools …").
 * ------------------------------------------------------------------ */

/**
 * Tool names that create or change something the worker can observe
 * outside its own transcript. Read-only roles get none of them.
 */
export const MUTATION_TOOL_NAMES = ["write", "edit", "multiedit", "apply_patch", "bash"] as const;

/**
 * Tool names that could start another agent. **No role may list one.**
 * `roleTools()` asserts this at load, so adding a spawn tool to a role
 * table is a build failure rather than a recursion.
 */
export const SPAWN_TOOL_NAMES = [
  "korwf_spawn_worker",
  "korwf_run",
  "agent",
  "subagent",
  "spawn",
  "task",
  "dispatch_agent",
] as const;

/** Roles that may not change the repository: they are given no mutation tools. */
export const READ_ONLY_ROLES = ["scout", "planner", "reviewer"] as const satisfies readonly RoleId[];

/** True when the role is one of {@link READ_ONLY_ROLES}. */
export function isReadOnlyRole(id: RoleId): boolean {
  return (READ_ONLY_ROLES as readonly string[]).includes(id);
}

/**
 * The shipped per-role `--tools` allowlist. Passed verbatim to
 * `pi --tools`, which is a strict allowlist across built-in, extension and
 * custom tools (Pi `docs/usage.md`), so anything absent here is not merely
 * discouraged — it is unreachable in the worker.
 */
const ROLE_TOOL_TABLE: Readonly<Record<RoleId, readonly string[]>> = {
  scout: ["read", "grep", "find", "ls"],
  planner: ["read", "grep", "find", "ls"],
  reviewer: ["read", "grep", "find", "ls"],
  implementer: ["read", "grep", "find", "ls", "write", "edit", "multiedit", "bash"],
  verifier: ["read", "grep", "find", "ls", "bash"],
  integrator: ["read", "grep", "find", "ls", "write", "edit", "multiedit", "bash"],
};

/**
 * Tools allowed for a role, checked on every call against both invariants:
 * no spawn tool anywhere, and no mutation tool in a read-only role.
 * Deliberately re-checked rather than asserted once at module load, so a
 * caller cannot reach a stale, already-validated copy of the table.
 */
export function roleTools(id: RoleId): readonly string[] {
  const tools = ROLE_TOOL_TABLE[id];
  if (tools === undefined) throw new Error(`roleTools: unknown role '${id}'`);
  const spawn = tools.filter((t) => (SPAWN_TOOL_NAMES as readonly string[]).includes(t));
  if (spawn.length > 0) {
    throw new Error(`role '${id}' lists spawn tool(s) ${spawn.join(", ")}: workers may not spawn workers`);
  }
  if (isReadOnlyRole(id)) {
    const mutating = tools.filter((t) => (MUTATION_TOOL_NAMES as readonly string[]).includes(t));
    if (mutating.length > 0) {
      throw new Error(`read-only role '${id}' lists mutation tool(s) ${mutating.join(", ")}`);
    }
  }
  return tools;
}

/** A role's full shipped definition: its contract text plus its tool allowlist. */
export interface WorkerRoleDefinition extends WorkerRoleContract {
  readonly tools: readonly string[];
  readonly readOnly: boolean;
}

/** Load a role contract together with its tool allowlist. */
export function loadRoleDefinition(id: RoleId): WorkerRoleDefinition {
  const contract = loadRole(id);
  return { ...contract, tools: roleTools(id), readOnly: isReadOnlyRole(id) };
}
