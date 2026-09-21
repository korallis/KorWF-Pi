/**
 * The shape of a decision trace (issue #31; PLAN §3.I, §7).
 *
 * Types live apart from `trace.ts` so `src/storage/trace-store.ts` can
 * persist a trace without importing the telemetry *behaviour* (and so the
 * two modules cannot form an import cycle). Nothing here executes.
 *
 * PLAN §3.I: "Decisions explained from recorded inputs, returned values, and
 * policy rules — never fabricated rationales. Versions recorded: Jev model,
 * question set, policy, schema, package." Every field below is therefore
 * something that was *observed*: what was asked, what came back, what the
 * policy rule did with it, how long it took and what the transport's health
 * was. There is no free-text "reasoning" field anywhere in this type, by
 * design — a trace cannot carry an explanation nobody recorded.
 */
import type { Distribution } from "../storage/records.ts";
import type { BreakerState } from "../jev/resilience.ts";
import type { OutboundReport } from "../security/outbound.ts";

/**
 * The five versions PLAN §3.I requires on every trace.
 *
 * `jevModel` is `null` exactly when no Jev model answered (disabled mode,
 * transport error, or a deterministic fallback) — that is a recorded fact,
 * not a missing field, and `explainDecision` says so in words. The other
 * four are always strings: a trace with an unpopulated one is rejected by
 * `assertTraceVersions`.
 */
export interface TraceVersions {
  /** `package.json` version of korwf-pi. */
  readonly package: string;
  /** `RECORDS_SCHEMA_VERSION` — the record shapes this trace was written with. */
  readonly schema: string;
  /** `Workflow.policyVersion` — the policy the action was interpreted under. */
  readonly policy: string;
  /** Content hash of the question set (registry manifest) in force. */
  readonly questionSet: string;
  /** Jev model that answered, or `null` when none did. */
  readonly jevModel: string | null;
}

/** Version fields that must always be populated (`jevModel` may be null). */
export const REQUIRED_TRACE_VERSIONS = ["package", "schema", "policy", "questionSet"] as const;

/** Question identity, exactly as the registry knows it. */
export interface TraceQuestion {
  readonly id: string;
  readonly version: string;
  /** `id@version`. */
  readonly key: string;
  /** Content hash of the prompt/options/levels/abstention policy. */
  readonly contentHash: string;
}

/**
 * What actually went outbound, in summary. Derived from #28's
 * `OutboundReport`, which by construction carries counts, paths and reasons
 * and never removed content.
 */
export interface TraceRequestSummary {
  readonly purpose: OutboundReport["purpose"];
  /** sha256 of the filtered request as sent; correlates trace ↔ raw payload. */
  readonly requestHash: string;
  /** Bytes of the filtered payload actually sent. */
  readonly sentBytes: number;
  readonly droppedBytes: number;
  readonly removedCount: number;
  readonly truncatedCount: number;
  readonly redactedStrings: number;
  /** Paths the deny list refused, already normalised and never absolute. */
  readonly deniedPaths: readonly string[];
  /** Top-level keys of the minimal state that survived filtering. */
  readonly stateKeys: readonly string[];
  /** True when nothing was removed, truncated or redacted. */
  readonly clean: boolean;
}

/** What came back and what was done with it — all recorded values. */
export interface TraceOutcomeDetail {
  /** Raw distribution exactly as returned; `{}` when nothing was returned. */
  readonly distribution: Distribution;
  readonly confidence: number | null;
  /** `Decision.policyRule` — the rule that mapped the value to the action. */
  readonly policyRule: string;
  /** `Decision.action` — what the system did. */
  readonly action: string;
  /** Why a fallback was taken; `null` when Jev answered. */
  readonly fallbackReason: string | null;
  /** Complete versioned state hash the answer belongs to. */
  readonly stateHash: string;
  /** True when this answer was replayed from an earlier recorded Decision. */
  readonly reused: boolean;
}

/** How a trace ended. Mirrors what `ask()` actually observed. */
export type TraceOutcome = "jev" | "fallback" | "disabled" | "error" | "cached";

/** Pointer to opt-in raw payload bytes under the artifact store. */
export interface TraceRawPayloadRef {
  /** Artifact-root-relative path; never absolute (`src/storage/artifacts.ts`). */
  readonly relativePath: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  /** When the bytes become eligible for purge (`privacy.rawLogging.retentionDays`). */
  readonly expiresAt: string;
}

/**
 * One traced decision event.
 *
 * `decisionId` links it to the append-only `Decision` row that is the
 * authority; `attemptId` links it to the work that caused it. Both may be
 * `null` (a dry run has no Decision; a workflow-level decision has no
 * attempt), and `explainDecision` handles both without inventing a link.
 */
export interface DecisionTrace {
  readonly traceId: string;
  readonly createdAt: string;
  readonly decisionId: string | null;
  readonly attemptId: string | null;
  readonly workflowId: string;
  readonly question: TraceQuestion;
  readonly versions: TraceVersions;
  readonly outcome: TraceOutcome;
  readonly detail: TraceOutcomeDetail;
  /** `null` when nothing went outbound (disabled mode, cache hit). */
  readonly request: TraceRequestSummary | null;
  readonly latencyMs: number | null;
  /** Transport attempts beyond the first (#26 bounded retries). */
  readonly retries: number;
  /** Circuit-breaker state observed for this call (#26). */
  readonly breakerState: BreakerState;
  /** Transport error code, e.g. `jev.rate_limited`; `null` when there was none. */
  readonly errorCode: string | null;
  /** Set only under `privacy.rawLogging.enabled`; `null` by default. */
  readonly rawPayload: TraceRawPayloadRef | null;
}
