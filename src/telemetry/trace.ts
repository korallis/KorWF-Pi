/**
 * Decision traces (issue #31; PLAN §3.I, §7).
 *
 * This extends what already exists rather than duplicating it:
 *
 * - `src/decisions/` (#27, #29) produces the answers. A trace records what
 *   those produced; it never re-decides anything.
 * - `src/storage/` (#23) keeps the append-only `Decision` row, which stays
 *   the authority for state hash, question version, Jev model version, raw
 *   distribution, policy rule, action, override and freshness
 *   (docs/records.md). A trace points at that row and adds the five
 *   versions, latency, retries, breaker state and a sanitised summary of
 *   what actually went outbound.
 * - `src/security/redact.ts` + `outbound.ts` (#22, #28) decide what may be
 *   written. Every string in a trace goes through the redactor on the way
 *   in; the request summary is built from #28's `OutboundReport`, which
 *   carries counts, paths and reasons but never removed content.
 * - `src/telemetry/ledger.ts` (#30) is the accounting sibling. Traces sit
 *   beside it, in the same module, using the same store.
 *
 * **The invariant that makes `/korwf why` honest** (PLAN §3.I): a trace is
 * assembled only from recorded inputs, returned values and policy rules.
 * `DecisionTrace` has no free-text rationale field, `explainDecision` reads
 * exclusively from recorded fields, and `TraceRecorder.record` refuses a
 * trace whose five version fields are not populated. A rationale nobody
 * recorded cannot be produced by this module.
 */
import { createHash, randomUUID } from "node:crypto";
import type { OutboundReport } from "../security/outbound.ts";
import { redactString, redactValue } from "../security/redact.ts";
import type { BreakerState } from "../jev/resilience.ts";
import type { Decision, Distribution } from "../storage/records.ts";
import { RECORDS_SCHEMA_VERSION } from "../storage/records.ts";
import { canonicalJson } from "../storage/repos/base.ts";
import {
  REQUIRED_TRACE_VERSIONS,
  type DecisionTrace,
  type TraceOutcome,
  type TraceOutcomeDetail,
  type TraceQuestion,
  type TraceRawPayloadRef,
  type TraceRequestSummary,
  type TraceVersions,
} from "./trace-types.ts";

export type {
  DecisionTrace,
  TraceOutcome,
  TraceOutcomeDetail,
  TraceQuestion,
  TraceRawPayloadRef,
  TraceRequestSummary,
  TraceVersions,
} from "./trace-types.ts";
export { REQUIRED_TRACE_VERSIONS } from "./trace-types.ts";

/** Thrown when a trace would be written without the PLAN §3.I versions. */
export class TraceVersionError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `A decision trace must record all five versions (PLAN §3.I). Missing or empty: ${missing.join(", ")}. ` +
        `Nothing was written: an unversioned trace cannot be replayed or explained.`,
    );
    this.name = "TraceVersionError";
    this.missing = missing;
  }
}

/** The schema version string every trace records. */
export function schemaVersionString(): string {
  return String(RECORDS_SCHEMA_VERSION);
}

/** Stable hash of an outbound request, for trace ↔ raw-payload correlation. */
export function requestHashOf(request: unknown): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

/**
 * Which of the five version fields are absent or blank.
 *
 * `jevModel` is excluded from the required set on purpose: `null` there is
 * the *recorded fact* that no Jev model answered (disabled mode, transport
 * error, deterministic fallback), and forcing a placeholder string would be
 * the fabrication PLAN §3.I forbids. It is still a mandatory *property* —
 * the type requires it — so it can never be silently omitted.
 */
export function missingTraceVersions(versions: TraceVersions): readonly string[] {
  const missing: string[] = [];
  for (const field of REQUIRED_TRACE_VERSIONS) {
    const value = versions[field];
    if (typeof value !== "string" || value.trim() === "") missing.push(field);
  }
  if (!("jevModel" in versions)) missing.push("jevModel");
  return missing;
}

/** Throw unless every required version field is populated. */
export function assertTraceVersions(versions: TraceVersions): void {
  const missing = missingTraceVersions(versions);
  if (missing.length > 0) throw new TraceVersionError(missing);
}

// ---------------------------------------------------------------------------
// sanitised request summary
// ---------------------------------------------------------------------------

