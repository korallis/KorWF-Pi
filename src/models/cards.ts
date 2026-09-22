/**
 * Model cards: four-layer merge (issue #57; PLAN §3.D "Model cards").
 *
 * A card is the thing Jev ranks against, not a bare model id. It merges four
 * layers, each optional and each strictly more specific than the last:
 *
 *   1. Pi registry metadata (automatic)   — src/models/catalog.ts (#56). Already
 *      applied *before* this module runs: registry metadata only ever EXCLUDES a
 *      candidate from the catalog. It never appears here as an aptitude source.
 *   2. Bundled aptitude hints (shipped)   — id-pattern matched family hints (#58).
 *   3. User overrides (config)            — models.overrides[<ref>] (#11/#21).
 *   4. Measured outcomes (per user)       — ModelOutcome rows (#125), refined with
 *      a Wilson score interval so a single data point cannot swing the card.
 *
 * The rule that matters (PLAN §3.D, restated in #57): "Registry metadata excludes
 * candidates; hints, overrides, and outcomes RANK them." This module only ever
 * receives models that already survived catalog filtering — it has no power to
 * make an ineligible model eligible, and nothing here re-applies allowlist logic.
 *
 * An id with no hint, no override aptitudes, and no outcomes yields a `rated:
 * false` card with an empty aptitude list — never a fabricated aptitude. A thin
 * card is the deliberate signal that lets Jev answer "not enough information",
 * which routes callers to the static fallback order (src/config/types.ts
 * `FallbackConfig.staticOrder`).
 *
 * Pure module: no I/O, no Pi imports, no provider names, no credentials.
 */
import type { ModelOverride, ModelRef } from "../config/types.ts";
import type { ModelOutcome, OutcomeResult } from "../storage/records.ts";
import type { CatalogEntry } from "./catalog.ts";

// ---------------------------------------------------------------------------
// Provenance: which layer contributed a given field/aptitude.
// ---------------------------------------------------------------------------

/** The layer that produced a piece of card data, in ascending precedence. */
export type CardLayer = "hint" | "user" | "outcome";

