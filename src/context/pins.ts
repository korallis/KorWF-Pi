/**
 * Pinned context (issue #35; PLAN §3.B "explicit files, required
 * instructions and required skills are preserved regardless of ranking").
 *
 * A pin is a `Candidate` built directly from a file, bypassing search and
 * ranking entirely. `mergeWithPins` guarantees every pinned path survives a
 * ranked shortlist: pins are prepended and any ranked candidate for the same
 * path is dropped in favour of the pin (a pin is authoritative — it names
 * *the whole file as relevant*, not a slice a ranker guessed at).
 */
import { readFileSync } from "node:fs";
import { DenyMatcher } from "../security/deny-list.ts";
import { provenanceOf } from "./provenance.ts";
import type { Candidate, Provenance } from "./types.ts";

export class PinDeniedError extends Error {
  constructor(path: string) {
    super(`cannot pin ${JSON.stringify(path)}: it matches the outbound deny list and can never be sent`);
    this.name = "PinDeniedError";
  }
}

/**
 * Build one pinned candidate from a whole file. Throws `PinDeniedError` for a
 * deny-listed path — pinning cannot override the deny list, since "never
 * weakens its own permission... policy" (AGENTS.md §4) applies to pins too.
 */
export function pinFile(
  repoRoot: string,
  relativePath: string,
  revision: string,
  retrievalMethod: Provenance["retrievalMethod"] = "explicit",
  denyMatcher: DenyMatcher = new DenyMatcher(),
): Candidate {
  if (denyMatcher.denies(relativePath)) throw new PinDeniedError(relativePath);
  const text = readFileSync(`${repoRoot}/${relativePath}`, "utf8");
  const lineCount = text.length === 0 ? 0 : text.split("\n").length;
  return {
    provenance: provenanceOf(text, {
      revision,
      path: relativePath,
      range: { startLine: 1, endLine: Math.max(1, lineCount) },
      retrievalMethod,
    }),
    text,
    matchScore: Number.POSITIVE_INFINITY,
    ageDays: null,
  };
}

/** Pin every path in `paths` with the given retrieval method. Never partial: a deny throws. */
export function pinFiles(
  repoRoot: string,
  paths: readonly string[],
  revision: string,
  retrievalMethod: Provenance["retrievalMethod"],
  denyMatcher?: DenyMatcher,
): Candidate[] {
  return paths.map((p) => pinFile(repoRoot, p, revision, retrievalMethod, denyMatcher));
}

/**
 * Merge pinned candidates with a ranked shortlist. Pins always survive:
 * they are placed first, and a ranked candidate whose path collides with a
 * pin is dropped (the pin's whole-file provenance supersedes it).
 */
export function mergeWithPins(pinned: readonly Candidate[], ranked: readonly Candidate[]): Candidate[] {
  const pinnedPaths = new Set(pinned.map((c) => c.provenance.path));
  return [...pinned, ...ranked.filter((c) => !pinnedPaths.has(c.provenance.path))];
}

/** True when every pinned path is present in `candidates` (test/assertion helper). */
export function allPinsPresent(pinned: readonly Candidate[], candidates: readonly Candidate[]): boolean {
  const present = new Set(candidates.map((c) => c.provenance.path));
  return pinned.every((p) => present.has(p.provenance.path));
}