/** Top-level keys of a filtered state object; `[]` for anything else. */
function stateKeysOf(state: unknown): readonly string[] {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return [];
  return Object.keys(state as Record<string, unknown>)
    .map((key) => redactString(key))
    .sort();
}

/**
 * Summarise one outbound request from #28's report.
 *
 * The report is already safe by construction — it holds counts, paths and
 * reasons, never removed content — but paths are redacted again here, so a
 * trace stays safe even if a future report ever carried something richer.
 */
export function summariseRequest(params: {
  readonly report: OutboundReport;
  /** The filtered request as sent; hashed, never copied into the trace. */
  readonly request: unknown;
  /** Filtered state, for the surviving top-level key names. */
  readonly state?: unknown;
}): TraceRequestSummary {
  const { report } = params;
  const deniedPaths = report.removed
    .filter((item) => item.reason === "denied")
    .map((item) => redactString(item.what))
    .sort();
  return {
    purpose: report.purpose,
    requestHash: requestHashOf(params.request),
    sentBytes: report.sentBytes,
    droppedBytes: report.droppedBytes,
    removedCount: report.removed.length,
    truncatedCount: report.truncated.length,
    redactedStrings: report.redactedStrings,
    deniedPaths,
    stateKeys: stateKeysOf(params.state),
    clean: report.clean,
  };
}

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------

/** The part of the store a recorder needs: append one trace row. */
export interface TraceSink {
  insert(trace: DecisionTrace): DecisionTrace;
}

/**
 * The opt-in raw-payload path (PLAN §7). Implemented by
 * `ArtifactRawPayloadSink` in `retention.ts`; `null` here means the feature
 * is off, which is the shipped default.
 */
export interface RawPayloadSink {
  /** Persist redacted raw bytes and return where they went, or `null` to decline. */
  write(params: {
    readonly traceId: string;
    readonly request: unknown;
    readonly response: unknown;
    readonly writtenAt: string;
  }): TraceRawPayloadRef | null;
}

/** Everything a trace needs that `ask()` does not already know. */
export interface TraceRecorderOptions {
  readonly sink: TraceSink;
  readonly workflowId: string;
  readonly versions: Omit<TraceVersions, "jevModel">;
  /** Default attempt the traces belong to; per-trace `attemptId` overrides it. */
  readonly attemptId?: string | null;
  /** Opt-in raw payload storage. Omitted or `null`: nothing raw is written. */
  readonly rawPayloads?: RawPayloadSink | null;
  readonly now?: () => string;
  readonly newId?: () => string;
}

/** Everything observed about one decision, before the envelope. */
export interface TraceDraft {
  /** The recorded `Decision` this explains, or `null` for a dry run. */
  readonly decisionId: string | null;
  readonly attemptId?: string | null;
  readonly question: TraceQuestion;
  readonly outcome: TraceOutcome;
  readonly detail: TraceOutcomeDetail;
  readonly request: TraceRequestSummary | null;
  readonly latencyMs: number | null;
  readonly retries?: number;
  readonly breakerState?: BreakerState;
  readonly errorCode?: string | null;
  /** Jev model that answered; `null` when none did. A recorded fact. */
  readonly jevModelVersion: string | null;
  /**
   * Raw request/response, offered to the raw-payload sink. Held in memory
   * only: with raw logging off (the default) these are dropped on the
   * floor and nothing reaches disk.
   */
  readonly raw?: { readonly request: unknown; readonly response: unknown };
}

/**
 * Writes one trace per traced event. One recorder per workflow, held
 * alongside `DecisionRecorder` (#27) so the two write in lockstep: the
 * Decision row is the record, the trace is the observability about it.
 */
export class TraceRecorder {
  readonly #sink: TraceSink;
  readonly #workflowId: string;
  readonly #versions: Omit<TraceVersions, "jevModel">;
  readonly #attemptId: string | null;
  readonly #rawPayloads: RawPayloadSink | null;
  readonly #now: () => string;
  readonly #newId: () => string;

  constructor(options: TraceRecorderOptions) {
    this.#sink = options.sink;
    this.#workflowId = options.workflowId;
    this.#versions = options.versions;
    this.#attemptId = options.attemptId ?? null;
    this.#rawPayloads = options.rawPayloads ?? null;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? (() => `tr-${randomUUID()}`);
    // Fail at construction, not at the first decision: a misconfigured
    // recorder must not be discovered halfway through a workflow.
    assertTraceVersions({ ...options.versions, jevModel: null });
  }

