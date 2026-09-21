/**
 * Composition policy (issue #27; PLAN §6).
 *
 * How several narrow answers become one decision that code then enforces.
 * The rule this module exists to make cheap comes from the bootstrap
 * orchestrator (`scripts/orchestrate/`, a reference, not product code): a
 * single existential question over a large scope deflates with scope size —
 * "is anything wrong anywhere in this diff?" scores lower the larger the
 * diff, for reasons that have nothing to do with the diff. Ask one bounded
 * question per criterion instead, and take the conjunction **in code**.
 *
 * Everything here is deterministic. No arithmetic, counting, or
 * quantification is delegated to Jev (PLAN §6 "graph algorithms, arithmetic,
 * counters, schema checks in code").
 */
import type { DecisionResult } from "./ask.ts";

/** Verdict of a composed decision, with the evidence that produced it. */
export interface Composed<TValue> {
  readonly value: TValue;
  /** The composition rule that produced it, recorded alongside the parts. */
  readonly rule: string;
  /** `true` when at least one part came from the deterministic fallback. */
  readonly degraded: boolean;
  /** Keys of the parts that fell back, in the order given. */
  readonly fellBack: readonly string[];
  /** Keys of the parts that decided the outcome (e.g. the failing ones). */
  readonly deciding: readonly string[];
}

function fallbackKeys(parts: readonly DecisionResult<unknown>[]): readonly string[] {
  return parts.filter((part) => part.source === "fallback").map((part) => part.key);
}

/**
 * Conjunction over per-criterion booleans: true only if every part is true.
 * This is the shape to reach for instead of one broad "is everything fine?"
 * question.
 */
export function allTrue(parts: readonly DecisionResult<boolean>[], rule = "conjunction"): Composed<boolean> {
  const failing = parts.filter((part) => part.value !== true).map((part) => part.key);
  return {
    value: parts.length > 0 && failing.length === 0,
    rule,
    degraded: parts.some((part) => part.source === "fallback"),
    fellBack: fallbackKeys(parts),
    deciding: failing.length > 0 ? failing : parts.map((part) => part.key),
  };
}

/** Disjunction: true if any part is true. Used for "is any of these a blocker?". */
export function anyTrue(parts: readonly DecisionResult<boolean>[], rule = "disjunction"): Composed<boolean> {
  const passing = parts.filter((part) => part.value === true).map((part) => part.key);
  return {
    value: passing.length > 0,
    rule,
    degraded: parts.some((part) => part.source === "fallback"),
    fellBack: fallbackKeys(parts),
    deciding: passing.length > 0 ? passing : parts.map((part) => part.key),
  };
}

/**
 * Rank candidates by an independent per-candidate probability, highest
 * first, and take the leader only if it clears `threshold`. This is the
 * per-criterion decomposition applied to selection: one bounded question per
 * candidate ("is *this* candidate adequate?"), never one question asking Jev
 * to pick from a list, so adding a candidate cannot change the score of the
 * others. The comparison, the ordering and the threshold are code.
 */
export function rankBy<TCandidate>(
  candidates: readonly { readonly candidate: TCandidate; readonly result: DecisionResult<number> }[],
  options: { readonly threshold: number; readonly rule?: string },
): Composed<TCandidate | null> & { readonly ranking: readonly { readonly candidate: TCandidate; readonly score: number }[] } {
  const ranking = candidates
    .map(({ candidate, result }) => ({ candidate, score: result.value }))
    .sort((a, b) => b.score - a.score);
  const parts = candidates.map(({ result }) => result);
  const best = ranking[0];
  const chosen = best !== undefined && best.score >= options.threshold ? best.candidate : null;
  return {
    value: chosen,
    rule: options.rule ?? (chosen === null ? "rank:none_above_threshold" : "rank:top"),
    degraded: parts.some((part) => part.source === "fallback"),
    fellBack: fallbackKeys(parts),
    deciding: best === undefined ? [] : [candidates.find((c) => c.candidate === best.candidate)?.result.key ?? ""],
    ranking,
  };
}

/**
 * Majority over booleans, with an explicit "no majority" outcome rather than
 * a coin toss (PLAN §6 "none/unknown outcomes"). Ties return `null`.
 */
export function majority(parts: readonly DecisionResult<boolean>[], rule = "majority"): Composed<boolean | null> {
  const yes = parts.filter((part) => part.value === true);
  const no = parts.filter((part) => part.value !== true);
  const value = yes.length === no.length ? null : yes.length > no.length;
  return {
    value,
    rule: value === null ? `${rule}:tie` : rule,
    degraded: parts.some((part) => part.source === "fallback"),
    fellBack: fallbackKeys(parts),
    deciding: (value === true ? yes : value === false ? no : parts).map((part) => part.key),
  };
}

/**
 * Conservative gate: a composed verdict may only *permit* something when no
 * part fell back, unless the caller explicitly allows a degraded permit.
 * Codifies PLAN §6 "until enough data exists, use conservative defaults and
 * abstention" and AGENTS.md §4 "deterministic checks cannot be waived".
 */
export function conservative(
  composed: Composed<boolean>,
  options: { readonly permitWhenDegraded?: boolean } = {},
): Composed<boolean> {
  if (composed.value !== true) return composed;
  if (!composed.degraded) return composed;
  if (options.permitWhenDegraded === true) return composed;
  return { ...composed, value: false, rule: `${composed.rule}:degraded_denied` };
}
