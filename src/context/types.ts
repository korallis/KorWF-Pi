/**
 * Shared types for context retrieval and ranking (issue #35; PLAN §3.B).
 *
 * A `Candidate` is one excerpt produced by ordinary search tools (ripgrep,
 * git, filename/dependency search) — never by Jev, which only ranks a
 * bounded set of these. Every candidate carries the shared `Provenance`
 * record from `src/storage/records.ts` (PLAN §3.B: "revision, path, range,
 * retrieval method, content hash") — reused, not redefined, so the same
 * shape works whether the excerpt ends up on a `Decision`, an `Evidence`
 * row, or a memory entry (#36, #44) as it does here.
 */
import type { Provenance } from "../storage/records.ts";

export type { Provenance };

/** How a candidate was found. Values from `Provenance.retrievalMethod`. */
export type RetrievalMethod = Provenance["retrievalMethod"];

/** One retrieved excerpt, plus enough signal to rank it without Jev. */
export interface Candidate {
  readonly provenance: Provenance;
  readonly text: string;
  /** Ordinary-search signal (match count/quality); 0 for filename-only hits. */
  readonly matchScore: number;
  /** Days since the file's last commit (or mtime outside a repo); `null` if unknown. */
  readonly ageDays: number | null;
}

/** Raw stdout of one search-tool invocation, retained for audit (PLAN §3.B). */
export interface RawToolOutput {
  readonly tool: "rg" | "git";
  readonly args: readonly string[];
  readonly stdout: string;
  readonly exitCode: number;
  /** True when the tool binary itself could not be found (ENOENT), not when it ran and found nothing. */
  readonly unavailable?: true;
}
