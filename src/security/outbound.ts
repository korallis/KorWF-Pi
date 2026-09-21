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
import { defaultConfig } from "../config/load.ts";
import type { KorwfConfig, OutboundLimits } from "../config/types.ts";
import type { SystemOneRequest } from "../jev/transport.ts";
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

// ---------------------------------------------------------------------------
// the policy
// ---------------------------------------------------------------------------

export interface OutboundPolicyOptions {
  /** Per-purpose override of the whole-request cap, in bytes. */
  readonly maxRequestBytesByPurpose?: Partial<Record<OutboundPurpose, number>>;
  /** Maximum object depth walked when redacting state. Deeper is dropped. */
  readonly maxDepth?: number;
}

export interface FilterOptions {
  readonly purpose: OutboundPurpose;
}

/** Mutable accumulator threaded through one `filter()` call. */
interface Accumulator {
  readonly removed: RemovedItem[];
  readonly truncated: TruncationItem[];
  redactedStrings: number;
}

/**
 * The enforcement point for `privacy` (PLAN §7). Construct it once from the
 * effective config and share it: it holds only compiled patterns and caps,
 * never data.
 */
export class OutboundPolicy {
  readonly #matcher: DenyMatcher;
  readonly #patterns: readonly RegExp[];
  readonly #invalidPatterns: readonly string[];
  readonly #limits: OutboundLimits;
  readonly #perPurpose: Partial<Record<OutboundPurpose, number>>;
  readonly #maxDepth: number;

