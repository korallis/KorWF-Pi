/**
 * Raw-payload logging and retention (issue #31; PLAN §7 "sanitised logs; raw
 * payload logging opt-in with retention and deletion controls").
 *
 * Three rules, each enforced by code rather than by convention:
 *
 * 1. **Opt-in.** `createRawPayloadSink` returns `null` unless
 *    `privacy.rawLogging.enabled` is true in the *effective* config loaded
 *    by `src/config/load.ts` (#21). `TraceRecorder` with a `null` sink never
 *    offers the bytes to anything, so with the shipped defaults nothing raw
 *    is created on disk at all — not an empty file, not a directory.
 * 2. **Redacted before write.** `privacy.rawLogging.redactBeforeWrite` is a
 *    schema `const: true`: it cannot be turned off. The sink applies the
 *    #22 redactor and the project's configured deny patterns (through #28's
 *    `OutboundPolicy`) and then refuses the write outright if a known secret
 *    pattern still survives. "Raw" here means the unsummarised payload, not
 *    an unredacted one.
 * 3. **Retention and deletion.** Bytes carry an `expiresAt` computed from
 *    `privacy.rawLogging.retentionDays`. `purgeExpiredRawPayloads` deletes
 *    them and clears the pointer on the trace; `purgeRawPayloadsNow` is the
 *    unconditional deletion control. Traces themselves are pruned by
 *    `storage.artifactRetentionDays`. Every entry point takes an injected
 *    clock, so retention is testable without waiting a week.
 *
 * Bytes live under the existing artifact store (`src/storage/artifacts.ts`),
 * never in the user's source tree and never at a machine-specific path.
 */
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import type { KorwfConfig } from "../config/types.ts";
import { OutboundPolicy } from "../security/outbound.ts";
import { containsSecret, redactValue } from "../security/redact.ts";
import type { ArtifactStore } from "../storage/artifacts.ts";
import type { DecisionTraceStore } from "../storage/trace-store.ts";
import type { DecisionTrace, TraceRawPayloadRef } from "./trace-types.ts";
import type { RawPayloadSink } from "./trace.ts";

/** Attempt directory raw payloads are filed under inside the artifact store. */
export const RAW_LOG_ATTEMPT_DIR = "raw-payloads";

/** Milliseconds in a day; retention is configured in whole days. */
const DAY_MS = 86_400_000;

/** `at` plus `days` days, as an ISO-8601 timestamp. */
export function expiryOf(at: string, days: number): string {
  return new Date(Date.parse(at) + days * DAY_MS).toISOString();
}

/**
 * Defence in depth: would these bytes still leak something?
 *
 * By construction this should always be `false` by the time the sink asks —
 * `redactValue` plus the project's deny patterns have already run. It is
 * checked anyway, and exported so the invariant is directly testable,
 * because a redactor regression must cost a dropped payload rather than a
 * leaked credential.
 */
export function wouldRefusePayload(text: string): boolean {
  return containsSecret(text);
}

/** Outcome of preparing raw bytes for disk: text to write, or a refusal. */
export type PreparedRawPayload = { readonly ok: true; readonly text: string } | { readonly ok: false };

/**
 * Redact a payload and decide whether it may be written. Pure, so the last
 * line of defence is directly testable: pass an identity `redact` and the
 * result must be a refusal, whatever the rest of the stack did.
 */
export function prepareRawPayload(body: unknown, redact: (text: string) => string): PreparedRawPayload {
  const text = redact(JSON.stringify(body, null, 2) ?? "null");
  return wouldRefusePayload(text) ? { ok: false } : { ok: true, text };
}

/** Thrown when a redacted payload still matches a known secret pattern. */
export class RawPayloadRefusedError extends Error {
  constructor(traceId: string) {
    super(
      `Refused to write the raw payload for trace ${traceId}: a known credential pattern survived redaction. ` +
        `The trace itself was still recorded; only the raw bytes were dropped.`,
    );
    this.name = "RawPayloadRefusedError";
  }
}

// ---------------------------------------------------------------------------
// the opt-in sink
// ---------------------------------------------------------------------------

export interface RawPayloadSinkOptions {
  readonly artifacts: ArtifactStore;
  readonly config: KorwfConfig;
  /** Share one policy with `ask()` rather than compiling patterns twice. */
  readonly policy?: OutboundPolicy;
  /** Called instead of throwing when a payload is refused. */
  readonly onRefused?: (error: RawPayloadRefusedError) => void;
}

