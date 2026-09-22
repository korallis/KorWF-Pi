/**
 * `context.relevance@1`, `context.staleness@1`, `context.contradiction@1`
 * (issue #35): registration, content-hash pin, and deterministic fallbacks.
 */
import { describe, expect, it } from "vitest";
import {
  contextQuestionRegistry,
  relevanceFallbackScore,
  relevanceQuestion,
  stalenessFallbackScore,
  stalenessQuestion,
  contradictionQuestion,
  STALENESS_FRESH_DAYS,
  STALENESS_AGING_DAYS,
} from "../../../src/decisions/questions/context.ts";

const STATE = { query: "q", path: "f.ts", range: "1-1", text: "t", matchScore: 0, ageDays: null, otherExcerpts: [] };

describe("context questions", () => {
  it("registers all three under context.<name>@1", () => {
    expect(contextQuestionRegistry.keys()).toEqual([
      "context.contradiction@1",
      "context.relevance@1",
      "context.staleness@1",
    ]);
  });

  it("relevance fallback: rg match-score thresholds", () => {
    expect(relevanceFallbackScore(0)).toBe(0);
    expect(relevanceFallbackScore(1)).toBe(1);
    expect(relevanceFallbackScore(2)).toBe(1);
    expect(relevanceFallbackScore(3)).toBe(2);
    expect(relevanceQuestion.fallback({ ...STATE, matchScore: 5 }, "disabled").value).toBe(2);
  });

  it("staleness fallback: age-day thresholds, null age is fresh", () => {
    expect(stalenessFallbackScore(null)).toBe(0);
    expect(stalenessFallbackScore(0)).toBe(0);
    expect(stalenessFallbackScore(STALENESS_FRESH_DAYS - 1)).toBe(0);
    expect(stalenessFallbackScore(STALENESS_FRESH_DAYS)).toBe(1);
    expect(stalenessFallbackScore(STALENESS_AGING_DAYS - 1)).toBe(1);
    expect(stalenessFallbackScore(STALENESS_AGING_DAYS)).toBe(2);
  });

  it("contradiction fallback is always the explicit unknown outcome, never a guess", () => {
    expect(contradictionQuestion.fallback(STATE, "disabled").value).toBe("unknown");
    expect(contradictionQuestion.fallback({ ...STATE, otherExcerpts: ["x", "y"] }, "disabled").value).toBe("unknown");
  });

  it("replay round-trips relevance and staleness scores", () => {
    expect(relevanceQuestion.replay("2", STATE)).toBe(2);
    expect(relevanceQuestion.replay("nope", STATE)).toBeNull();
    expect(stalenessQuestion.replay("1", STATE)).toBe(1);
  });

  it("replay round-trips contradiction verdicts", () => {
    expect(contradictionQuestion.replay("contradicts", STATE)).toBe("contradicts");
    expect(contradictionQuestion.replay("bogus", STATE)).toBeNull();
  });

  it("none are revision-sensitive by declaration (state already names the exact excerpt)", () => {
    expect(relevanceQuestion.revisionSensitive).toBe(false);
    expect(stalenessQuestion.revisionSensitive).toBe(false);
    expect(contradictionQuestion.revisionSensitive).toBe(false);
  });
});
