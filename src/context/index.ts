/**
 * Retrieval, ranking, provenance and pinned context (issue #35; PLAN §3.B).
 *
 * Retrieval (`retrieve.ts`) uses ordinary search tools only. Ranking
 * (`rank.ts`) is the one place a bounded candidate set is sent to Jev, via
 * the versioned questions in `src/decisions/questions/context.ts`. Every
 * excerpt carries the shared `Provenance` record. Pins (`pins.ts`) are
 * preserved regardless of ranking.
 */
export type { Candidate, Provenance, RawToolOutput, RetrievalMethod } from "./types.ts";

export {
  hasCompleteProvenance,
  hashSlice,
  provenanceOf,
  UNVERSIONED_REVISION,
  verifyProvenance,
} from "./provenance.ts";

export type { RetrieveOptions, RetrieveResult } from "./retrieve.ts";
export {
  ageDaysOf,
  currentRevision,
  relPath,
  retrieveCandidates,
  searchContent,
  searchFilenames,
} from "./retrieve.ts";

export type { RankedCandidate, RankOptions } from "./rank.ts";
export { combinedScore, DEFAULT_MAX_CANDIDATES, expandShortlist, rankCandidates } from "./rank.ts";

export { allPinsPresent, mergeWithPins, PinDeniedError, pinFile, pinFiles } from "./pins.ts";

export type { ShortlistEntry } from "./artifacts.ts";
export { toShortlistEntry, writeRawToolOutput, writeShortlist } from "./artifacts.ts";
