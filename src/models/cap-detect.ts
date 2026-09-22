/**
 * Cap detection (issue #62; PLAN §3.D "Caps and fallback").
 *
 * Code, not Jev, detects that a route is unavailable: HTTP 429, a provider
 * quota message, or our own budget reservation refusing a call. Each
 * detection becomes a `CapObservation` (from `src/models/availability.ts`,
 * #125) keyed on `RouteId` — never on bare model id, because a downloaded
 * user's two subscriptions to one vendor are two providers exposing the same
 * model id on separate quotas (#125's amendment to this issue).
 *
 * Three cap kinds, deliberately distinct:
 *  - `rate_limited`  — transient; provider says "back off and retry" and
 *    usually gives a short `Retry-After`.
 *  - `quota_exhausted` — the provider's account-level cap; resets on a
 *    horizon we can rarely see (billing period), so treat as long/unknown.
 *  - `budget_cap` — *our* policy, from `src/telemetry/ledger.ts`'s
 *    `BudgetExceededError` (#30). Never re-implemented here: this module
 *    only turns that error into a `CapObservation`. It resets when the user
 *    raises the cap, not on a clock — `estimatedReset` is always `null`.
 *
 * The reset estimate comes only from what the provider actually said
 * (`Retry-After` / `retry-after-ms` headers, or a reset instant in the error
 * text). Where nothing is stated, `estimatedReset` is `null` ("unknown"),
 * never a guessed number (issue #62 AC).
 *
 * Pure module: no I/O, no clock reads (callers pass `now`/`at`), no provider
 * names.
 */
import type { CapKind, IsoTimestamp } from "../storage/records.ts";
import type { CapObservation } from "./availability.ts";

export type { CapKind };

// ---------------------------------------------------------------------------
// input shapes
// ---------------------------------------------------------------------------

/** Minimal header reader so callers can pass a real `Headers`, a plain object, or nothing. */
export interface HeaderLike {
  get(name: string): string | null;
}

function headerLikeFrom(headers: HeaderLike | Readonly<Record<string, string>> | undefined): HeaderLike {
  if (headers === undefined) return { get: () => null };
  if (typeof (headers as HeaderLike).get === "function") return headers as HeaderLike;
  const rec = headers as Readonly<Record<string, string>>;
  return {
    get: (name: string) => {
      const lower = name.toLowerCase();
      for (const [k, v] of Object.entries(rec)) {
        if (k.toLowerCase() === lower) return v;
      }
      return null;
    },
  };
}

/**
 * What the detector is given about one failed call. Every field optional —
 * callers observe different amounts depending on the transport.
 */
export interface ProviderErrorSignal {
  /** HTTP status, when the failure came from an HTTP response. */
  readonly httpStatus?: number | null;
  /** Response headers, when available. `Retry-After` / `retry-after-ms` / `x-ratelimit-reset` are read from here. */
  readonly headers?: HeaderLike | Readonly<Record<string, string>>;
  /** Raw error/body text (already redacted by the caller), scanned for quota phrases and reset hints. */
  readonly bodyText?: string | null;
}

// ---------------------------------------------------------------------------
// header / text parsing — reset comes only from what the provider actually said
// ---------------------------------------------------------------------------

/** `Retry-After`/`retry-after-ms` header, in milliseconds. `null` when absent or invalid. */
export function parseRetryAfterHeaderMs(headers: HeaderLike): number | null {
  const ms = headers.get("retry-after-ms");
  if (ms !== null) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const secs = headers.get("retry-after");
  if (secs !== null) {
    // Retry-After may be delay-seconds or an HTTP-date (RFC 9110 §10.2.3).
    const n = Number(secs);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
    const asDate = Date.parse(secs);
    if (!Number.isNaN(asDate)) return null; // caller resolves against `at`; see resetFromHeaders
  }
  return null;
}

