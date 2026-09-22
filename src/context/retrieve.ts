/**
 * Candidate retrieval (issue #35; PLAN §3.B).
 *
 * "Retrieve candidates with ordinary search and symbol/dependency tools; Jev
 * ranks bounded candidates, it does not retrieve." This module is the
 * retrieval half: it shells out to `rg` (content search) and `git`
 * (filename/dependency search, revision, recency) and never calls Jev.
 * `src/context/rank.ts` is the only place that asks a Jev question, and only
 * over what this module already found.
 *
 * A `.env` (or any shipped-deny path) never reaches a `Candidate`: every hit
 * is checked against `DenyMatcher` before its content is read, so the deny
 * list is enforced at the source, not only at the outbound boundary later.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { DenyMatcher } from "../security/deny-list.ts";
import { provenanceOf, UNVERSIONED_REVISION } from "./provenance.ts";
import type { Candidate, RawToolOutput, SearchTool } from "./types.ts";

export interface RetrieveOptions {
  /** Project root the query runs from; also the base for relative paths. */
  readonly repoRoot: string;
  /** Lines of context kept on each side of a content match. */
  readonly contextLines?: number;
  /** Extra deny matcher (project config); shipped minimum always applies. */
  readonly denyMatcher?: DenyMatcher;
}

export interface RetrieveResult {
  readonly candidates: readonly Candidate[];
  /** Original tool output, retained alongside the filtered excerpts (PLAN §3.B). */
  readonly raw: readonly RawToolOutput[];
}

function run(tool: "rg" | "git", args: readonly string[], cwd: string): RawToolOutput {
  try {
    const stdout = execFileSync(tool, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { tool, args, stdout, exitCode: 0 };
  } catch (error) {
    const err = error as { stdout?: string; status?: number | null; code?: string };
    if (err.code === "ENOENT") {
      return { tool, args, stdout: "", exitCode: 1, unavailable: true };
    }
    return { tool, args, stdout: err.stdout ?? "", exitCode: err.status ?? 1 };
  }
}

/** Current HEAD sha, or `UNVERSIONED_REVISION` outside a repo / on failure. */
export function currentRevision(repoRoot: string): string {
  const out = run("git", ["rev-parse", "HEAD"], repoRoot);
  const sha = out.stdout.trim();
  return out.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : UNVERSIONED_REVISION;
}

/** Days since the file's last commit; `null` if unknown (not tracked, no repo). */
export function ageDaysOf(repoRoot: string, relPath: string, nowMs: () => number = Date.now): number | null {
  const out = run("git", ["log", "-1", "--format=%ct", "--", relPath], repoRoot);
  const line = out.stdout.trim().split("\n")[0] ?? "";
  if (out.exitCode !== 0 || !/^\d+$/.test(line)) return null;
  const committedMs = Number(line) * 1000;
  return Math.max(0, (nowMs() - committedMs) / 86_400_000);
}

interface RgMatch {
  readonly path: string;
  readonly lineNumber: number;
}

/** Parse `rg --json` output into one entry per matched line. */
function parseRgJson(stdout: string): RgMatch[] {
  const out: RgMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const rec = event as Record<string, unknown>;
    if (rec["type"] !== "match") continue;
    const data = rec["data"] as Record<string, unknown> | undefined;
    const pathObj = data?.["path"] as Record<string, unknown> | undefined;
    const path = pathObj?.["text"];
    const lineNumber = data?.["line_number"];
    if (typeof path === "string" && typeof lineNumber === "number") {
      out.push({ path: stripLeadingDotSlash(path), lineNumber });
    }
  }
  return out;
}

/**
 * Parse `git grep -n --no-color` output (`path:lineNumber:text`) into the
 * same shape `parseRgJson` produces. `git grep` respects `.gitignore` the
 * same way `git ls-files` does, so it needs no separate exclude logic.
 */
function parseGitGrep(stdout: string): RgMatch[] {
  const out: RgMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const first = line.indexOf(":");
    if (first < 0) continue;
    const second = line.indexOf(":", first + 1);
    if (second < 0) continue;
    const path = line.slice(0, first);
    const lineNumber = Number(line.slice(first + 1, second));
    if (path.length > 0 && Number.isInteger(lineNumber) && lineNumber > 0) {
      out.push({ path: stripLeadingDotSlash(path), lineNumber });
    }
  }
  return out;
}

/** rg emits `./x` for the current directory; normalise to a plain relative path. */
function stripLeadingDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

function readSliceLines(absPath: string, startLine: number, endLine: number): string | null {
  try {
    const lines = readFileSync(absPath, "utf8").split("\n");
    return lines.slice(startLine - 1, endLine).join("\n");
  } catch {
    return null;
  }
}

