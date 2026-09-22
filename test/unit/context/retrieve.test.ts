/**
 * AC: "Fixture repo: query for a known feature returns the implementing file
 * in the top 3 with and without Jev" (retrieval half — top-3 without ranking
 * is already true of `retrieveCandidates` alone, since it is the only match).
 * AC: "A `.env` file in the fixture never appears in candidates."
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retrieveCandidates, searchContent, searchFilenames, currentRevision } from "../../../src/context/retrieve.ts";
import { verifyProvenance, hasCompleteProvenance } from "../../../src/context/provenance.ts";
import { buildTestRepo, type TestRepo } from "./support.ts";

describe("retrieveCandidates", () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = buildTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("AC: query for a known feature returns the implementing file in the top 3", () => {
    const { candidates } = retrieveCandidates("password hashing", { repoRoot: repo.root });
    const top3 = candidates.slice(0, 3).map((c) => c.provenance.path);
    expect(top3).toContain("src/auth.ts");
  });

  it("AC: a .env file in the fixture never appears in candidates", () => {
    const { candidates } = retrieveCandidates("SECRET_KEY", { repoRoot: repo.root });
    expect(candidates.some((c) => c.provenance.path.endsWith(".env"))).toBe(false);
  });

  it("filename search also excludes .env", () => {
    const { candidates } = searchFilenames(".env", { repoRoot: repo.root });
    expect(candidates).toHaveLength(0);
  });

  it("every candidate has complete, verifiable provenance", () => {
    const { candidates } = retrieveCandidates("password", { repoRoot: repo.root });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(hasCompleteProvenance(c.provenance)).toBe(true);
      expect(verifyProvenance(c.provenance, c.text)).toBe(true);
      expect(c.provenance.revision).toBe(repo.revision);
    }
  });

  it("retains original rg output alongside filtered excerpts", () => {
    const { raw } = retrieveCandidates("password", { repoRoot: repo.root });
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((r) => r.tool === "rg")).toBe(true);
    expect(raw.some((r) => r.stdout.length > 0)).toBe(true);
  });

  it("searchContent alone finds the file by content", () => {
    const { candidates } = searchContent("verifyPassword", { repoRoot: repo.root });
    expect(candidates.map((c) => c.provenance.path)).toContain("src/auth.ts");
  });

  it("currentRevision returns the repo HEAD sha", () => {
    expect(currentRevision(repo.root)).toBe(repo.revision);
  });

  it("currentRevision falls back outside a repo", () => {
    const bare = mkdtempSync(join(tmpdir(), "korwf-norepo-"));
    try {
      expect(currentRevision(bare)).toBe("unversioned");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
