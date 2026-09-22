import { describe, expect, it } from "vitest";
import { hasCompleteProvenance, hashSlice, provenanceOf, verifyProvenance } from "../../../src/context/provenance.ts";

describe("provenance.ts", () => {
  it("computes contentHash as sha256 of the exact text", () => {
    const p = provenanceOf("hello world", {
      revision: "a".repeat(40),
      path: "src/x.ts",
      range: { startLine: 1, endLine: 1 },
      retrievalMethod: "search",
    });
    expect(p.contentHash).toBe(hashSlice("hello world"));
    expect(p.contentHash).toHaveLength(64);
  });

  it("verifyProvenance detects tampering", () => {
    const p = provenanceOf("original", {
      revision: "a".repeat(40),
      path: "x.ts",
      range: { startLine: 1, endLine: 2 },
      retrievalMethod: "search",
    });
    expect(verifyProvenance(p, "original")).toBe(true);
    expect(verifyProvenance(p, "tampered")).toBe(false);
  });

  it("AC: every excerpt has all five provenance fields", () => {
    const p = provenanceOf("t", {
      revision: "a".repeat(40),
      path: "x.ts",
      range: { startLine: 1, endLine: 1 },
      retrievalMethod: "explicit",
    });
    expect(hasCompleteProvenance(p)).toBe(true);
    expect(p.revision).toBeTruthy();
    expect(p.path).toBeTruthy();
    expect(p.range).not.toBeNull();
    expect(p.retrievalMethod).toBeTruthy();
    expect(p.contentHash).toHaveLength(64);
  });

  it("hasCompleteProvenance rejects an inverted range", () => {
    expect(
      hasCompleteProvenance({
        revision: "a".repeat(40),
        path: "x.ts",
        range: { startLine: 5, endLine: 1 },
        retrievalMethod: "search",
        contentHash: "a".repeat(64),
      }),
    ).toBe(false);
  });

  it("hasCompleteProvenance rejects an empty path", () => {
    expect(
      hasCompleteProvenance({
        revision: "a".repeat(40),
        path: "",
        range: { startLine: 1, endLine: 1 },
        retrievalMethod: "search",
        contentHash: "a".repeat(64),
      }),
    ).toBe(false);
  });
});
