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