  /** True when this recorder will write raw payloads (opt-in only). */
  get rawLoggingEnabled(): boolean {
    return this.#rawPayloads !== null;
  }

  /** Append one trace. Returns it exactly as persisted. */
  record(draft: TraceDraft): DecisionTrace {
    const versions: TraceVersions = { ...this.#versions, jevModel: draft.jevModelVersion };
    assertTraceVersions(versions);

    const traceId = this.#newId();
    const createdAt = this.#now();
    const rawPayload =
      this.#rawPayloads === null || draft.raw === undefined
        ? null
        : this.#rawPayloads.write({
            traceId,
            request: draft.raw.request,
            response: draft.raw.response,
            writtenAt: createdAt,
          });

    const trace: DecisionTrace = {
      traceId,
      createdAt,
      decisionId: draft.decisionId,
      attemptId: draft.attemptId === undefined ? this.#attemptId : draft.attemptId,
      workflowId: this.#workflowId,
      question: draft.question,
      versions,
      outcome: draft.outcome,
      detail: sanitiseDetail(draft.detail),
      request: draft.request,
      latencyMs: draft.latencyMs,
      retries: draft.retries ?? 0,
      breakerState: draft.breakerState ?? "closed",
      errorCode: draft.errorCode === undefined ? null : draft.errorCode,
      rawPayload,
    };
    return this.#sink.insert(trace);
  }
}

/**
 * Redact the free-form parts of an outcome. The distribution is numbers and
 * label keys; the rule, action and fallback reason are short identifiers —
 * but all of them originate outside this module, so all of them are
 * redacted. A trace must never carry an unredacted secret (PLAN §7).
 */
function sanitiseDetail(detail: TraceOutcomeDetail): TraceOutcomeDetail {
  return {
    distribution: redactValue(detail.distribution) as Distribution,
    confidence: detail.confidence,
    policyRule: redactString(detail.policyRule),
    action: redactString(detail.action),
    fallbackReason: detail.fallbackReason === null ? null : redactString(detail.fallbackReason),
    stateHash: detail.stateHash,
    reused: detail.reused,
  };
}

/** In-memory sink for tests and dry runs. Same write-once discipline. */
export class MemoryTraceSink implements TraceSink {
  readonly traces: DecisionTrace[] = [];

  insert(trace: DecisionTrace): DecisionTrace {
    this.traces.push(trace);
    return trace;
  }
}

// ---------------------------------------------------------------------------
// explanation (`/korwf why <decision>`)
// ---------------------------------------------------------------------------

/** One line of an explanation: a labelled *recorded* value and where it came from. */
export interface ExplanationLine {
  readonly label: string;
  readonly value: string;
  /** Which recorded artefact this line was read out of. */
  readonly source: "decision" | "trace";
  /** The exact field path read, so a reader can check it themselves. */
  readonly field: string;
}

export interface Explanation {
  readonly decisionId: string | null;
  readonly traceId: string | null;
  readonly lines: readonly ExplanationLine[];
  /** Facts the records do not contain. Stated as gaps, never filled in. */
  readonly unknown: readonly string[];
  /** Rendered text, for `/korwf why`. */
  readonly text: string;
}

function formatDistribution(distribution: Distribution): string {
  const entries = Object.entries(distribution);
  if (entries.length === 0) return "(none recorded — no answer was returned)";
  return entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([label, p]) => `${label}=${typeof p === "number" ? p.toFixed(4) : String(p)}`)
    .join(", ");
}

/**
 * Reconstruct what happened, from recorded fields only (PLAN §3.I).
 *
 * Every line names the artefact and field it was read from. Anything the
 * records do not contain is listed under `unknown` rather than inferred:
 * with no trace, the versions and the transport health are simply unknown;
 * with no Jev model, the line says the deterministic fallback ran and why.
 * There is no code path here that produces a sentence not backed by a
 * stored value.
 */
