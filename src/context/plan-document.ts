/**
 * Plan-document retrieval fallback (issue #38; PLAN §2.7).
 *
 * "... treat the plan document itself as the retrieval context until code
 * exists." When ordinary search (`retrieveCandidates`) finds nothing — the
 * greenfield case, where no code exists yet to search — retrieval falls back
 * to excerpts of the plan/spec document itself, each carrying `Provenance`
 * with `retrievalMethod: "plan_document"` so a later planning decision can
 * tell an excerpt came from the document rather than the repository.
 *
 * Pure and dependency-free beyond `retrieve.ts`: no new git or shell calls.
 */
import { provenanceOf, UNVERSIONED_REVISION } from "./provenance.ts";
import type { Candidate } from "./types.ts";
import { retrieveCandidates, type RetrieveOptions, type RetrieveResult } from "./retrieve.ts";

/** Chunk size, in lines, used to split the plan document into excerpts. */
export const PLAN_DOCUMENT_CHUNK_LINES = 40;

export interface PlanDocumentOptions {
  /** Repository-relative path the excerpts are attributed to (e.g. "spec.md"). */
  readonly path: string;
  /** Revision label; defaults to the unversioned placeholder (no commit exists yet). */
  readonly revision?: string;
}

/**
 * Chunk `text` into `Candidate`s with `retrievalMethod: "plan_document"`
 * provenance. Blank text yields no candidates; any non-blank text yields at
 * least one, even if shorter than one chunk.
 */
export function planDocumentCandidates(text: string, options: PlanDocumentOptions): Candidate[] {
  if (text.trim().length === 0) return [];
  const revision = options.revision ?? UNVERSIONED_REVISION;
  const lines = text.split("\n");
  const candidates: Candidate[] = [];
  for (let start = 0; start < lines.length; start += PLAN_DOCUMENT_CHUNK_LINES) {
    const end = Math.min(lines.length, start + PLAN_DOCUMENT_CHUNK_LINES);
    const slice = lines.slice(start, end).join("\n");
    if (slice.trim().length === 0) continue;
    candidates.push({
      provenance: provenanceOf(slice, {
        revision,
        path: options.path,
        range: { startLine: start + 1, endLine: end },
        retrievalMethod: "plan_document",
      }),
      text: slice,
      matchScore: 1,
      ageDays: null,
    });
  }
  return candidates;
}

/**
 * Ordinary retrieval, falling back to the plan document when it finds
 * nothing — the greenfield state where no code exists to search (PLAN §2.7).
 * The fallback never runs when ordinary search found something.
 */
export function retrieveWithPlanDocumentFallback(
  query: string,
  retrieveOptions: RetrieveOptions,
  planDocument: PlanDocumentOptions & { readonly text: string },
): RetrieveResult {
  const result = retrieveCandidates(query, retrieveOptions);
  if (result.candidates.length > 0) return result;
  return { candidates: planDocumentCandidates(planDocument.text, planDocument), raw: result.raw };
}
