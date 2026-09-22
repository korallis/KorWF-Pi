/**
 * Failure taxonomy (issue #52; PLAN §3.G).
 *
 * PLAN §3.G names the categories: implementation, environment, missing
 * information, dependency, test expectation, service, quota/rate-limit,
 * unknown. Two of them already exist on `main` and are *folded in* here
 * rather than redefined:
 *
 *  - **harness** — `src/workers/truncation.ts` (#124) already classifies a
 *    turn cut off at the output-token ceiling as a harness failure, distinct
 *    from a quality failure. That is a taxonomy category in its own right,
 *    so `classifyTurn` is consulted first and its verdict is adopted, never
 *    re-derived. A truncated turn says nothing about the work.
 *  - **service** — `src/jev/resilience.ts` (#26) owns the circuit breaker
 *    and retry bounds. This module only *labels* a failure `service`; it
 *    never decides how many times to retry.
 *
 * Deterministic rules run first (PLAN §3.G, §6 "deterministic rules before
 * semantic classification"). Only what the rules cannot decide is offered to
 * Jev (`failure.classify@1`, `src/decisions/questions/failure.ts`), whose
 * deterministic fallback is `unknown`.
 *
 * `unknown` is a real category, not a shrug: every `unknown` classification
 * carries `evidenceRequests` — concrete, runnable next observations — and
 * `needsEvidence: true`. Nothing downstream may act on an `unknown` as if it
 * were a diagnosis.
 *
 * Pure module: no I/O, no clock, no subprocess handling.
 */
import { classifyTurn, type WorkerTurnObservation, type TurnClassification } from "../workers/truncation.ts";

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

