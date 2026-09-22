/**
 * Retain original tool output alongside filtered excerpts (issue #35;
 * PLAN §3.B "retain original tool output alongside filtered excerpts").
 *
 * Thin wrapper over `src/storage/artifacts.ts` (#23): nothing new is
 * invented here, this just names where retrieval writes. The raw `rg`/`git`
 * output goes in one artifact, the ranked shortlist (with full provenance)
 * in another — both attributable to the same attempt, both content-hashed
 * and verifiable by `ArtifactStore.verify`.
 */
import type { ArtifactStore } from "../storage/artifacts.ts";
import type { ArtifactRef, AttemptId } from "../storage/records.ts";
import type { RankedCandidate } from "./rank.ts";
import type { RawToolOutput } from "./types.ts";

/** Serialised ranked shortlist entry — what actually gets written to disk. */
export interface ShortlistEntry {
  readonly path: string;
  readonly range: { readonly startLine: number; readonly endLine: number } | null;
  readonly revision: string;
  readonly retrievalMethod: string;
  readonly contentHash: string;
  readonly relevance: number;
  readonly staleness: number;
  readonly contradiction: string;
  readonly score: number;
  readonly pinned: boolean;
}

export function toShortlistEntry(ranked: RankedCandidate, pinned = false): ShortlistEntry {
  return {
    path: ranked.candidate.provenance.path,
    range: ranked.candidate.provenance.range,
    revision: ranked.candidate.provenance.revision,
    retrievalMethod: ranked.candidate.provenance.retrievalMethod,
    contentHash: ranked.candidate.provenance.contentHash,
    relevance: ranked.relevance,
    staleness: ranked.staleness,
    contradiction: ranked.contradiction,
    score: ranked.score,
    pinned,
  };
}

/** Write the raw tool output for one retrieval, one file per invocation. */
export function writeRawToolOutput(store: ArtifactStore, attemptId: AttemptId | string, raw: readonly RawToolOutput[]): ArtifactRef[] {
  return raw.map((entry, index) =>
    store.write(
      attemptId,
      `context/raw-${index}-${entry.tool}.json`,
      JSON.stringify(entry, null, 2),
      "application/json",
    ),
  );
}

/** Write the ranked shortlist (with provenance) beside the raw output. */
export function writeShortlist(
  store: ArtifactStore,
  attemptId: AttemptId | string,
  entries: readonly ShortlistEntry[],
): ArtifactRef {
  return store.write(attemptId, "context/shortlist.json", JSON.stringify(entries, null, 2), "application/json");
}