  constructor(config: KorwfConfig, options: OutboundPolicyOptions = {}) {
    const privacy = config.privacy;
    this.#matcher = new DenyMatcher({
      denyPaths: privacy.denyPaths,
      allowPaths: privacy.allowPaths,
    });
    const { compiled, invalid } = compileDenyPatterns(privacy.denyPatterns);
    this.#patterns = compiled;
    this.#invalidPatterns = invalid;
    this.#limits = privacy.outbound;
    this.#perPurpose = options.maxRequestBytesByPurpose ?? {};
    this.#maxDepth = Math.max(1, options.maxDepth ?? 12);
  }

  /** Deny patterns in config that could not be compiled (diagnostics only). */
  get invalidPatterns(): readonly string[] {
    return this.#invalidPatterns;
  }

  get limits(): OutboundLimits {
    return this.#limits;
  }

  /** Whole-request cap for a purpose, falling back to the config default. */
  maxRequestBytes(purpose: OutboundPurpose): number {
    const override = this.#perPurpose[purpose];
    return override === undefined ? this.#limits.maxRequestBytes : override;
  }

  /** Would this path's content be refused? Exposed for callers that read files. */
  denies(path: string): boolean {
    return this.#matcher.denies(path);
  }

  /** Redact one string with the global redactor plus configured deny patterns. */
  redact(text: string): string {
    let out = redactString(text);
    for (const pattern of this.#patterns) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, REDACTED);
    }
    return out;
  }

  /**
   * Walk the caller's state, redacting strings and dropping anything that
   * cannot be sent safely: values below a denied key name, paths that the
   * deny list refuses, cycles, functions, symbols and BigInt. Depth beyond
   * `maxDepth` is dropped rather than flattened.
   */
  #filterState(value: unknown, acc: Accumulator, path: string, depth: number, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined) return value === undefined ? undefined : null;

    const type = typeof value;
    if (type === "string") {
      const text = value as string;
      const redacted = this.redact(text);
      if (redacted !== text) acc.redactedStrings += 1;
      return redacted;
    }
    if (type === "number" || type === "boolean") return value;
    if (type === "bigint" || type === "function" || type === "symbol") {
      acc.removed.push({ kind: "field", what: path, reason: "unsupported", glob: null, rule: null, bytes: 0 });
      return undefined;
    }

    if (depth > this.#maxDepth) {
      acc.removed.push({ kind: "field", what: path, reason: "over_budget", glob: null, rule: null, bytes: 0 });
      return undefined;
    }

    const object = value as object;
    if (seen.has(object)) {
      acc.removed.push({ kind: "field", what: path, reason: "unsupported", glob: null, rule: null, bytes: 0 });
      return undefined;
    }
    seen.add(object);

    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const [index, entry] of value.entries()) {
        const filtered = this.#filterState(entry, acc, `${path}[${index}]`, depth + 1, seen);
        if (filtered !== undefined) out.push(filtered);
      }
      seen.delete(object);
      return out;
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const child = path === "" ? key : `${path}.${key}`;
      // A getter that throws must not take the whole request down, and it
      // must not be silently sent either: drop it and say so in the report.
      let entry: unknown;
      try {
        entry = (value as Record<string, unknown>)[key];
      } catch {
        acc.removed.push({ kind: "field", what: child, reason: "unsupported", glob: null, rule: null, bytes: 0 });
        continue;
      }
      // A key whose *name* declares a path gets the deny list applied to its
      // value, so `{ file: "a/.env" }` cannot smuggle one in.
      if (typeof entry === "string" && isPathKey(key)) {
        const verdict = this.#matcher.verdict(entry);
        if (verdict.denied) {
          acc.removed.push({
            kind: "field",
            what: child,
            reason: "denied",
            glob: verdict.glob,
            rule: verdict.rule,
            bytes: byteLength(entry),
          });
          continue;
        }
      }
      const filtered = this.#filterState(entry, acc, child, depth + 1, seen);
      if (filtered !== undefined) out[key] = filtered;
    }
    seen.delete(object);
    return out;
  }

  /** Filter snippets: deny list, count cap, redaction, per-snippet byte cap. */
  #filterSnippets(snippets: readonly Snippet[], acc: Accumulator): Snippet[] {
    const kept: Snippet[] = [];
    for (const snippet of snippets) {
      const raw = typeof snippet.text === "string" ? snippet.text : "";
      const verdict = this.#matcher.verdict(snippet.path ?? "");
      if (verdict.denied) {
        acc.removed.push({
          kind: "snippet",
          what: verdict.normalised,
          reason: "denied",
          glob: verdict.glob,
          rule: verdict.rule,
          bytes: byteLength(raw),
        });
        continue;
      }
      if (kept.length >= this.#limits.maxSnippetsPerRequest) {
        acc.removed.push({
          kind: "snippet",
          what: verdict.normalised,
          reason: "over_budget",
          glob: null,
          rule: null,
          bytes: byteLength(raw),
        });
        continue;
      }

      const redacted = this.redact(raw);
      if (redacted !== raw) acc.redactedStrings += 1;

      const { kept: text, droppedBytes } = truncateToBytes(redacted, this.#limits.maxSnippetBytes);
      if (droppedBytes > 0) {
        acc.truncated.push({ kind: "snippet", what: verdict.normalised, keptBytes: byteLength(text), droppedBytes });
      }
      kept.push({
        // `sendFilePaths: false` means the path never leaves this process; the
        // snippet still goes, identified only by position.
        path: this.#limits.sendFilePaths ? verdict.normalised : "",
        text,
        ...(snippet.startLine !== undefined ? { startLine: snippet.startLine } : {}),
      });
    }
    return kept;
  }

  /** Filter bare paths: deny list, then redaction of the path string itself. */
  #filterPaths(paths: readonly string[], acc: Accumulator): string[] {
    if (!this.#limits.sendFilePaths) {
      for (const path of paths) {
        acc.removed.push({ kind: "path", what: "", reason: "denied", glob: null, rule: "config", bytes: byteLength(path) });
      }
      return [];
    }
    const kept: string[] = [];
    for (const path of paths) {
      const verdict = this.#matcher.verdict(path ?? "");
      if (verdict.denied) {
        acc.removed.push({
          kind: "path",
          what: verdict.normalised,
          reason: "denied",
          glob: verdict.glob,
          rule: verdict.rule,
          bytes: byteLength(path),
        });
        continue;
      }
      kept.push(verdict.normalised);
    }
    return kept;
  }

  /**
   * The only way to produce a `FilteredPayload`. Never throws on caller data.
   *
   * Order matters and is fixed: deny paths first (identity), then redact
   * (content), then cap (size). Redacting before capping means a truncated
   * snippet cannot end mid-secret, and capping last means the request cap is
   * measured on exactly what will be sent.
   */
  filter(payload: OutboundPayload, options: FilterOptions): FilteredPayload {
    const acc: Accumulator = { removed: [], truncated: [], redactedStrings: 0 };
    const offered = payload.snippets ?? [];

    const state = this.#filterState(payload.state, acc, "", 0, new WeakSet<object>()) ?? null;
    let snippets = this.#filterSnippets(offered, acc);
    const paths = this.#filterPaths(payload.paths ?? [], acc);

    // Whole-request cap, measured on the serialised form actually sent. Drop
    // whole snippets from the end first (a partial snippet is worth less than
    // a complete one), then truncate the last survivor if still over.
    const cap = this.maxRequestBytes(options.purpose);
    const sizeOf = (list: readonly Snippet[]): number => byteLength(serialise(state, list, paths));

    while (snippets.length > 0 && sizeOf(snippets) > cap) {
      const dropped = snippets[snippets.length - 1] as Snippet;
      snippets = snippets.slice(0, -1);
      acc.removed.push({
        kind: "snippet",
        what: dropped.path,
        reason: "over_budget",
        glob: null,
        rule: null,
        bytes: byteLength(dropped.text),
      });
    }

    let sentBytes = sizeOf(snippets);
    if (sentBytes > cap) {
      // Nothing left to drop but the state itself is over budget: truncate the
      // serialised state rather than send something oversized.
      const serialisedState = typeof state === "string" ? state : JSON.stringify(state) ?? "";
      const { kept, droppedBytes } = truncateToBytes(serialisedState, Math.max(0, cap));
      acc.truncated.push({ kind: "request", what: options.purpose, keptBytes: byteLength(kept), droppedBytes });
      const truncatedState: unknown = kept;
      sentBytes = byteLength(serialise(truncatedState, snippets, paths));
      return finalise(truncatedState, snippets, paths, acc, options.purpose, sentBytes, offered.length);
    }

    return finalise(state, snippets, paths, acc, options.purpose, sentBytes, offered.length);
  }

  /**
   * Filter a whole Jev request. The state is filtered exactly as in
   * `filter()`; the question bodies are redacted but never dropped, because
   * they are *our* prompt text, not repository content — losing a question
   * would silently change the meaning of the answer, while a secret that
   * somehow reached a prompt must still be removed.
   */
  filterRequest(request: SystemOneRequest, purpose: OutboundPurpose = "jev.decision"): FilteredRequest {
    const filtered = this.filter({ state: request.state }, { purpose });
    const acc: Accumulator = {
      removed: [...filtered.report.removed],
      truncated: [...filtered.report.truncated],
      redactedStrings: filtered.report.redactedStrings,
    };
    const questions = this.#filterState(request.questions, acc, "questions", 0, new WeakSet<object>()) as
      | SystemOneRequest["questions"]
      | undefined;

    const out = {
      state: (filtered.state ?? "") as SystemOneRequest["state"],
      model: request.model,
      questions: questions ?? {},
    };
    const sentBytes = byteLength(JSON.stringify(out) ?? "");
    const report: OutboundReport = Object.freeze({
      purpose,
      removed: Object.freeze([...acc.removed]),
      truncated: Object.freeze([...acc.truncated]),
      redactedStrings: acc.redactedStrings,
      sentBytes,
      droppedBytes: filtered.report.droppedBytes,
      snippetsKept: 0,
      snippetsOffered: 0,
      clean: acc.removed.length === 0 && acc.truncated.length === 0 && acc.redactedStrings === 0,
    });
    const frozen = Object.freeze(out);
    requestReports.set(frozen, report);
    return frozen as unknown as FilteredRequest;
  }
}