export function explainDecision(decision: Decision | null, trace: DecisionTrace | null): Explanation {
  const lines: ExplanationLine[] = [];
  const unknown: string[] = [];
  const push = (label: string, value: string, source: ExplanationLine["source"], field: string): void => {
    lines.push({ label, value: redactString(value), source, field });
  };

  if (decision === null && trace === null) {
    return {
      decisionId: null,
      traceId: null,
      lines: [],
      unknown: ["No Decision row and no trace exist for this id; nothing is known about it."],
      text: "No Decision row and no trace exist for this id; nothing is known about it.",
    };
  }

  if (decision !== null) {
    push("Question", `${decision.questionId}@${decision.questionVersion}`, "decision", "questionId/questionVersion");
    push("Asked about state", decision.stateHash, "decision", "stateHash");
    push(
      "Answered by",
      decision.jevModelVersion === null
        ? "no Jev model — the deterministic fallback produced this answer"
        : decision.jevModelVersion,
      "decision",
      "jevModelVersion",
    );
    push("Returned distribution", formatDistribution(decision.rawDistribution), "decision", "rawDistribution");
    push(
      "Confidence",
      decision.confidence === null ? "not reported" : decision.confidence.toFixed(4),
      "decision",
      "confidence",
    );
    push("Policy rule applied", decision.policyRule, "decision", "policyRule");
    push("Action taken", decision.action, "decision", "action");
    push(
      "Override",
      decision.override === null
        ? "none recorded"
        : `${decision.override.actor} overrode the action to "${decision.override.action}" at ` +
          `${decision.override.at}: ${decision.override.reason}`,
      "decision",
      "override",
    );
    push(
      "Decided at",
      `${decision.freshness.decidedAt} (revision ${decision.freshness.revision})`,
      "decision",
      "freshness",
    );
  } else {
    unknown.push("No Decision row: the raw distribution, policy rule, action and override are not recorded.");
  }

  if (trace !== null) {
    push(
      "Versions",
      `package ${trace.versions.package}, schema ${trace.versions.schema}, policy ${trace.versions.policy}, ` +
        `questions ${trace.versions.questionSet}, Jev model ${trace.versions.jevModel ?? "none (fallback)"}`,
      "trace",
      "versions",
    );
    push("Outcome", trace.outcome, "trace", "outcome");
    if (trace.detail.fallbackReason !== null) {
      push("Fallback reason", trace.detail.fallbackReason, "trace", "detail.fallbackReason");
    }
    push(
      "Latency",
      trace.latencyMs === null ? "not measured (no call was made)" : `${trace.latencyMs} ms`,
      "trace",
      "latencyMs",
    );
    push("Retries", String(trace.retries), "trace", "retries");
    push("Circuit breaker", trace.breakerState, "trace", "breakerState");
    if (trace.errorCode !== null) push("Transport error", trace.errorCode, "trace", "errorCode");
    if (trace.request === null) {
      push("Sent outbound", "nothing — no request left this machine", "trace", "request");
    } else {
      const r = trace.request;
      push(
        "Sent outbound",
        `${r.sentBytes} bytes for ${r.purpose} (state keys: ${r.stateKeys.join(", ") || "none"})`,
        "trace",
        "request",
      );
      push(
        "Filtered out",
        `${r.removedCount} removed, ${r.truncatedCount} truncated, ${r.redactedStrings} redacted` +
          (r.deniedPaths.length === 0 ? "" : `; denied: ${r.deniedPaths.join(", ")}`),
        "trace",
        "request",
      );
    }
    push(
      "Raw payload",
      trace.rawPayload === null
        ? "not stored (privacy.rawLogging.enabled is off)"
        : `${trace.rawPayload.relativePath} (expires ${trace.rawPayload.expiresAt})`,
      "trace",
      "rawPayload",
    );
    if (trace.detail.reused) {
      push("Reused", "this answer was replayed from an earlier recorded Decision", "trace", "detail.reused");
    }
  } else {
    unknown.push("No trace: versions, latency, retries, breaker state and the outbound summary are not recorded.");
  }

  const header =
    decision === null
      ? `Trace ${trace?.traceId ?? "(unknown)"} — no Decision row`
      : `Decision ${decision.id} — ${decision.questionId}@${decision.questionVersion}`;
  const body = lines.map((line) => `  ${line.label}: ${line.value}   [${line.source}.${line.field}]`);
  const gaps = unknown.length === 0 ? [] : ["", "Not recorded:", ...unknown.map((u) => `  - ${u}`)];
  return {
    decisionId: decision?.id ?? null,
    traceId: trace?.traceId ?? null,
    lines,
    unknown,
    text: [header, ...body, ...gaps].join("\n"),
  };
}
