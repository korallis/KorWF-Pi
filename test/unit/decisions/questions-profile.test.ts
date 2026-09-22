/**
 * `profile.domain@1`, `profile.reasoningDepth@1`, `profile.contextSize@1`
 * (issue #59): registration, content-hash pin, deterministic structural
 * fallbacks, and the "no model leaked into the question" guarantee.
 */
import { describe, expect, it } from "vitest";
import {
  contextSizeFallbackVerdict,
  depthFallbackVerdict,
  domainFallbackVerdict,
  profileContextSizeQuestion,
  profileDepthQuestion,
  profileDomainQuestion,
  profileQuestionRegistry,
} from "../../../src/decisions/questions/profile.ts";

describe("profile questions registry", () => {
  it("registers all three under profile.*@1", () => {
    expect(profileQuestionRegistry.keys()).toEqual([
      "profile.context_size@1",
      "profile.domain@1",
      "profile.reasoning_depth@1",
    ]);
  });
});

describe("profile.domain@1", () => {
  it("domainFallbackVerdict: no paths is unknown", () => {
    expect(domainFallbackVerdict([])).toBe("unknown");
  });

  it("domainFallbackVerdict: path prefix rules", () => {
    expect(domainFallbackVerdict(["test/models/x.test.ts"])).toBe("testing");
    expect(domainFallbackVerdict(["docs/adr/0001.md"])).toBe("docs");
    expect(domainFallbackVerdict(["src/security/outbound.ts"])).toBe("security");
    expect(domainFallbackVerdict(["README.md"])).toBe("docs");
    expect(domainFallbackVerdict(["src/workflow/index.ts"])).toBe("backend");
  });

  it("fallback delegates to domainFallbackVerdict for every reason", () => {
    for (const reason of ["disabled", "transport_error", "abstained"] as const) {
      const result = profileDomainQuestion.fallback(
        { goal: "g", acceptanceCriteria: [], ownershipPaths: ["docs/x.md"] },
        reason,
      );
      expect(result.value).toBe("docs");
    }
  });

  it("replay round-trips every domain and rejects garbage", () => {
    expect(profileDomainQuestion.replay("backend", { goal: "", acceptanceCriteria: [], ownershipPaths: [] })).toBe("backend");
    expect(profileDomainQuestion.replay("bogus", { goal: "", acceptanceCriteria: [], ownershipPaths: [] })).toBeNull();
  });
});

describe("profile.reasoningDepth@1", () => {
  it("depthFallbackVerdict is always null: unknown, never a guessed number", () => {
    expect(depthFallbackVerdict("add a logout button")).toBeNull();
    expect(depthFallbackVerdict("harden the concurrency-sensitive security boundary")).toBeNull();
  });

  it("fallback always reports unknown regardless of reason", () => {
    for (const reason of ["disabled", "transport_error", "abstained"] as const) {
      const result = profileDepthQuestion.fallback({ goal: "anything", acceptanceCriteria: [] }, reason);
      expect(result.value).toBeNull();
      expect(result.action).toBe("unknown");
    }
  });

  it("replay: unknown round-trips to null, numeric levels round-trip, garbage rejected", () => {
    expect(profileDepthQuestion.replay("unknown", { goal: "", acceptanceCriteria: [] })).toBeNull();
    expect(profileDepthQuestion.replay("0", { goal: "", acceptanceCriteria: [] })).toBe(0);
    expect(profileDepthQuestion.replay("2", { goal: "", acceptanceCriteria: [] })).toBe(1);
    expect(profileDepthQuestion.replay("bogus", { goal: "", acceptanceCriteria: [] })).toBeNull();
  });
});

describe("profile.contextSize@1", () => {
  it("contextSizeFallbackVerdict: file-count buckets", () => {
    expect(contextSizeFallbackVerdict([])).toBe("small");
    expect(contextSizeFallbackVerdict(["a", "b"])).toBe("small");
    expect(contextSizeFallbackVerdict(["a", "b", "c"])).toBe("medium");
    expect(contextSizeFallbackVerdict(Array.from({ length: 11 }, (_, i) => `f${i}`))).toBe("large");
  });

  it("fallback delegates to contextSizeFallbackVerdict", () => {
    const result = profileContextSizeQuestion.fallback({ ownershipPaths: ["a", "b", "c"], estimatedTokens: null }, "disabled");
    expect(result.value).toBe("medium");
  });

  it("replay round-trips every size and rejects garbage", () => {
    expect(profileContextSizeQuestion.replay("large", { ownershipPaths: [], estimatedTokens: null })).toBe("large");
    expect(profileContextSizeQuestion.replay("bogus", { ownershipPaths: [], estimatedTokens: null })).toBeNull();
  });
});

describe("AC: profile questions never mention a model, provider, or card", () => {
  const FORBIDDEN = /model[ _-]?(id|ref|name|card)|provider|\bcard\b|\bgpt\b|\bclaude\b|\bkimi\b|\bastra\b|\bk3\b|mac-mini/i;

  it("no question prompt, option, or level text mentions a model/provider/card", () => {
    for (const q of [profileDomainQuestion, profileDepthQuestion, profileContextSizeQuestion]) {
      expect(q.prompt).not.toMatch(FORBIDDEN);
      expect(JSON.stringify(q.buildQuestion())).not.toMatch(FORBIDDEN);
    }
  });
});