/** Exactly what goes on the wire, for measuring. */
function serialise(state: unknown, snippets: readonly Snippet[], paths: readonly string[]): string {
  return JSON.stringify({ state, snippets, paths }) ?? "";
}

function finalise(
  state: unknown,
  snippets: readonly Snippet[],
  paths: readonly string[],
  acc: Accumulator,
  purpose: OutboundPurpose,
  sentBytes: number,
  snippetsOffered: number,
): FilteredPayload {
  const droppedBytes =
    acc.removed.reduce((sum, item) => sum + item.bytes, 0) +
    acc.truncated.reduce((sum, item) => sum + item.droppedBytes, 0);
  const report: OutboundReport = Object.freeze({
    purpose,
    removed: Object.freeze([...acc.removed]),
    truncated: Object.freeze([...acc.truncated]),
    redactedStrings: acc.redactedStrings,
    sentBytes,
    droppedBytes,
    snippetsKept: snippets.length,
    snippetsOffered,
    clean: acc.removed.length === 0 && acc.truncated.length === 0 && acc.redactedStrings === 0,
  });
  // The brand exists only in the type system; at runtime this is plain data.
  return Object.freeze({ state, snippets: Object.freeze([...snippets]), paths: Object.freeze([...paths]), report }) as unknown as FilteredPayload;
}

// ---------------------------------------------------------------------------
// filtered requests: the type the transport accepts
// ---------------------------------------------------------------------------

/**
 * A `SystemOneRequest` that has been through `OutboundPolicy.filterRequest`.
 *
 * `JevTransport.evaluate` accepts nothing else, so an unfiltered request is a
 * compile error rather than a leak. The brand is erased at runtime: the object
 * has exactly `state`, `model` and `questions`, so what is serialised onto the
 * wire is unchanged (the report lives beside it, in a `WeakMap`, and is read
 * with `outboundReportOf`).
 */
export type FilteredRequest = SystemOneRequest & { readonly [filteredBrand]: true };

const requestReports = new WeakMap<object, OutboundReport>();

/** The report for a filtered request, or `undefined` if it was not recorded. */
export function outboundReportOf(request: FilteredRequest): OutboundReport | undefined {
  return requestReports.get(request as unknown as object);
}

/**
 * A policy built from the shipped defaults. Used where no project config is
 * in scope (probes, `ping`, tests); it is the *strictest* configuration,
 * since config can only add deny entries, never remove them.
 */
export function defaultOutboundPolicy(): OutboundPolicy {
  return new OutboundPolicy(defaultConfig());
}

/** Key names whose string value is a path and must face the deny list. */
function isPathKey(key: string): boolean {
  const k = key.toLowerCase();
  return k === "path" || k === "file" || k === "filename" || k === "filepath" || k.endsWith("path") || k.endsWith("file");
}