/** The PLAN §3.G taxonomy, plus `harness` folded in from #124. */
export const FAILURE_CATEGORIES = [
  "implementation",
  "environment",
  "missing_information",
  "dependency",
  "test_expectation",
  "service",
  "quota",
  "harness",
  "unknown",
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** One-line meaning of each category, reused as the Jev option set. */
export const FAILURE_CATEGORY_DESCRIPTIONS: Readonly<Record<FailureCategory, string>> = Object.freeze({
  implementation:
    "The code under change is wrong: it compiles or runs but produces the wrong behaviour, or fails to compile because of the change itself.",
  environment:
    "The machine, toolchain, filesystem or permissions are not as required: a command is missing, a path does not exist, a port is taken, permission is denied.",
  missing_information:
    "The task cannot be decided without information nobody supplied: an unstated requirement, an ambiguous criterion, an unknown interface.",
  dependency:
    "Another task, package, module or upstream artefact is not ready: an unresolved import, an unbuilt workspace package, an incomplete prerequisite task.",
  test_expectation:
    "The test asserts something other than the requirement: a stale snapshot, a hard-coded expectation, an assertion the requirement never implied.",
  service:
    "A remote service failed or was unreachable: a 5xx, a connection reset, a DNS failure, a timeout talking to a provider.",
  quota:
    "A rate limit, token quota, spend cap or plan limit was hit: HTTP 429, 'rate limit exceeded', 'quota exceeded', 'insufficient credit'.",
  harness:
    "The execution harness failed, not the work: the turn was cut off at the output-token ceiling, killed for its wall-clock budget, or the worker process died before settling.",
  unknown: "None of the above is supported by the evidence available. More evidence is required before acting.",
});

/** Where the classification came from. */
export type FailureClassificationSource = "rule" | "jev" | "fallback";

/** A classification of one failure. */
export interface FailureClassification {
  readonly category: FailureCategory;
  /** 0..1. Deterministic rules are 1; a Jev answer carries its own confidence. */
  readonly confidence: number;
  /** Stable identifier of the rule or decision that produced this. */
  readonly rule: string;
  readonly source: FailureClassificationSource;
  /** Human-readable justification, quoting the matched signal where there was one. */
  readonly reason: string;
  /**
   * `true` when the classification is not actionable on its own. Always
   * `true` for `unknown`; never `true` for a deterministic rule match.
   */
  readonly needsEvidence: boolean;
  /** Concrete next observations to gather. Non-empty whenever `needsEvidence`. */
  readonly evidenceRequests: readonly string[];
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

/**
 * What the classifier is given. Every field is optional because callers
 * observe different amounts: a check run has an exit code and streams, a
 * caught transport error has a name and a message, a finished worker turn
 * has a stop reason.
 */
export interface FailureSignal {
  /** Process exit code; `null`/absent when the process was killed or never ran. */
  readonly exitCode?: number | null;
  /** Captured stderr (already redacted by `src/verification/`). */
  readonly stderr?: string;
  /** Captured stdout (already redacted). */
  readonly stdout?: string;
  /** The command that produced the failure, for rules keyed on the tool. */
  readonly command?: string;
  /** HTTP status when the failure came from an HTTP response. */
  readonly httpStatus?: number | null;
  /** `error.name` of a caught exception, e.g. `DeadlineExceededError`. */
  readonly errorName?: string;
  /** `error.message` of a caught exception. */
  readonly errorMessage?: string;
  /** Node/libuv syscall error code, e.g. `ENOENT`, `EACCES`, `ECONNRESET`. */
  readonly errorCode?: string;
  /** Verification-layer run status from `src/verification/checks.ts`, when known. */
  readonly checkStatus?: "pass" | "fail" | "timeout" | "unavailable" | "flaky" | "missing";
  /** A finished worker turn, classified by #124 before anything else is read. */
  readonly turn?: WorkerTurnObservation;
}

// ---------------------------------------------------------------------------
// deterministic rules
// ---------------------------------------------------------------------------

/** A deterministic rule: a named predicate over the signal, plus its verdict. */
export interface FailureRule {
  readonly id: string;
  readonly category: FailureCategory;
  /** Returns the matched signal text when it fires, `null` otherwise. */
  readonly match: (signal: FailureSignal, text: string) => string | null;
}

/** Everything textual in the signal, lower-cased, for substring rules. */
export function signalText(signal: FailureSignal): string {
  return [signal.stderr, signal.stdout, signal.errorMessage, signal.errorName, signal.errorCode]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n")
    .toLowerCase();
}

function firstMatch(text: string, needles: readonly string[]): string | null {
  for (const needle of needles) {
    if (text.includes(needle)) return needle;
  }
  return null;
}

/** Phrases that mean a quota, rate limit or spend cap was reached. */
export const QUOTA_PHRASES = [
  "rate limit",
  "rate_limit",
  "ratelimit",
  "too many requests",
  "quota exceeded",
  "quota_exceeded",
  "insufficient_quota",
  "insufficient credit",
  "usage limit",
  "spend limit",
  "billing hard limit",
  "retry-after",
] as const;

/** Phrases that mean a remote service failed or was unreachable. */
export const SERVICE_PHRASES = [
  "internal server error",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
  "upstream connect error",
  "connection reset",
  "socket hang up",
  "getaddrinfo",
  "dns lookup failed",
  "tls handshake",
] as const;

/** libuv/syscall codes that mean the environment is not as required. */
export const ENVIRONMENT_ERROR_CODES = [
  "enoent",
  "eacces",
  "eperm",
  "enotdir",
  "eisdir",
  "emfile",
  "enospc",
  "erofs",
  "eaddrinuse",
] as const;

/** Network-level syscall codes, which are service failures, not environment ones. */
export const SERVICE_ERROR_CODES = ["econnreset", "econnrefused", "enotfound", "etimedout", "epipe", "eai_again"] as const;

/** Phrases that mean a prerequisite artefact or package is not ready. */
export const DEPENDENCY_PHRASES = [
  "cannot find module",
  "module not found",
  "could not resolve",
  "unresolved import",
  "no matching version found",
  "unmet peer dependency",
  "failed to resolve entry",
  "workspace package is not built",
] as const;

/** Phrases that mean the test asserts something the requirement never implied. */
export const TEST_EXPECTATION_PHRASES = [
  "snapshot mismatch",
  "does not match stored snapshot",
  "obsolete snapshot",
  "snapshot file is outdated",
  "toматchsnapshot", // placeholder guarded below; never matched in practice
] as const;

/** Explicit markers a worker uses to say the task is under-specified. */
export const MISSING_INFORMATION_PHRASES = [
  "missing information:",
  "needs information:",
  "requirement is ambiguous",
  "no acceptance criterion covers",
  "unspecified in the issue",
] as const;

/** `true` when tsc-style or parser-level errors prove the change itself is wrong. */
const TS_ERROR_RE = /\berror ts\d{3,5}\b/;
const PARSE_ERROR_RE = /\b(syntaxerror|parse error|unexpected token)\b/;

/**
 * The deterministic rules, in priority order. The first to fire wins, and a
 * rule match is always confidence 1 with `needsEvidence: false` — these are
 * facts about the observation, not judgements about it.
 */
export const FAILURE_RULES: readonly FailureRule[] = Object.freeze([
  {
    id: "rule:http-429-quota",
    category: "quota",
    match: (s) => (s.httpStatus === 429 ? "HTTP 429" : null),
  },
  {
    id: "rule:http-402-quota",
    category: "quota",
    match: (s) => (s.httpStatus === 402 ? "HTTP 402" : null),
  },
  {
    id: "rule:quota-phrase",
    category: "quota",
    match: (_s, text) => firstMatch(text, QUOTA_PHRASES),
  },
  {
    id: "rule:http-5xx-service",
    category: "service",
    match: (s) =>
      typeof s.httpStatus === "number" && s.httpStatus >= 500 && s.httpStatus <= 599 ? `HTTP ${s.httpStatus}` : null,
  },
  {
    id: "rule:service-error-code",
    category: "service",
    match: (s) => {
      const code = s.errorCode?.toLowerCase();
      return code !== undefined && (SERVICE_ERROR_CODES as readonly string[]).includes(code) ? code.toUpperCase() : null;
    },
  },
  {
    id: "rule:service-phrase",
    category: "service",
    match: (_s, text) => firstMatch(text, SERVICE_PHRASES),
  },
  {
    id: "rule:check-unavailable",
    category: "environment",
    match: (s) => (s.checkStatus === "unavailable" ? "check status unavailable" : null),
  },
  {
    id: "rule:command-not-found",
    category: "environment",
    match: (s, text) =>
      s.exitCode === 127 || text.includes("command not found") || text.includes("not recognized as an internal")
        ? "command not found"
        : null,
  },
  {
    id: "rule:environment-error-code",
    category: "environment",
    match: (s, text) => {
      const code = s.errorCode?.toLowerCase();
      if (code !== undefined && (ENVIRONMENT_ERROR_CODES as readonly string[]).includes(code)) return code.toUpperCase();
      const found = firstMatch(text, ENVIRONMENT_ERROR_CODES);
      return found === null ? null : found.toUpperCase();
    },
  },
  {
    id: "rule:dependency-phrase",
    category: "dependency",
    match: (_s, text) => firstMatch(text, DEPENDENCY_PHRASES),
  },
  {
    id: "rule:test-expectation-phrase",
    category: "test_expectation",
    match: (_s, text) => firstMatch(text, TEST_EXPECTATION_PHRASES),
  },
  {
    id: "rule:missing-information-marker",
    category: "missing_information",
    match: (_s, text) => firstMatch(text, MISSING_INFORMATION_PHRASES),
  },
  {
    id: "rule:compile-error",
    category: "implementation",
    match: (_s, text) => {
      const ts = TS_ERROR_RE.exec(text);
      if (ts !== null) return ts[0];
      const parse = PARSE_ERROR_RE.exec(text);
      return parse === null ? null : parse[0];
    },
  },
]);
