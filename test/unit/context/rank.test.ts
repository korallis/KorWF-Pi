/**
 * AC: "Fixture repo: query for a known feature returns the implementing file
 * in the top 3 ... with ... Jev" (ranked half).
 * AC: "Pinned file is present in output even when Jev scores it lowest (mock)."
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import { DisabledJevTransport } from "../../../src/jev/disabled.ts";
import type { AskContext } from "../../../src/decisions/ask.ts";
import { retrieveCandidates } from "../../../src/context/retrieve.ts";
import { rankCandidates, expandShortlist, combinedScore, DEFAULT_MAX_CANDIDATES } from "../../../src/context/rank.ts";
import { mergeWithPins, pinFile } from "../../../src/context/pins.ts";
import { buildTestRepo, type TestRepo } from "./support.ts";
import type { JevEvaluateResult, SystemOneRequest } from "../../../src/jev/transport.ts";

/** Score `src/auth.ts` highly relevant/fresh and everything else low, so a
 * test can assert both the "known feature wins" and "pin survives" ACs. */
function scoringResponder(lowPath: string) {
  return (request: SystemOneRequest): JevEvaluateResult => {
    const state = request.state as { path?: string };
    const low = state.path === lowPath;
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(request.questions)) {
      if (question.type === "score") {
        const instructions = String(question.instructions);
        const isRelevance = instructions.includes("relevant is this excerpt to answering");
        const score = isRelevance ? (low ? 0 : 2) : low ? 2 : 0; // staleness inverted intentionally
        answers[key] = {
          type: "score",
          score,
          legend: { "0": "a", "1": "b", "2": "c" },
          probabilities: { "0": score === 0 ? 0.8 : 0.1, "1": 0.1, "2": score === 2 ? 0.8 : 0.1 },
          confidence: 0.9,
        };
      } else if (question.type === "choice") {
        answers[key] = { type: "choice", choice: "consistent", probabilities: { contradicts: 0.1, consistent: 0.8, unknown: 0.1 }, confidence: 0.9 };
      }
    }
    return {
      kind: "ok",
      response: { model: "mock", answers, usage: { input_tokens: 1, output_tokens: 1 } },
      requestId: "r",
      attempts: 1,
      elapsedMs: 1,
    };
  };
}

describe("rank.ts", () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = buildTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("AC: with Jev, the known feature's file ranks in the top 3", async () => {
    const { candidates } = retrieveCandidates("password hashing", { repoRoot: repo.root });
    const transport = new MockJevTransport({ responder: scoringResponder("src/utils.ts") });
    const ctx: AskContext = { transport, model: "jev-test" };
    const ranked = await rankCandidates(ctx, "password hashing", candidates);
    const top3 = ranked.slice(0, 3).map((r) => r.candidate.provenance.path);
    expect(top3).toContain("src/auth.ts");
  });

  it("AC: without Jev, the known feature's file still ranks in the top 3 (fallback = rg score and recency)", async () => {
    const { candidates } = retrieveCandidates("password hashing", { repoRoot: repo.root });
    const ctx: AskContext = { transport: new DisabledJevTransport(), model: "jev-test" };
    const ranked = await rankCandidates(ctx, "password hashing", candidates);
    const top3 = ranked.slice(0, 3).map((r) => r.candidate.provenance.path);
    expect(top3).toContain("src/auth.ts");
    expect(ranked[0]?.relevanceResult.source).toBe("fallback");
  });

  it("AC: a pinned file is present in output even when Jev scores it lowest", async () => {
    const { candidates } = retrieveCandidates("function", { repoRoot: repo.root });
    const transport = new MockJevTransport({ responder: scoringResponder("src/utils.ts") });
    const ctx: AskContext = { transport, model: "jev-test" };
    const ranked = await rankCandidates(ctx, "password", candidates);

    const utilsEntry = ranked.find((r) => r.candidate.provenance.path === "src/utils.ts");
    expect(utilsEntry).toBeDefined();
    // Confirm it really did score lowest before asserting the pin rescues it.
    expect(utilsEntry?.relevance).toBe(0);
    const lowest = [...ranked].sort((a, b) => a.score - b.score)[0];
    expect(lowest?.candidate.provenance.path).toBe("src/utils.ts");

    const pin = pinFile(repo.root, "src/utils.ts", repo.revision);
    // Simulate a shortlist that dropped the low scorer, then merge pins back in.
    const shortlist = ranked.filter((r) => r.candidate.provenance.path !== "src/utils.ts").map((r) => r.candidate);
    const merged = mergeWithPins([pin], shortlist);
    expect(merged.map((c) => c.provenance.path)).toContain("src/utils.ts");
  });

  it("bounds evaluation to maxCandidates", async () => {
    const transport = new MockJevTransport({ responder: scoringResponder("nope") });
    const ctx: AskContext = { transport, model: "jev-test" };
    const many = Array.from({ length: 5 }, (_, i) => ({
      provenance: {
        revision: repo.revision,
        path: `f${i}.ts`,
        range: { startLine: 1, endLine: 1 },
        retrievalMethod: "search" as const,
        contentHash: "a".repeat(64),
      },
      text: `text ${i}`,
      matchScore: 1,
      ageDays: null,
    }));
    const ranked = await rankCandidates(ctx, "q", many, { maxCandidates: 2 });
    expect(ranked).toHaveLength(2);
  });

  it("expandShortlist ranks only the not-yet-ranked remainder", async () => {
    const transport = new MockJevTransport({ responder: scoringResponder("nope") });
    const ctx: AskContext = { transport, model: "jev-test" };
    const { candidates } = retrieveCandidates("password", { repoRoot: repo.root });
    const first = await rankCandidates(ctx, "password", candidates, { maxCandidates: 1 });
    expect(first.length).toBe(1);
    const expanded = await expandShortlist(ctx, "password", candidates, first);
    const expandedPaths = expanded.map((r) => r.candidate.provenance.path);
    expect(expandedPaths).not.toContain(first[0]?.candidate.provenance.path);
  });

  it("combinedScore penalises staleness and contradiction", () => {
    expect(combinedScore(2, 0, "consistent")).toBeGreaterThan(combinedScore(2, 2, "consistent"));
    expect(combinedScore(2, 0, "consistent")).toBeGreaterThan(combinedScore(2, 0, "contradicts"));
  });

  it("DEFAULT_MAX_CANDIDATES is a sane positive bound", () => {
    expect(DEFAULT_MAX_CANDIDATES).toBeGreaterThan(0);
  });
});