/**
 * Content search: `rg --json -n -i` for `query`, grouped by file, with
 * `contextLines` of context kept on each side of every match. When `rg` is
 * not installed (`unavailable`), falls back to `git grep -n -I -i --untracked`
 * — already a dependency since this module shells out to `git` for revision
 * and recency, and it respects `.gitignore` the same way `git ls-files` does.
 * Whichever binary actually produced a match is recorded on the candidate
 * (`searchTool`) so provenance never claims an `rg` search that never ran.
 * Files denied by `DenyMatcher` are dropped before their content is ever read.
 */
export function searchContent(query: string, options: RetrieveOptions): RetrieveResult {
  const { repoRoot, contextLines = 3 } = options;
  const matcher = options.denyMatcher ?? new DenyMatcher();
  const raw: RawToolOutput[] = [];

  const rgOut = run("rg", ["--json", "-n", "-i", "-e", query, "."], repoRoot);
  raw.push(rgOut);
  let matches: RgMatch[];
  let searchTool: SearchTool;
  if (rgOut.unavailable === true) {
    const gitOut = run("git", ["grep", "-n", "-I", "-i", "--untracked", "--no-color", "-e", query], repoRoot);
    raw.push(gitOut);
    matches = parseGitGrep(gitOut.stdout);
    searchTool = "git-grep";
  } else {
    matches = parseRgJson(rgOut.stdout);
    searchTool = "rg";
  }

  const byFile = new Map<string, number[]>();
  for (const m of matches) {
    const existing = byFile.get(m.path);
    if (existing === undefined) byFile.set(m.path, [m.lineNumber]);
    else existing.push(m.lineNumber);
  }

  const revision = currentRevision(repoRoot);
  const candidates: Candidate[] = [];
  for (const [relPath, lineNumbers] of byFile) {
    if (matcher.denies(relPath)) continue;
    const startLine = Math.max(1, Math.min(...lineNumbers) - contextLines);
    const endLine = Math.max(...lineNumbers) + contextLines;
    const text = readSliceLines(`${repoRoot}/${relPath}`, startLine, endLine);
    if (text === null) continue;
    candidates.push({
      provenance: provenanceOf(text, { revision, path: relPath, range: { startLine, endLine }, retrievalMethod: "search" }),
      text,
      matchScore: lineNumbers.length,
      ageDays: ageDaysOf(repoRoot, relPath),
      searchTool,
    });
  }

  return { candidates, raw };
}

/**
 * Filename search: `rg --files`, then a case-insensitive substring match on
 * the basename/path against `query`. When `rg` is unavailable, falls back to
 * `git ls-files --cached --others --exclude-standard`, which enumerates the
 * same tracked-plus-untracked-but-not-ignored set `rg --files` would.
 */
export function searchFilenames(query: string, options: RetrieveOptions): RetrieveResult {
  const { repoRoot } = options;
  const matcher = options.denyMatcher ?? new DenyMatcher();
  const raw: RawToolOutput[] = [];

  const rgOut = run("rg", ["--files", "."], repoRoot);
  raw.push(rgOut);
  let listing: string;
  let searchTool: SearchTool;
  if (rgOut.unavailable === true) {
    const gitOut = run("git", ["ls-files", "--cached", "--others", "--exclude-standard"], repoRoot);
    raw.push(gitOut);
    listing = gitOut.stdout;
    searchTool = "git-ls-files";
  } else {
    listing = rgOut.stdout;
    searchTool = "rg";
  }

  const needle = query.toLowerCase();
  const revision = currentRevision(repoRoot);

  const candidates: Candidate[] = [];
  for (const rawPath of listing.split("\n")) {
    if (rawPath.length === 0) continue;
    const relPath = stripLeadingDotSlash(rawPath);
    if (!relPath.toLowerCase().includes(needle)) continue;
    if (matcher.denies(relPath)) continue;
    const text = readSliceLines(`${repoRoot}/${relPath}`, 1, 200);
    if (text === null) continue;
    const lineCount = text.length === 0 ? 0 : text.split("\n").length;
    candidates.push({
      provenance: provenanceOf(text, {
        revision,
        path: relPath,
        range: { startLine: 1, endLine: Math.max(1, lineCount) },
        retrievalMethod: "search",
      }),
      text,
      matchScore: 0.5,
      ageDays: ageDaysOf(repoRoot, relPath),
      searchTool,
    });
  }

  return { candidates, raw };
}

/** Combine content and filename candidates for one query, deduping by path. */
export function retrieveCandidates(query: string, options: RetrieveOptions): RetrieveResult {
  const content = searchContent(query, options);
  const filenames = searchFilenames(query, options);

  const seen = new Set(content.candidates.map((c) => c.provenance.path));
  const merged = [...content.candidates, ...filenames.candidates.filter((c) => !seen.has(c.provenance.path))];

  return { candidates: merged, raw: [...content.raw, ...filenames.raw] };
}

/** Project-relative, forward-slash path for a path under `repoRoot`. */
export function relPath(repoRoot: string, absPath: string): string {
  return relative(repoRoot, absPath).split("\\").join("/");
}
