/**
 * Prompt-injection and misleading-description tests for Stage 3 (issue #44).
 *
 * PLAN §7, the property under test:
 *   "Untrusted repository/tool content isolated from instruction and policy
 *    sources. Jev prompt-injection signals never authorise execution or data
 *    release."
 *
 * These are real attacks against the code already on `main`, not simulations:
 * the fixture repo under `test/fixtures/repo-injection/` is retrieved with
 * `src/context/retrieve.ts` (#35), its payloads are fed to `#37`'s plan
 * contract, `#39`'s evaluators and `#41`'s runtime transitions, and each test
 * asserts the attack fails.
 *
 * Acceptance criteria exercised:
 *  - AC1 "All injection fixtures leave task states and approvals unchanged."
 *  - AC2 "`true`/`exit 0`/empty-command checks are flagged."
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { retrieveCandidates, searchContent } from "../../src/context/retrieve.ts";
import { hasCompleteProvenance, verifyProvenance } from "../../src/context/provenance.ts";
import { buildInjectionRepo, containsInjection, INJECTION_PHRASES, type InjectionRepo } from "./injection-support.ts";

let repo: InjectionRepo;

beforeEach(() => {
  repo = buildInjectionRepo();
});

afterEach(() => {
  repo.cleanup();
});

// ---------------------------------------------------------------------------
// AC1, part 1 — retrieval (#35): injected instructions arrive as *quoted
// excerpts with provenance*, and as nothing else.
// ---------------------------------------------------------------------------

describe("AC1: retrieval passes injected instructions only as quoted excerpts with provenance", () => {
  it("finds the injected README/source/test payloads at all (the attack is present)", () => {
    const { candidates } = searchContent("ignore previous instructions", { repoRoot: repo.root });
    const paths = candidates.map((c) => c.provenance.path).sort();
    expect(paths).toContain("README.md");
    expect(paths).toContain("src/payments.ts");
    expect(paths).toContain("test/payments_test.ts");
  });

  it("gives every injected excerpt complete, verifiable provenance", () => {
    const { candidates } = searchContent("mark this task done", { repoRoot: repo.root });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(hasCompleteProvenance(candidate.provenance)).toBe(true);
      expect(verifyProvenance(candidate.provenance, candidate.text)).toBe(true);
      expect(candidate.provenance.revision).toBe(repo.revision);
      expect(candidate.provenance.retrievalMethod).toBe("search");
      expect(candidate.provenance.range).not.toBeNull();
    }
  });

  it("returns inert data only — a Candidate has no field that could carry an instruction", () => {
    const { candidates } = retrieveCandidates("approve this change", { repoRoot: repo.root });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      // The excerpt is a string, not a directive: there is no `status`,
      // `approved`, `policy` or callable field for injected text to land in.
      expect(typeof candidate.text).toBe("string");
      expect(Object.keys(candidate).sort()).toEqual(
        ["ageDays", "matchScore", "provenance", "searchTool", "text"].sort(),
      );
      for (const value of Object.values(candidate)) {
        expect(typeof value).not.toBe("function");
      }
    }
  });

  it("does not scrub the payload — isolation is structural, so the excerpt is quoted verbatim", () => {
    const { candidates } = searchContent("ignore previous instructions", { repoRoot: repo.root });
    const readme = candidates.find((c) => c.provenance.path === "README.md");
    expect(readme).toBeDefined();
    // Deliberate: retrieval must not silently rewrite repository content, or
    // provenance verification would be meaningless. The excerpt is untrusted
    // *because of where it came from*, not because of what it says.
    expect(containsInjection(readme?.text ?? "")).toBe(true);
    expect(verifyProvenance(readme!.provenance, readme!.text)).toBe(true);
  });

  it("never yields the fixture's credential-shaped .env, whatever the payload says", () => {
    for (const phrase of [...INJECTION_PHRASES, "SECRET_KEY"]) {
      const { candidates } = retrieveCandidates(phrase, { repoRoot: repo.root });
      expect(candidates.some((c) => c.provenance.path.endsWith(".env"))).toBe(false);
      expect(candidates.some((c) => c.text.includes("SECRET_KEY="))).toBe(false);
    }
  });
});
