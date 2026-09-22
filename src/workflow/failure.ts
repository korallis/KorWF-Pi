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
  "expected value to be (using ===)",
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

// ---------------------------------------------------------------------------
// unknown, and what it asks for
// ---------------------------------------------------------------------------

/**
 * The evidence an `unknown` classification asks for. Derived from what the
 * signal is *missing*, so the request is always actionable: "re-run with
 * stderr captured" rather than "investigate".
 */
export function evidenceRequestsFor(signal: FailureSignal): readonly string[] {
  const requests: string[] = [];
  if (signal.exitCode === undefined || signal.exitCode === null) {
    requests.push("Re-run the failing command and record its exit code.");
  }
  if ((signal.stderr ?? "").trim().length === 0) {
    requests.push("Capture stderr from the failing command (it was empty or not recorded).");
  }
  if ((signal.stdout ?? "").trim().length === 0) {
    requests.push("Capture stdout from the failing command (it was empty or not recorded).");
  }
  if (signal.command === undefined || signal.command.trim().length === 0) {
    requests.push("Record the exact command, including its working directory, that produced the failure.");
  }
  if (signal.httpStatus === undefined || signal.httpStatus === null) {
    requests.push("If a remote call was involved, record the HTTP status and any Retry-After header.");
  }
  requests.push(
    "Re-run the same check at the same revision to establish whether the failure is reproducible or flaky.",
  );
  return Object.freeze(requests);
}

/** Build the `unknown` classification for a signal. Never a guess. */
export function unknownClassification(
  signal: FailureSignal,
  options: { readonly source?: FailureClassificationSource; readonly rule?: string; readonly reason?: string } = {},
): FailureClassification {
  return Object.freeze({
    category: "unknown" as const,
    confidence: 0,
    rule: options.rule ?? "unknown:no-rule-matched",
    source: options.source ?? "fallback",
    reason:
      options.reason ??
      "No deterministic rule matched and no supported classification is available; evidence is required before acting.",
    needsEvidence: true,
    evidenceRequests: evidenceRequestsFor(signal),
  });
}

// ---------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------

/** Result of the deterministic pass: either a verdict or an explicit "ask Jev". */
export interface RuleClassificationResult {
  readonly classification: FailureClassification;
  /** `true` when the rules decided nothing and a Jev question is warranted. */
  readonly needsJev: boolean;
  /** The harness verdict from #124, when a turn was supplied. */
  readonly turn: TurnClassification | null;
}

/**
 * Deterministic classification (AC1). Order:
 *
 * 1. A supplied worker turn goes to `classifyTurn` (#124) *first*. A turn cut
 *    off at the output-token ceiling has no output to judge, so reading its
 *    text for taxonomy signals is exactly the mistake #124 exists to prevent.
 * 2. Otherwise the rule table, first match wins.
 * 3. Otherwise `unknown`, with `needsJev: true` so a caller with a key may
 *    ask `failure.classify@1`.
 */
export function classifyFailureByRules(signal: FailureSignal): RuleClassificationResult {
  const turn = signal.turn === undefined ? null : classifyTurn(signal.turn);
  if (turn !== null && turn.failureClass === "harness") {
    const category: FailureCategory = turn.kind === "capped" ? "quota" : "harness";
    return {
      classification: Object.freeze({
        category,
        confidence: 1,
        rule: `rule:turn-${turn.kind}`,
        source: "rule" as const,
        reason: turn.reason,
        needsEvidence: false,
        evidenceRequests: Object.freeze([]),
      }),
      needsJev: false,
      turn,
    };
  }
  const text = signalText(signal);
  for (const rule of FAILURE_RULES) {
    const matched = rule.match(signal, text);
    if (matched !== null) {
      return {
        classification: Object.freeze({
          category: rule.category,
          confidence: 1,
          rule: rule.id,
          source: "rule" as const,
          reason: `Matched ${rule.id} on ${JSON.stringify(matched)}.`,
          needsEvidence: false,
          evidenceRequests: Object.freeze([]),
        }),
        needsJev: false,
        turn,
      };
    }
  }
  return { classification: unknownClassification(signal), needsJev: true, turn };
}

/**
 * `classifyFailure(evidence|error)` (issue Scope). Deterministic only; the
 * Jev-assisted variant lives in `src/decisions/questions/failure.ts` and
 * falls back to exactly this function's `unknown`.
 */
export function classifyFailure(signal: FailureSignal): FailureClassification {
  return classifyFailureByRules(signal).classification;
}

// ---------------------------------------------------------------------------
// building a signal from a caught error
// ---------------------------------------------------------------------------

/** Normalise a caught exception into a `FailureSignal`. */
export function signalFromError(error: unknown, extra: FailureSignal = {}): FailureSignal {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const status = (error as { status?: unknown }).status;
    return {
      ...extra,
      errorName: error.name,
      errorMessage: error.message,
      errorCode: typeof code === "string" ? code : extra.errorCode,
      httpStatus: typeof status === "number" ? status : (extra.httpStatus ?? null),
    };
  }
  return { ...extra, errorMessage: typeof error === "string" ? error : JSON.stringify(error) };
}

// ---------------------------------------------------------------------------
// quota events (feed ModelAvailability, Stage 5 / #62)
// ---------------------------------------------------------------------------

/**
 * Emitted when a failure is classified `quota`. Stage 5's ModelAvailability
 * consumes this to pause a route.
 *
 * **Keyed by route, not by model id.** AGENTS.md §4: a downloaded user may
 * configure two subscriptions to the same vendor as two providers exposing
 * the same model id with separate quotas. Keying on the model id alone
 * mis-attributes the limit and can pause a healthy route.
 */
export interface QuotaEvent {
  readonly kind: "quota";
  /** Provider id as configured by the user; never a hardcoded vendor name. */
  readonly providerId: string;
  /** Model id as the provider exposes it. */
  readonly modelId: string;
  /** `providerId::modelId` — the availability key. */
  readonly routeKey: string;
  /** Seconds from `Retry-After`, when the response supplied one. */
  readonly retryAfterSeconds: number | null;
  readonly rule: string;
  readonly reason: string;
}

const RETRY_AFTER_RE = /retry[-_ ]?after["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)/i;

/** Parse a `Retry-After` delay in seconds out of an error body or header text. */
export function parseRetryAfterSeconds(text: string | undefined): number | null {
  if (text === undefined) return null;
  const match = RETRY_AFTER_RE.exec(text);
  if (match === null) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** Stable availability key for a route. Exported so callers cannot invent their own. */
export function routeKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

/**
 * Build the quota event for a classified failure, or `null` when the failure
 * was not a quota failure. Returning `null` rather than a best guess keeps
 * availability from being paused on a service error.
 */
export function quotaEventFor(
  classification: FailureClassification,
  signal: FailureSignal,
  route: { readonly providerId: string; readonly modelId: string },
): QuotaEvent | null {
  if (classification.category !== "quota") return null;
  const text = [signal.stderr, signal.stdout, signal.errorMessage].filter((p) => typeof p === "string").join("\n");
  return Object.freeze({
    kind: "quota" as const,
    providerId: route.providerId,
    modelId: route.modelId,
    routeKey: routeKey(route.providerId, route.modelId),
    retryAfterSeconds: parseRetryAfterSeconds(text),
    rule: classification.rule,
    reason: classification.reason,
  });
}
