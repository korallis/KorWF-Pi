/**
 * User pins and explicit overrides (issue #61; PLAN §3.D "Caps and
 * fallback: Pinned model — user pins are not overridden by fallback
 * without asking").
 *
 * Ordering (non-negotiable, same family as `select.ts`): (1) code computes
 * the eligible set; (2) a pin, if present, is the user's explicit
 * instruction and outranks Jev's ranking entirely; (3) code still enforces
 * allowlist/budget/policy on the pin and rejects it if it fails — a pin can
 * never widen what is permitted. A pinned model that is capped or otherwise
 * ineligible is never silently substituted: this module reports that the
 * pin needs a decision (`needs_ask`), and the caller (workflow layer) is
 * responsible for raising `model-substitute-pinned` rather than degrading.
 */
import type { ModelAllowlist, ModelRef, TaskKind } from "../config/types.ts";
import type { PolicyCheck, SelectionCandidate } from "./select.ts";
import { enforcePolicy } from "./select.ts";

/** Pin resolution order: task > phase > workflow > config (PLAN §3.D). */
export interface PinScopes {
  readonly task?: ModelRef;
  readonly phase?: ModelRef;
  readonly workflow?: ModelRef;
  readonly config?: ModelRef;
}

/**
 * Resolve the effective pin for a task kind: the first scope set, in
 * task > phase > workflow > config order (PLAN §3.D). `allowlistPins` is
 * `config.models.allowlist.pins` (per-task-kind); a task/phase/workflow
 * scope pin — the user's most specific, most recent instruction — always
 * wins over it.
 */
export function resolvePin(scopes: PinScopes, allowlistPins: ModelAllowlist["pins"], taskKind: TaskKind): ModelRef | null {
  if (scopes.task !== undefined) return scopes.task;
  if (scopes.phase !== undefined) return scopes.phase;
  if (scopes.workflow !== undefined) return scopes.workflow;
  if (scopes.config !== undefined) return scopes.config;
  const byKind = allowlistPins[taskKind];
  if (byKind !== undefined) return byKind;
  const byDefault = allowlistPins.default;
  return byDefault ?? null;
}

export type PinResolution =
  | { readonly kind: "no_pin" }
  | { readonly kind: "pinned"; readonly ref: ModelRef; readonly candidate: SelectionCandidate }
  | { readonly kind: "needs_ask"; readonly ref: ModelRef; readonly reason: "capped" | "not_eligible" | "policy_rejected"; readonly check: PolicyCheck | null };

/**
 * Given a resolved pin ref (or none) and the eligible candidate set, decide
 * whether the pin can be honoured outright, needs to ask the user, or there
 * is no pin at all. Never falls back silently.
 */
export function applyPin(
  pinRef: ModelRef | null,
  candidates: readonly SelectionCandidate[],
  allowlist: ModelAllowlist,
  checkBudget?: (ref: ModelRef) => boolean,
): PinResolution {
  if (pinRef === null) return { kind: "no_pin" };

  const eligible = new Set(candidates.map((c) => c.ref));
  const candidate = candidates.find((c) => c.ref === pinRef);

  // Not in the code-computed eligible set (e.g. capped route, or never in
  // the catalog at all): ask, never silently substitute.
  if (candidate === undefined) {
    return { kind: "needs_ask", ref: pinRef, reason: "capped", check: null };
  }

  // Still policy: allowlist/budget are never widened by a pin.
  const check = enforcePolicy(pinRef, eligible, allowlist, checkBudget);
  if (!check.ok) {
    return { kind: "needs_ask", ref: pinRef, reason: "policy_rejected", check };
  }

  return { kind: "pinned", ref: pinRef, candidate };
}
