/**
 * The one outbound policy (issue #28; PLAN §7 "Data policy", §6 "minimal
 * relevant state per evaluation").
 *
 * Everything that leaves this process for TypeSafe or a model provider goes
 * through `OutboundPolicy.filter()` first. In order, per payload:
 *
 *  1. **Minimal state.** Only declared fields survive; snippets are capped in
 *     count (`privacy.outbound.maxSnippetsPerRequest`). Sending the least
 *     state that answers the question is a policy, not a nicety: a smaller
 *     state is cheaper, more accurate, and leaks less.
 *  2. **Default-deny paths.** Any snippet whose path matches the shipped
 *     minimum or the configured `privacy.denyPaths` is dropped whole
 *     (`src/security/deny-list.ts`). The *content* is never inspected first;
 *     a denied path is refused on identity alone.
 *  3. **Redaction.** Every surviving string passes through
 *     `src/security/redact.ts` (#22) — registered literal secrets and
 *     credential shapes alike — plus the configured `privacy.denyPatterns`.
 *     A secret must never reach TypeSafe.
 *  4. **Byte caps.** Per-snippet (`maxSnippetBytes`) and whole-request
 *     (`maxRequestBytes`) limits, per purpose. Truncation leaves a visible
 *     marker and the report says exactly how many bytes were dropped.
 *
 * The result is a `FilteredPayload`: a branded type that only this module can
 * mint. `src/decisions/ask.ts` hands the transport nothing else, so "I forgot
 * to filter" is a type error rather than a leak.
 *
 * Nothing here throws on user data. A filter that threw would tempt callers
 * into a bypass; instead every unusual shape (cycles, getters that throw,
 * BigInt, functions) becomes something inert and is counted in the report.
 */
import type { KorwfConfig, OutboundLimits } from "../config/types.ts";
import { DenyMatcher, type DenyVerdict } from "./deny-list.ts";
import { REDACTED, redactString } from "./redact.ts";

/** What an outbound request is for. Caps and rules are resolved per purpose. */
export type OutboundPurpose = "jev.decision" | "jev.ping" | "model.prompt" | "log.raw";

/** A file excerpt offered for sending. */
export interface Snippet {
  /** Project-relative path. Absolute paths are refused, never rewritten. */
  readonly path: string;
  readonly text: string;
  /** 1-based first line of `text` in the file, when known. */
  readonly startLine?: number;
}

/** The caller's declared minimal state for one outbound request. */
export interface OutboundPayload {
  /** Free-form structured state (question input). Strings are redacted. */
  readonly state?: unknown;
  readonly snippets?: readonly Snippet[];
  /** Paths mentioned without content; still subject to the deny list. */
  readonly paths?: readonly string[];
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

/** Marker left in place of removed bytes. Stable so tests and users can grep it. */
export const TRUNCATION_MARKER = "[truncated]" as const;

/** One thing the filter removed, recorded for the decision trace. */
export interface RemovedItem {
  readonly kind: "path" | "snippet" | "field";
  /** Path or field name, already normalised; never an absolute path. */
  readonly what: string;
  /** `denied` (deny list), `over_budget` (caps), `unsupported` (inert value). */
  readonly reason: "denied" | "over_budget" | "unsupported";
  /** The glob that denied it, when the reason is `denied`. */
  readonly glob: string | null;
  readonly rule: DenyVerdict["rule"];
  /** Bytes of content that did not go out because of this removal. */
  readonly bytes: number;
}

/** One truncation, recorded for the decision trace. */
export interface TruncationItem {
  readonly kind: "snippet" | "request";
  readonly what: string;
  readonly keptBytes: number;
  readonly droppedBytes: number;
}

/**
 * Exactly what the filter did. Safe to log and to store: it carries counts,
 * paths and reasons, never removed content.
 */
export interface OutboundReport {
  readonly purpose: OutboundPurpose;
  readonly removed: readonly RemovedItem[];
  readonly truncated: readonly TruncationItem[];
  /** How many strings the redactor changed. */
  readonly redactedStrings: number;
  /** Bytes of the payload actually sent. */
  readonly sentBytes: number;
  /** Bytes dropped in total, by removal and by truncation. */
  readonly droppedBytes: number;
  /** Snippets that survived, of how many offered. */
  readonly snippetsKept: number;
  readonly snippetsOffered: number;
  /** True when nothing was removed, truncated or redacted. */
  readonly clean: boolean;
}

// ---------------------------------------------------------------------------
// branded result
// ---------------------------------------------------------------------------

declare const filteredBrand: unique symbol;

/**
 * A payload that has been through `OutboundPolicy.filter`. The brand is a
 * declared-only unique symbol, so this type cannot be produced by a cast from
 * a plain object literal and cannot be constructed outside this module: the
 * transport signature alone proves the filter ran.
 */
export interface FilteredPayload {
  readonly [filteredBrand]: true;
  /** Filtered, redacted, capped state. Safe to serialise and send. */
  readonly state: unknown;
  readonly snippets: readonly Snippet[];
  readonly paths: readonly string[];
  readonly report: OutboundReport;
}

// ---------------------------------------------------------------------------
// bytes
// ---------------------------------------------------------------------------

/** UTF-8 byte length. Byte caps are about wire size, not code points. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes *including* the marker, without
 * splitting a multi-byte character. Returns what was kept and how many bytes
 * of original content were dropped (the marker is not counted as content).
 */
export function truncateToBytes(
  text: string,
  maxBytes: number,
  marker: string = TRUNCATION_MARKER,
): { readonly kept: string; readonly droppedBytes: number } {
  const total = byteLength(text);
  if (maxBytes <= 0) return { kept: "", droppedBytes: total };
  if (total <= maxBytes) return { kept: text, droppedBytes: 0 };

  const markerBytes = byteLength(marker);
  // No room for content plus marker: emit as much of the marker as fits, so
  // the fact of truncation still survives.
  if (markerBytes >= maxBytes) {
    const onlyMarker = Buffer.from(marker, "utf8").subarray(0, maxBytes).toString("utf8");
    return { kept: onlyMarker, droppedBytes: total };
  }

  const budget = maxBytes - markerBytes;
  const buffer = Buffer.from(text, "utf8");
  // `toString` on a slice that cuts a character mid-sequence yields U+FFFD;
  // walk back to the start of that character instead.
  let end = budget;
  while (end > 0 && (buffer[end] ?? 0) >= 0x80 && (buffer[end] ?? 0) < 0xc0) end -= 1;
  const kept = buffer.subarray(0, end).toString("utf8");
  return { kept: `${kept}${marker}`, droppedBytes: total - byteLength(kept) };
}

// ---------------------------------------------------------------------------
// content redaction
// ---------------------------------------------------------------------------

/**
 * Compile `privacy.denyPatterns`. A pattern that does not compile is skipped
 * rather than fatal — the shipped patterns and the global redactor still
 * apply, so skipping degrades towards *more* redaction, never less — and the
 * skip is reported through `invalidPatterns`.
 */
export function compileDenyPatterns(
  patterns: readonly string[],
): { readonly compiled: readonly RegExp[]; readonly invalid: readonly string[] } {
  const compiled: RegExp[] = [];
  const invalid: string[] = [];
  for (const source of patterns) {
    try {
      compiled.push(new RegExp(source, "giu"));
    } catch {
      try {
        compiled.push(new RegExp(source, "gi"));
      } catch {
        invalid.push(source);
      }
    }
  }
  return { compiled, invalid };
}
