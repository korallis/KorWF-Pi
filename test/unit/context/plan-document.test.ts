/**
 * `src/context/plan-document.ts` (issue #38; PLAN §2.7).
 *
 * Acceptance criterion 2: "Retrieval on an empty dir returns plan-document
 * excerpts with provenance `method: plan-doc`." The retrieval-method value
 * itself is the shared `Provenance.retrievalMethod` enum's
 * `"plan_document"`, defined in `src/storage/records.ts` — this test asserts
 * every returned candidate carries exactly that value.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planDocumentCandidates,
  retrieveWithPlanDocumentFallback,
} from "../../../src/context/plan-document.ts";

describe("planDocumentCandidates", () => {
  it("chunks the plan document into candidates with plan_document provenance", () => {
    const text = Array.from({ length: 90 }, (_, i) => `line ${i}`).join("\n");
    const candidates = planDocumentCandidates(text, { path: "spec.md" });
    expect(candidates.length).toBeGreaterThan(1);
    for (const c of candidates) {
      expect(c.provenance.retrievalMethod).toBe("plan_document");
      expect(c.provenance.path).toBe("spec.md");
      expect(c.provenance.contentHash.length).toBe(64);
    }
  });

  it("returns no candidates for blank text", () => {
    expect(planDocumentCandidates("   \n\n  ", { path: "spec.md" })).toEqual([]);
  });

  it("returns at least one candidate for short non-blank text", () => {
    const candidates = planDocumentCandidates("Build a notes CLI.", { path: "spec.md" });
    expect(candidates.length).toBe(1);
    expect(candidates[0]?.provenance.range).toEqual({ startLine: 1, endLine: 1 });
  });

  it("defaults revision to the unversioned placeholder", () => {
    const candidates = planDocumentCandidates("hello", { path: "spec.md" });
    expect(candidates[0]?.provenance.revision).toBe("unversioned");
  });
});

describe("retrieveWithPlanDocumentFallback — acceptance criterion 2", () => {
  it("falls back to plan-document excerpts when the repo is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "korwf-greenfield-"));
    try {
      const result = retrieveWithPlanDocumentFallback(
        "notes",
        { repoRoot: dir },
        { path: "spec.md", text: "Build a notes CLI with add, list, delete commands." },
      );
      expect(result.candidates.length).toBeGreaterThan(0);
      for (const c of result.candidates) {
        expect(c.provenance.retrievalMethod).toBe("plan_document");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
