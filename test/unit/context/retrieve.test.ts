/**
 * AC: "Fixture repo: query for a known feature returns the implementing file
 * in the top 3 with and without Jev" (retrieval half — top-3 without ranking
 * is already true of `retrieveCandidates` alone, since it is the only match).
 * AC: "A `.env` file in the fixture never appears in candidates."
 */
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retrieveCandidates, searchContent, searchFilenames, currentRevision } from "../../../src/context/retrieve.ts";
import { verifyProvenance, hasCompleteProvenance } from "../../../src/context/provenance.ts";
import { buildTestRepo, type TestRepo } from "./support.ts";

/**
 * A PATH containing only `git` (via a symlink), so `rg` genuinely ENOENTs —
 * proves the fallback runs because the binary is absent, not by mocking.
 */
function gitOnlyPath(): { readonly dir: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "korwf-norg-path-"));
  const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  symlinkSync(gitPath, join(dir, "git"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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

  it("retains the original tool output alongside filtered excerpts", () => {
    const { raw } = retrieveCandidates("password", { repoRoot: repo.root });
    expect(raw.length).toBeGreaterThan(0);
    // PLAN §3.B requires the ORIGINAL tool output be retained, not that a
    // particular tool ran. Asserting `tool === "rg"` fails wherever ripgrep is
    // absent (e.g. GitHub runners), which is exactly the fallback this issue
    // added. Assert the invariant instead: whatever ran is named honestly, and
    // its raw output is kept.
    expect(raw.every((r) => r.tool === "rg" || r.tool === "git")).toBe(true);
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

  it("AC: with no rg on PATH, falls back to git grep / git ls-files and still finds candidates", () => {
    const { dir, cleanup } = gitOnlyPath();
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = dir;
      const { candidates, raw } = retrieveCandidates("password hashing", { repoRoot: repo.root });
      const top3 = candidates.slice(0, 3).map((c) => c.provenance.path);
      expect(top3).toContain("src/auth.ts");
      expect(candidates.every((c) => c.searchTool !== "rg")).toBe(true);
      expect(candidates.some((c) => c.searchTool === "git-grep")).toBe(true);
      expect(raw.some((r) => r.tool === "rg" && r.unavailable === true)).toBe(true);
      expect(raw.some((r) => r.tool === "git" && r.args.includes("grep"))).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      cleanup();
    }
  });

  it("AC: with no rg on PATH, .env still never appears in candidates", () => {
    const { dir, cleanup } = gitOnlyPath();
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = dir;
      const { candidates } = retrieveCandidates("SECRET_KEY", { repoRoot: repo.root });
      expect(candidates.some((c) => c.provenance.path.endsWith(".env"))).toBe(false);
    } finally {
      process.env.PATH = originalPath;
      cleanup();
    }
  });
});