/** `Retry-After` as an absolute instant when it was an HTTP-date; `null` otherwise/absent. */
function retryAfterDate(headers: HeaderLike): IsoTimestamp | null {
  const secs = headers.get("retry-after");
  if (secs === null) return null;
  if (Number.isFinite(Number(secs))) return null; // delay-seconds form, handled elsewhere
  const asDate = Date.parse(secs);
  return Number.isNaN(asDate) ? null : (new Date(asDate).toISOString() as IsoTimestamp);
}

/** Common rate-limit reset headers providers send as unix seconds or ISO instants. `null` if none parse. */
function resetFromHeaders(headers: HeaderLike): IsoTimestamp | null {
  for (const name of ["x-ratelimit-reset", "ratelimit-reset", "x-rate-limit-reset"]) {
    const raw = headers.get(name);
    if (raw === null) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      // Heuristic: values below 10^12 are unix seconds, else already ms.
      const ms = n < 1e12 ? n * 1000 : n;
      return new Date(ms).toISOString() as IsoTimestamp;
    }
    const asDate = Date.parse(raw);
    if (!Number.isNaN(asDate)) return new Date(asDate).toISOString() as IsoTimestamp;
  }
  return null;
}

const RETRY_AFTER_TEXT_RE = /retry[-_ ]?after["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)/i;

/** Fallback: a `retry-after: N` style mention inside body text rather than a header. */
function retryAfterFromText(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const m = RETRY_AFTER_TEXT_RE.exec(text);
  if (m === null) return null;
  const secs = Number(m[1]);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
}

/** Phrases indicating an account-level quota exhaustion rather than a short-lived rate limit. */
export const QUOTA_EXHAUSTED_PHRASES = [
  "quota exceeded",
  "quota_exceeded",
  "insufficient_quota",
  "insufficient credit",
  "usage limit",
  "monthly limit",
  "billing hard limit",
  "plan limit",
] as const;

/** Phrases indicating a short-lived, retryable rate limit. */
export const RATE_LIMIT_PHRASES = ["rate limit", "rate_limit", "ratelimit", "too many requests"] as const;

function containsAny(text: string, phrases: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return phrases.some((p) => lower.includes(p));
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

export type CapDetectionKind = Exclude<CapKind, "none" | "unavailable">;

export interface CapDetectionResult {
  readonly capKind: CapDetectionKind;
  /** `null` = unknown; never a guessed number (issue #62 AC). */
  readonly estimatedReset: IsoTimestamp | null;
  readonly detail: string;
}

/**
 * Resolve the reset instant from what the provider actually said: a header
 * (`Retry-After`/`retry-after-ms`/`x-ratelimit-reset` family) first, then a
 * `retry-after: N` mention in body text. `at` is the observation instant,
 * used to turn a delay-seconds figure into an absolute instant.
 */
export function resolveEstimatedReset(signal: ProviderErrorSignal, at: IsoTimestamp): IsoTimestamp | null {
  const headers = headerLikeFrom(signal.headers);
  const absoluteFromHeader = retryAfterDate(headers) ?? resetFromHeaders(headers);
  if (absoluteFromHeader !== null) return absoluteFromHeader;
  const delayMs = parseRetryAfterHeaderMs(headers) ?? retryAfterFromText(signal.bodyText);
  if (delayMs !== null) return new Date(Date.parse(at) + delayMs).toISOString() as IsoTimestamp;
  return null;
}

/**
 * Detect a provider-side cap (rate limit or quota exhaustion) from an HTTP
 * response signal, or `null` when the signal is not a cap at all (e.g. a
 * 5xx service failure, which is #26/#52's `service` category, not a cap).
 *
 * Distinguishing quota exhaustion from a rate limit: TypeSafe/most provider
 * APIs document only 429 for both (`docs/typesafe-api-reference.md` §7.1).
 * The conservative rule from that doc: a 429 whose body/headers *name* a
 * quota/account-level phrase, or that carries no `Retry-After` at all, reads
 * as `quota_exhausted` (long/unknown reset, surfaced rather than silently
 * retried); a 429 with an explicit short `Retry-After` reads as
 * `rate_limited`.
 */
export function detectProviderCap(signal: ProviderErrorSignal, at: IsoTimestamp): CapDetectionResult | null {
  const status = signal.httpStatus ?? null;
  const text = signal.bodyText ?? "";
  const headers = headerLikeFrom(signal.headers);
  const reset = resolveEstimatedReset(signal, at);

  const isQuotaPhrase = containsAny(text, QUOTA_EXHAUSTED_PHRASES);
  const isRateLimitPhrase = containsAny(text, RATE_LIMIT_PHRASES);
  const has429 = status === 429;
  const has402 = status === 402;

  if (!has429 && !has402 && !isQuotaPhrase && !isRateLimitPhrase) return null;

  if (has402 || isQuotaPhrase) {
    return {
      capKind: "quota_exhausted",
      estimatedReset: reset,
      detail: has402 ? "HTTP 402" : `quota phrase matched in body`,
    };
  }

  if (has429) {
    const hasExplicitRetryAfter = headers.get("retry-after") !== null || headers.get("retry-after-ms") !== null;
    if (hasExplicitRetryAfter) {
      return { capKind: "rate_limited", estimatedReset: reset, detail: "HTTP 429 with Retry-After" };
    }
    // No reset hint at all on a 429: conservative reading is an account-level
    // cap, per docs/typesafe-api-reference.md §7.1 "Conservative decision".
    return { capKind: "quota_exhausted", estimatedReset: reset, detail: "HTTP 429 with no Retry-After" };
  }

  // isRateLimitPhrase with no HTTP status (e.g. from stderr/stdout text).
  return { capKind: "rate_limited", estimatedReset: reset, detail: "rate-limit phrase matched in body" };
}

/** Build the `CapObservation` (#125's `availability.ts` shape) from a detection. */
export function toCapObservation(detection: CapDetectionResult, at: IsoTimestamp): CapObservation {
  return {
    capKind: detection.capKind,
    at,
    estimatedReset: detection.estimatedReset,
    detail: detection.detail,
  };
}

/**
 * A local budget reservation refusal (`BudgetExceededError`, #30's
 * `src/telemetry/ledger.ts`) becomes a `budget_cap` observation. Never a
 * clock-based reset: our own policy resets only when the user raises the
 * cap, so `estimatedReset` is always `null` here — callers that later widen
 * the cap must call `markAvailable` explicitly, this module never guesses.
 */
export function budgetCapObservation(detail: string, at: IsoTimestamp): CapObservation {
  return { capKind: "budget_cap", at, estimatedReset: null, detail };
}

/**
 * Structural (duck-typed) shape of `src/workflow/failure.ts`'s `QuotaEvent`
 * (#52). Not imported directly: `src/models/` does not depend on
 * `src/workflow/` (docs/adr/0002-source-layout.md) -- the workflow layer
 * calls into `src/models/`, not the reverse. Duplicated here only as a
 * structural type so `fromQuotaEvent` accepts the real thing without an
 * import edge.
 */
export interface QuotaEventLike {
  readonly kind: "quota";
  readonly providerId: string;
  readonly modelId: string;
  readonly retryAfterSeconds: number | null;
  readonly reason: string;
}

/**
 * Adapt a `#52` `QuotaEvent` (already route-attributed by `providerId` +
 * `modelId`) into a `CapObservation`. `retryAfterSeconds === null` reads as
 * `quota_exhausted` (conservative, per `docs/typesafe-api-reference.md`
 * section 7.1); a present value reads as `rate_limited` with that reset.
 */
export function fromQuotaEvent(event: QuotaEventLike, at: IsoTimestamp): CapObservation {
  if (event.retryAfterSeconds === null) {
    return { capKind: "quota_exhausted", at, estimatedReset: null, detail: event.reason };
  }
  const reset = new Date(Date.parse(at) + event.retryAfterSeconds * 1000).toISOString() as IsoTimestamp;
  return { capKind: "rate_limited", at, estimatedReset: reset, detail: event.reason };
}
