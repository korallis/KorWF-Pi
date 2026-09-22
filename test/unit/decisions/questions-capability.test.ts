/**
 * `capability.relevance@1` (issue #36): registration, content-hash pin, and
 * the deterministic keyword-overlap fallback.
 */
import { describe, expect, it } from "vitest";
import {
  capabilityQuestionRegistry,
  capabilityRelevanceQuestion,
  keywordOverlapScore,
  sharedKeywordCount,
  tokenize,
} from "../../../src/decisions/questions/capability.ts";

const STATE = { task: "t", name: "n", kind: "skill" as const, description: "d" };

describe("capability questions", () => {
  it("registers capability.relevance@1", () => {
    expect(capabilityQuestionRegistry.keys()).toEqual(["capability.relevance@1"]);
  });

  it("tokenize lower-cases, strips punctuation and stopwords, and drops short words", () => {
    expect(tokenize("Extracts TEXT and Tables from PDF files!")).toEqual(["extracts", "text", "tables", "pdf", "files"]);
    expect(tokenize("a an of to")).toEqual([]);
  });

  it("sharedKeywordCount counts distinct overlapping tokens", () => {
    expect(sharedKeywordCount("write documentation for the api", "formats documentation pages")).toBe(1);
    expect(sharedKeywordCount("extract text tables from pdf documents", "extracts text and tables from pdf files")).toBeGreaterThanOrEqual(2);
  });

  it("keywordOverlapScore: overlap thresholds", () => {
    expect(keywordOverlapScore("frobnicate the widget", "handles pdf forms")).toBe(0);
    expect(keywordOverlapScore("write documentation for the api", "formats documentation pages")).toBe(1);
    expect(keywordOverlapScore("extract text tables from pdf documents", "extracts text and tables from pdf files")).toBe(2);
  });

  it("fallback delegates to keywordOverlapScore", () => {
    const result = capabilityRelevanceQuestion.fallback(
      { ...STATE, task: "extract text tables from pdf documents", description: "extracts text and tables from pdf files" },
      "disabled",
    );
    expect(result.value).toBe(2);
    expect(result.rule).toBe("keyword_overlap");
  });

  it("replay round-trips relevance scores", () => {
    expect(capabilityRelevanceQuestion.replay("2", STATE)).toBe(2);
    expect(capabilityRelevanceQuestion.replay("nope", STATE)).toBeNull();
  });

  it("is not revision-sensitive (state names the exact task/capability pair)", () => {
    expect(capabilityRelevanceQuestion.revisionSensitive).toBe(false);
  });
});
