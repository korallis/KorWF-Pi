/**
 * Types for `check-third-party-notices.mjs`.
 *
 * The checker is plain ESM so it runs with no build step (`npm run check:notices`) and
 * from CI before anything is compiled. #20 extended `tsc --noEmit` to cover `test/`,
 * which made the untyped import an error (TS7016); `@ts-expect-error` cannot suppress
 * that, because the diagnostic is reported at the import rather than at an expression.
 * A declaration file keeps the script dependency-free *and* the test type-checked.
 *
 * Must stay in step with the implementation: it is hand-written, not generated.
 */

/** The `Adapted from pi <version> examples/extensions/<path>` header fields. */
export interface Attribution {
  /** Pi version the code was read from, e.g. `0.86.0`. */
  version: string;
  /** Upstream example path, e.g. `examples/extensions/subagent/agents.ts`. */
  source: string;
}

export interface CheckOptions {
  /** Override the notices file location (tests use a fixture). */
  noticesPath?: string;
  /** Override the ADR 0001 location (tests use a fixture). */
  adrPath?: string;
  /** Explicit file list; defaults to scanning src/, resources/, scripts/. */
  files?: string[];
}

export interface NoticesResult {
  /** Repo-relative path → attribution, for every file carrying a header. */
  attributed: Map<string, Attribution>;
  /** Repo-relative path → attribution, for every row in the notices table. */
  listed: Map<string, Attribution>;
  /** Human-readable problems; empty means the check passes. */
  errors: string[];
}

/** Matches the ADR 0001 attribution header. */
export const HEADER_RE: RegExp;

/** Parse an attribution header from the head of a file; `undefined` when absent. */
export function parseHeader(text: string): Attribution | undefined;

/** Scan the repository and compare headers against THIRD_PARTY_NOTICES.md. */
export function checkNotices(root: string, options?: CheckOptions): NoticesResult;
