/**
 * Issue #48 — `review.severity@1` (PLAN §6 "Question family: review-finding
 * severity").
 *
 * AC exercised here:
 *  - AC1 "reviewer prompt contains no worker summary text" — at the question
 *    level: the state shape has nowhere to put a claim, and the state builder
 *    drops anything not declared.
 *  - Scope "fallback = model's suggested severity" — boundary examples run
 *    through `assertBoundaries`, i.e. the no-Jev-key path.
 *
 * No network, no key: nothing here constructs a transport at all.
 */
import { describe, expect, it } from "vitest";
import {
  REVIEW_EXCERPT_BYTES,
  REVIEW_QUESTIONS,
  REVIEW_QUESTION_HASHES,
  REVIEW_SEVERITIES,
  SEVERITY_RANK,
  clampReviewExcerpt,
  isReviewSeverity,
  normaliseSeverity,
  reviewQuestionRegistry,
  reviewSeverityQuestion,
  type ReviewSeverityState,
} from "../../../src/decisions/questions/review.ts";
import { assertBoundaries, type AnyQuestionDefinition } from "../../../src/decisions/question.ts";

const STATE: ReviewSeverityState = {
  findingId: "f1",
  location: { path: "src/a.ts", startLine: 10, endLine: 12 },
  description: "empty-items branch returns 200 instead of 400",
  suggested: "major",
  criterion: { id: "ac1", text: "empty items => 400" },
  excerpt: "if (items.length === 0) return ok();",
  changeClass: "behaviour",
};

describe("review.severity@1 is a registered, pinned question", () => {
  it("registers at id@version with its content hash", () => {
    expect(reviewSeverityQuestion.key).toBe("review.severity@1");
    expect(REVIEW_QUESTION_HASHES["review.severity@1"]).toBe(reviewSeverityQuestion.contentHash);
    expect(reviewQuestionRegistry.get("review.severity@1")).toBeDefined();
  });

  it("offers every severity including an explicit unknown", () => {
    expect(REVIEW_SEVERITIES).toEqual(["blocker", "major", "minor", "nit", "unknown"]);
    expect(SEVERITY_RANK.blocker).toBeGreaterThan(SEVERITY_RANK.unknown);
    expect(SEVERITY_RANK.unknown).toBeGreaterThan(SEVERITY_RANK.major);
  });
});

describe("AC1: the question state cannot carry a worker claim", () => {
  it("sends only the declared claim-free fields", () => {
    const sent = reviewSeverityQuestion.buildState(STATE) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([
      "changeClass",
      "criterion",
      "description",
      "excerpt",
      "findingId",
      "location",
      "suggested",
    ]);
  });

  it("drops an undeclared claim field a caller tries to smuggle in", () => {
    const smuggled = { ...STATE, claim: "I implemented and verified this." } as ReviewSeverityState;
    const sent = JSON.stringify(reviewSeverityQuestion.buildState(smuggled));
    expect(sent).not.toContain("I implemented");
    expect(sent).not.toContain("claim");
  });

  it("clamps an oversized excerpt to the declared budget", () => {
    const long = "x".repeat(REVIEW_EXCERPT_BYTES + 500);
    expect(clampReviewExcerpt(long).length).toBe(REVIEW_EXCERPT_BYTES + 1);
    const sent = reviewSeverityQuestion.buildState({ ...STATE, excerpt: long }) as unknown as { excerpt: string };
    expect(sent.excerpt.length).toBe(REVIEW_EXCERPT_BYTES + 1);
  });
});

describe("Scope: the deterministic fallback is the reviewer's suggestion", () => {
  it("satisfies every declared boundary example with no key", () => {
    for (const question of REVIEW_QUESTIONS) {
      expect(() => assertBoundaries(question as unknown as AnyQuestionDefinition)).not.toThrow();
    }
  });

  it("keeps a suggested blocker when Jev is disabled", () => {
    const got = reviewSeverityQuestion.fallback({ ...STATE, suggested: "blocker" }, "disabled");
    expect(got.value).toBe("blocker");
    expect(got.rule).toBe("reviewer_suggested");
  });

  it("coerces an invented severity to unknown rather than something convenient", () => {
    expect(normaliseSeverity("catastrophic")).toBe("unknown");
    expect(normaliseSeverity("")).toBe("unknown");
    expect(normaliseSeverity(undefined)).toBe("unknown");
    expect(isReviewSeverity("nit")).toBe(true);
    expect(isReviewSeverity("NIT")).toBe(false);
  });

  it("coerces an out-of-band Jev answer to unknown", () => {
    const decided = reviewSeverityQuestion.interpret(
      { type: "choice", choice: "very bad", confidence: 0.9 } as never,
      STATE,
    );
    expect(decided?.value ?? "unknown").toBe("unknown");
  });
});