/** One aptitude tag, tracked with the layer that currently owns it. */
export interface Aptitude {
  readonly tag: string;
  readonly source: CardLayer;
  /** Free-text detail from the contributing layer (hint description, user note, or outcome summary). */
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// Layer 2 input: bundled aptitude hints (shipped by #58; shape only, here).
// ---------------------------------------------------------------------------

/**
 * One shipped hint entry. #58 owns `src/models/hints.json`/`hints.ts` and the
 * pattern matcher; this module only consumes the *resolved* matches so it does
 * not need to know about regex/id-pattern details or provider-prefix stripping.
 */
export interface HintMatch {
  readonly ref: ModelRef;
  readonly family: string;
  readonly aptitudes: readonly string[];
  readonly caveats?: readonly string[];
}

/** Resolved hint lookup: `ref -> matched hint`, or absent when nothing matched (⇒ unrated by this layer). */
export type HintLookup = ReadonlyMap<ModelRef, HintMatch>;

// ---------------------------------------------------------------------------
// Layer 3 input: user overrides (config, already typed in config/types.ts).
// ---------------------------------------------------------------------------

export type OverrideLookup = Readonly<Record<ModelRef, ModelOverride>>;

// ---------------------------------------------------------------------------
// Layer 4 input: measured outcomes, refined with a Wilson interval.
// ---------------------------------------------------------------------------

/** Outcome stats for one model, across all its routes (PLAN §3.D layer 4). */
export interface OutcomeStats {
  readonly n: number;
  /** Point estimate: succeeded / n. `null` when n === 0. */
  readonly successRate: number | null;
  /** 95% Wilson score interval `[low, high]`. `null` when n === 0. Wide at low n by design. */
  readonly wilsonInterval: readonly [number, number] | null;
  readonly meanCostUsd: number | null;
  readonly meanLatencyMs: number | null;
}

const EMPTY_OUTCOME_STATS: OutcomeStats = {
  n: 0,
  successRate: null,
  wilsonInterval: null,
  meanCostUsd: null,
  meanLatencyMs: null,
};

/**
 * 95% Wilson score interval for a Bernoulli success rate. Chosen over a naive
 * normal-approximation interval because it stays inside [0,1] and does not
 * collapse to a point at n=1 (PLAN §3.D "with uncertainty for sparse data";
 * AC: "Outcome with n=1 changes the interval, not the point estimate materially").
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): readonly [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const low = (centre - margin) / denom;
  const high = (centre + margin) / denom;
  return [Math.max(0, low), Math.min(1, high)];
}

/** True result kinds that count as a success for the card's success rate. */
const SUCCESS_RESULTS: ReadonlySet<OutcomeResult> = new Set(["succeeded"]);

/** Summarise outcomes for one model ref: n, success rate, Wilson interval, mean cost/latency. */
export function summariseOutcomesForModel(
  ref: ModelRef,
  outcomes: readonly Pick<ModelOutcome, "model" | "result" | "cost" | "latencyMs">[],
): OutcomeStats {
  const rows = outcomes.filter((o) => o.model === ref);
  const n = rows.length;
  if (n === 0) return EMPTY_OUTCOME_STATS;
  const successes = rows.filter((o) => SUCCESS_RESULTS.has(o.result)).length;
  const successRate = successes / n;
  const known = rows.filter((o) => o.cost.spendUsd !== null);
  const totalCost = known.reduce((sum, o) => sum + (o.cost.spendUsd ?? 0), 0);
  const totalLatency = rows.reduce((sum, o) => sum + o.latencyMs, 0);
  return {
    n,
    successRate,
    wilsonInterval: wilsonInterval(successes, n),
    meanCostUsd: known.length > 0 ? totalCost / known.length : null,
    meanLatencyMs: totalLatency / n,
  };
}

// ---------------------------------------------------------------------------
// ModelCard: the merged, four-layer view Jev ranks against.
// ---------------------------------------------------------------------------

/**
 * A per-model card. Hard constraints are copied verbatim from the catalog
 * entry (layer 1) — this module never widens or reinterprets them. Everything
 * below `aptitudes` is *ranking* material only; nothing here can make an
 * ineligible model eligible (that already happened, or didn't, in catalog.ts).
 */
export interface ModelCard {
  readonly id: ModelRef;
  readonly provider: string;
  readonly name: string;
  /** Layer-1 hard constraints, copied from the catalog entry as-is. */
  readonly hardConstraints: Pick<
    CatalogEntry,
    "reasoning" | "thinkingLevelMap" | "input" | "contextWindow" | "maxTokens" | "cost"
  >;
  /**
   * Ranking aptitudes, keyed by tag, each carrying its winning layer's
   * provenance. Later layers (user > hint; outcome adds rather than
   * replaces) win on tag collision — see `mergeCards`.
   */
  readonly aptitudes: readonly Aptitude[];
  /** User note from `models.overrides[<ref>].notes`, if any. */
  readonly notes?: string;
  /** Pinned task kinds this model is pinned to (from `models.allowlist.pins`), for display only. */
  readonly pinnedFor: readonly string[];
  readonly outcomeStats: OutcomeStats;
  /**
   * `false` when the card has no aptitude data from any layer (hint, user,
   * or outcome) — an explicit "unrated" signal, never a fabricated aptitude.
   * `true` as soon as *any* layer contributes at least one aptitude tag or a
   * non-empty outcome sample.
   */
  readonly rated: boolean;
}

/** Everything `mergeCards` needs beyond the catalog entries themselves. */
export interface MergeCardsInput {
  readonly hints?: HintLookup;
  readonly overrides?: OverrideLookup;
  /** All available `ModelOutcome` rows; grouped per model inside this function. */
  readonly outcomes?: readonly Pick<ModelOutcome, "model" | "result" | "cost" | "latencyMs">[];
  /** `models.allowlist.pins`, task kind → ref, for the `pinnedFor` display field. */
  readonly pins?: Readonly<Record<string, ModelRef>>;
}

function pinsForRef(ref: ModelRef, pins: Readonly<Record<string, ModelRef>> | undefined): readonly string[] {
  if (!pins) return [];
  return Object.entries(pins)
    .filter(([, pinnedRef]) => pinnedRef === ref)
    .map(([kind]) => kind);
}

/**
 * Merge one catalog entry's card, layer by layer.
 *
 * Order of application (PLAN §3.D):
 *   1. Registry metadata → hard constraints only (already excluded/included by catalog.ts).
 *   2. Bundled hint (if the id pattern matched) → base aptitudes, `source: "hint"`.
 *   3. User override aptitudes (if configured) → REPLACE same-tag hint aptitudes,
 *      `source: "user"`; override notes/pin are carried through regardless of aptitudes.
 *   4. Outcome-derived aptitude, if the sample is large enough to say anything
 *      (`n > 0`) → added as its own tag (`"proven-in-use"`), never replacing a
 *      hint/user aptitude tag, `source: "outcome"`.
 *
 * A tag collision between hint and user is a *replacement* (user wins, same
 * tag, provenance flips to `"user"`). Outcome data never overwrites a tag —
 * it is evidence *about* the model, appended as its own tag, so a poor early
 * measurement cannot erase a documented aptitude; Jev sees both and weighs them.
 */
export function mergeCards(entry: CatalogEntry, input: MergeCardsInput = {}): ModelCard {
  const hint = input.hints?.get(entry.id);
  const override = input.overrides?.[entry.id];
  const outcomeRows = input.outcomes ?? [];
  const outcomeStats = summariseOutcomesForModel(entry.id, outcomeRows);

  const byTag = new Map<string, Aptitude>();

  // Layer 2: bundled hints.
  if (hint) {
    for (const tag of hint.aptitudes) {
      byTag.set(tag, { tag, source: "hint", detail: hint.family });
    }
  }

  // Layer 3: user overrides replace same-tag hints and can add new tags.
  if (override?.aptitudes) {
    for (const tag of override.aptitudes) {
      byTag.set(tag, { tag, source: "user" });
    }
  }

  // Layer 4: measured outcomes contribute a distinct tag, never overwriting 2/3.
  if (outcomeStats.n > 0 && !byTag.has("proven-in-use")) {
    const rate = outcomeStats.successRate ?? 0;
    byTag.set("proven-in-use", {
      tag: "proven-in-use",
      source: "outcome",
      detail: `n=${outcomeStats.n}, success ${(rate * 100).toFixed(0)}%`,
    });
  }

  const aptitudes = Array.from(byTag.values());
  const rated = aptitudes.length > 0 || outcomeStats.n > 0;

  return {
    id: entry.id,
    provider: entry.provider,
    name: entry.name,
    hardConstraints: {
      reasoning: entry.reasoning,
      thinkingLevelMap: entry.thinkingLevelMap,
      input: entry.input,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      cost: entry.cost,
    },
    aptitudes,
    ...(override?.notes !== undefined ? { notes: override.notes } : {}),
    pinnedFor: pinsForRef(entry.id, input.pins),
    outcomeStats,
    rated,
  };
}

/** Merge cards for every catalog entry (the catalog's excluded list is untouched — see catalog.ts). */
export function mergeCardsForCatalog(
  entries: readonly CatalogEntry[],
  input: MergeCardsInput = {},
): readonly ModelCard[] {
  return entries.map((entry) => mergeCards(entry, input));
}