/**
 * Writes redacted raw request/response pairs under the artifact store.
 *
 * Constructed only by `createRawPayloadSink`, which is the single place that
 * reads `privacy.rawLogging.enabled` — so there is no way to obtain one of
 * these without the user having opted in.
 */
export class ArtifactRawPayloadSink implements RawPayloadSink {
  readonly #artifacts: ArtifactStore;
  readonly #policy: OutboundPolicy;
  readonly #retentionDays: number;
  readonly #onRefused: ((error: RawPayloadRefusedError) => void) | null;

  constructor(options: RawPayloadSinkOptions) {
    this.#artifacts = options.artifacts;
    this.#policy = options.policy ?? new OutboundPolicy(options.config);
    this.#retentionDays = options.config.privacy.rawLogging.retentionDays;
    this.#onRefused = options.onRefused ?? null;
  }

  /** Days the bytes are kept, from `privacy.rawLogging.retentionDays`. */
  get retentionDays(): number {
    return this.#retentionDays;
  }

  write(params: {
    readonly traceId: string;
    readonly request: unknown;
    readonly response: unknown;
    readonly writtenAt: string;
  }): TraceRawPayloadRef | null {
    // Global redactor first (#22), then the project's own deny patterns
    // (#28). `redactBeforeWrite` is schema-fixed `true`; this is it.
    const body = {
      traceId: params.traceId,
      writtenAt: params.writtenAt,
      request: redactValue(params.request, 12),
      response: redactValue(params.response, 12),
    };
    // Belt and braces: if a credential shape survived both redactors, the
    // bytes do not get written at all. A dropped payload is a recoverable
    // gap; a leaked one is not.
    const prepared = prepareRawPayload(body, (text) => this.#policy.redact(text));
    if (!prepared.ok) {
      const error = new RawPayloadRefusedError(params.traceId);
      if (this.#onRefused === null) throw error;
      this.#onRefused(error);
      return null;
    }
    const { text } = prepared;

    const ref = this.#artifacts.write(
      RAW_LOG_ATTEMPT_DIR,
      `${params.traceId}.json`,
      `${text}\n`,
      "application/json",
    );
    return {
      relativePath: ref.relativePath,
      contentHash: ref.contentHash,
      sizeBytes: ref.sizeBytes,
      expiresAt: expiryOf(params.writtenAt, this.#retentionDays),
    };
  }
}

/**
 * The one place `privacy.rawLogging.enabled` is read.
 *
 * Returns `null` when raw logging is off, which is the shipped default and
 * what `TraceRecorder` interprets as "never offer the bytes to anything".
 */
export function createRawPayloadSink(options: RawPayloadSinkOptions): ArtifactRawPayloadSink | null {
  if (!options.config.privacy.rawLogging.enabled) return null;
  return new ArtifactRawPayloadSink(options);
}

// ---------------------------------------------------------------------------
// retention and deletion
// ---------------------------------------------------------------------------

/** What one retention sweep did. Counts and paths only; never content. */
export interface RetentionReport {
  /** ISO-8601 instant the sweep ran at. */
  readonly at: string;
  /** Raw payload files whose bytes were deleted. */
  readonly rawPayloadsPurged: readonly string[];
  /** Bytes reclaimed by those deletions. */
  readonly bytesReclaimed: number;
  /** Traces deleted entirely because they aged past trace retention. */
  readonly tracesDeleted: number;
  /** Files named by a trace that were already gone; the pointer was cleared. */
  readonly alreadyMissing: readonly string[];
}

const EMPTY_REPORT: Omit<RetentionReport, "at"> = {
  rawPayloadsPurged: [],
  bytesReclaimed: 0,
  tracesDeleted: 0,
  alreadyMissing: [],
};

export interface RetentionOptions {
  readonly traces: DecisionTraceStore;
  readonly artifacts: ArtifactStore;
  /** Injected clock; retention is tested with a fake one, never by waiting. */
  readonly now?: () => string;
}

/** Absolute path of a raw payload from its artifact-root-relative path. */
function absolutePathOf(artifacts: ArtifactStore, relativePath: string): string {
  return join(artifacts.root, relativePath);
}

/**
 * Delete the bytes a trace points at and clear the pointer.
 *
 * The trace row survives with `rawPayload: null`, so `/korwf why` still
 * explains the decision and says the raw payload is gone rather than
 * pretending it never existed. Returns the bytes reclaimed, or `null` if the
 * file had already been removed.
 */
function purgeOne(
  trace: DecisionTrace,
  options: RetentionOptions,
): { readonly relativePath: string; readonly bytes: number | null } | null {
  if (trace.rawPayload === null) return null;
  const { relativePath, sizeBytes } = trace.rawPayload;
  const absolute = absolutePathOf(options.artifacts, relativePath);
  const existed = existsSync(absolute);
  rmSync(absolute, { force: true });
  options.traces.clearRawPayload(trace.traceId);
  return { relativePath, bytes: existed ? sizeBytes : null };
}

/**
 * Delete every raw payload whose `expiresAt` has passed
 * (`privacy.rawLogging.retentionDays`). Idempotent: a second sweep finds
 * nothing to do because the pointers were cleared by the first.
 */
export function purgeExpiredRawPayloads(options: RetentionOptions): RetentionReport {
  const at = (options.now ?? (() => new Date().toISOString()))();
  const purged: string[] = [];
  const missing: string[] = [];
  let bytes = 0;
  for (const trace of options.traces.withRawPayload()) {
    if (trace.rawPayload === null || trace.rawPayload.expiresAt > at) continue;
    const result = purgeOne(trace, options);
    if (result === null) continue;
    if (result.bytes === null) missing.push(result.relativePath);
    else {
      purged.push(result.relativePath);
      bytes += result.bytes;
    }
  }
  return { ...EMPTY_REPORT, at, rawPayloadsPurged: purged, bytesReclaimed: bytes, alreadyMissing: missing };
}

/**
 * The deletion control PLAN §7 requires: delete **every** stored raw payload
 * right now, whatever its retention. This is what the user reaches for after
 * turning the feature off, and what `/korwf purge` calls.
 */
export function purgeRawPayloadsNow(options: RetentionOptions): RetentionReport {
  const at = (options.now ?? (() => new Date().toISOString()))();
  const purged: string[] = [];
  const missing: string[] = [];
  let bytes = 0;
  for (const trace of options.traces.withRawPayload()) {
    const result = purgeOne(trace, options);
    if (result === null) continue;
    if (result.bytes === null) missing.push(result.relativePath);
    else {
      purged.push(result.relativePath);
      bytes += result.bytes;
    }
  }
  return { ...EMPTY_REPORT, at, rawPayloadsPurged: purged, bytesReclaimed: bytes, alreadyMissing: missing };
}

/**
 * Full sweep: expire raw payloads, then delete traces older than
 * `storage.artifactRetentionDays`.
 *
 * Traces older than the cutoff have their raw bytes deleted first, so
 * dropping the row can never orphan a file on disk. Deleting a trace never
 * deletes the `Decision` row it pointed at — the record survives, only the
 * observability about it ages out.
 */
export function runRetentionSweep(
  options: RetentionOptions & { readonly config: KorwfConfig },
): RetentionReport {
  const now = options.now ?? (() => new Date().toISOString());
  const at = now();
  const expired = purgeExpiredRawPayloads({ ...options, now: () => at });

  const traceCutoff = expiryOf(at, -options.config.storage.artifactRetentionDays);
  const doomed = options.traces.olderThan(traceCutoff);
  const purged = [...expired.rawPayloadsPurged];
  const missing = [...expired.alreadyMissing];
  let bytes = expired.bytesReclaimed;
  for (const trace of doomed) {
    const result = purgeOne(trace, { ...options, now: () => at });
    if (result === null) continue;
    if (result.bytes === null) missing.push(result.relativePath);
    else {
      purged.push(result.relativePath);
      bytes += result.bytes;
    }
  }
  const tracesDeleted = options.traces.deleteOlderThan(traceCutoff);

  return {
    at,
    rawPayloadsPurged: purged,
    bytesReclaimed: bytes,
    tracesDeleted,
    alreadyMissing: missing,
  };
}

/** One-line summary of a sweep, for `/korwf purge` and for logs. */
export function retentionSummary(report: RetentionReport): string {
  if (report.rawPayloadsPurged.length === 0 && report.tracesDeleted === 0) {
    return `Nothing to purge at ${report.at}: no expired raw payloads and no expired traces.`;
  }
  const parts = [
    `${report.rawPayloadsPurged.length} raw payload file(s) deleted (${report.bytesReclaimed} bytes)`,
    `${report.tracesDeleted} trace row(s) deleted`,
  ];
  if (report.alreadyMissing.length > 0) {
    parts.push(`${report.alreadyMissing.length} pointer(s) cleared for files already gone`);
  }
  return `Purged at ${report.at}: ${parts.join("; ")}.`;
}
