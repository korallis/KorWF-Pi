/**
 * Tests for src/models/cards.ts (issue #57).
 *
 * Test names reference the acceptance criteria in the issue:
 *  - "Unknown model id → card with rated: false and no aptitudes"
 *  - "User override replaces a bundled hint and the field's provenance says user"
 *  - "Outcome with n=1 changes the interval, not the point estimate materially"
 */
import { describe, it, expect } from "vitest";
import {
  mergeCards,
  mergeCardsForCatalog,
  summariseOutcomesForModel,
  wilsonInterval,
  type HintLookup,
  type HintMatch,
  type OverrideLookup,
} from "../../src/models/cards.ts";
import type { CatalogEntry } from "../../src/models/catalog.ts";
import { deriveRouteId } from "../../src/models/route.ts";
import type { ModelOutcome } from "../../src/storage/records.ts";

function entry(overrides: Partial<CatalogEntry> & Pick<CatalogEntry, "id" | "provider">): CatalogEntry {
  return {
    name: overrides.id,
    routeId: deriveRouteId(overrides.provider, overrides.id.split("/")[1] ?? overrides.id),
    reasoning: true,
    thinkingLevelMap: "unknown",
    input: ["text"],
    contextWindow: "unknown",
    maxTokens: "unknown",
    cost: "unknown",
    ...overrides,
  };
}

function outcome(model: string, result: ModelOutcome["result"], spendUsd: number | null, latencyMs: number) {
  return {
    model,
    result,
    cost: { inputTokens: null, outputTokens: null, requests: 1, spendUsd, costBasis: spendUsd === null ? ("unknown" as const) : ("known" as const) },
    latencyMs,
  };
}

describe("mergeCards: AC unknown model id \u2192 card with rated: false and no aptitudes", () => {
  it("no hint, no override, no outcomes \u2192 rated: false, aptitudes: []", () => {
    const e = entry({ id: "vendor/mystery-model", provider: "vendor" });
    const card = mergeCards(e, {});
    expect(card.rated).toBe(false);
    expect(card.aptitudes).toEqual([]);
    expect(card.outcomeStats.n).toBe(0);
  });

  it("hard constraints are copied verbatim from the catalog entry, not invented", () => {
    const e = entry({ id: "vendor/mystery-model", provider: "vendor", contextWindow: 128000 });
    const card = mergeCards(e, {});
    expect(card.hardConstraints.contextWindow).toBe(128000);
    expect(card.hardConstraints.cost).toBe("unknown");
  });
});

describe("mergeCards: AC user override replaces a bundled hint and provenance says user", () => {
  const ref = "vendor/family-x-9" as const;
  const hint: HintMatch = { ref, family: "family-x", aptitudes: ["front-end", "speed"] };
  const hints: HintLookup = new Map([[ref, hint]]);

  it("with no override, aptitude provenance is hint", () => {
    const e = entry({ id: ref, provider: "vendor" });
    const card = mergeCards(e, { hints });
    expect(card.rated).toBe(true);
    const frontEnd = card.aptitudes.find((a) => a.tag === "front-end");
    expect(frontEnd?.source).toBe("hint");
  });

  it("user override on the same tag replaces the hint; provenance flips to user", () => {
    const overrides: OverrideLookup = { [ref]: { aptitudes: ["front-end"], notes: "actually great at it" } };
    const e = entry({ id: ref, provider: "vendor" });
    const card = mergeCards(e, { hints, overrides });
    const frontEnd = card.aptitudes.find((a) => a.tag === "front-end");
    expect(frontEnd?.source).toBe("user");
    expect(card.notes).toBe("actually great at it");
    // the hint-only tag not touched by the override remains, with its original hint provenance
    expect(card.aptitudes.find((a) => a.tag === "speed")?.source).toBe("hint");
  });

  it("registry metadata never appears as an aptitude \u2014 excluded models never reach mergeCards", () => {
    // mergeCardsForCatalog only ever receives catalog.entries, never catalog.excluded;
    // this asserts the merge surface has no channel for registry data to become an aptitude.
    const e = entry({ id: ref, provider: "vendor" });
    const cards = mergeCardsForCatalog([e], { hints });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.aptitudes.every((a) => a.source === "hint" || a.source === "user" || a.source === "outcome")).toBe(true);
  });
});

describe("wilsonInterval: AC outcome with n=1 changes the interval, not the point estimate materially", () => {
  it("n=1 success: point estimate is 1.0 but the interval is wide, not [1,1]", () => {
    const stats = summariseOutcomesForModel("vendor/m" as const, [outcome("vendor/m", "succeeded", 0.02, 1000)]);
    expect(stats.successRate).toBe(1);
    expect(stats.wilsonInterval).not.toBeNull();
    const [low, high] = stats.wilsonInterval!;
    // point estimate (1.0) is unchanged, but the interval is wide at n=1 \u2014 it must not collapse to [1,1]
    expect(low).toBeLessThan(1);
    expect(high).toBeLessThanOrEqual(1);
    expect(high - low).toBeGreaterThan(0.3);
  });

  it("n grows \u2192 interval narrows around the same point estimate", () => {
    const one = wilsonInterval(1, 1);
    const ten = wilsonInterval(10, 10);
    expect(one[1] - one[0]).toBeGreaterThan(ten[1] - ten[0]);
  });

  it("n=0 \u2192 no stats fabricated", () => {
    const stats = summariseOutcomesForModel("vendor/m" as const, []);
    expect(stats.n).toBe(0);
    expect(stats.successRate).toBeNull();
    expect(stats.wilsonInterval).toBeNull();
  });

  it("outcome data adds a distinct 'proven-in-use' tag, never overwriting a hint/user tag", () => {
    const ref = "vendor/family-x-9" as const;
    const hints: HintLookup = new Map([[ref, { ref, family: "family-x", aptitudes: ["front-end"] }]]);
    const e = entry({ id: ref, provider: "vendor" });
    const outcomes = [outcome(ref, "succeeded", 0.02, 1000), outcome(ref, "failed", 0.02, 1200)];
    const card = mergeCards(e, { hints, outcomes });
    expect(card.aptitudes.find((a) => a.tag === "front-end")?.source).toBe("hint");
    const proven = card.aptitudes.find((a) => a.tag === "proven-in-use");
    expect(proven?.source).toBe("outcome");
    expect(card.outcomeStats.n).toBe(2);
    expect(card.rated).toBe(true);
  });
});
