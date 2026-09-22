/**
 * Provenance helpers (issue #35; PLAN §3.B "provenance on every excerpt:
 * revision, path, range, retrieval method, content hash").
 *
 * Kept separate from `retrieve.ts` so the hash rule — sha256 over the exact
 * text of the slice, nothing else — is defined once and reused by ranking,
 * pinning and tests alike. A verifier only needs a `Provenance` and the
 * candidate's `text` to prove the excerpt has not been altered.
 *
 * Builds the shared `Provenance` record from `src/storage/records.ts`
 * (PLAN §3.B) rather than a context-local type, so an excerpt's provenance
 * is already the shape `Evidence`/`Decision` rows expect.
 */
import { createHash } from "node:crypto";
import type { Provenance } from "../storage/records.ts";

/** Fallback revision label used outside a git repository, or when git fails. */
export const UNVERSIONED_REVISION = "unversioned";

/** sha256 of an excerpt's exact text. The one hash function provenance uses. */
export function hashSlice(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Build a `Provenance` record; its `contentHash` is computed from `text`. */
export function provenanceOf(
  text: string,
  fields: {
    readonly revision: string;
    readonly path: string;
    readonly range: Provenance["range"];
    readonly retrievalMethod: Provenance["retrievalMethod"];
  },
): Provenance {
  return {
    revision: fields.revision,
    path: fields.path,
    range: fields.range,
    retrievalMethod: fields.retrievalMethod,
    contentHash: hashSlice(text),
  };
}

/** Does `provenance.contentHash` actually match this text's hash? */
export function verifyProvenance(provenance: Provenance, text: string): boolean {
  return provenance.contentHash === hashSlice(text);
}

/** All five mandatory fields present and non-empty (PLAN §3.B). */
export function hasCompleteProvenance(provenance: Provenance): boolean {
  const range = provenance.range;
  return (
    typeof provenance.revision === "string" &&
    provenance.revision.length > 0 &&
    typeof provenance.path === "string" &&
    provenance.path.length > 0 &&
    (range === null || (Number.isInteger(range.startLine) && range.startLine >= 1 && Number.isInteger(range.endLine) && range.endLine >= range.startLine)) &&
    typeof provenance.retrievalMethod === "string" &&
    provenance.retrievalMethod.length > 0 &&
    typeof provenance.contentHash === "string" &&
    provenance.contentHash.length === 64
  );
}
