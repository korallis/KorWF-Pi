/**
 * JevTransport interface and shared wire types (issue #24; ADR 0003; PLAN §7).
 *
 * This is the seam every Jev question goes through. Product code depends only
 * on `JevTransport`; `HttpJevTransport` (`http.ts`), `MockJevTransport`
 * (`mock.ts`) and `DisabledJevTransport` (`disabled.ts`) implement it.
 * `createJev` (`index.ts`) picks the right one from config and never throws
 * for a missing key.
 *
 * Types here are the *raw wire* shapes from `docs/typesafe-api-reference.md`
 * §2–§3, validated by a separate layer (issue #25). This module does not
 * validate; it moves bytes.
 */

// ---------------------------------------------------------------------------
// request
// ---------------------------------------------------------------------------

export type JevState = string | Readonly<Record<string, unknown>> | readonly unknown[];

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: JevState;
  readonly criteria?: { readonly true?: JevState; readonly false?: JevState };
}

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: JevState;
  readonly criteria: Readonly<Record<string, JevState | null>>;
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: JevState;
  readonly criteria: readonly JevState[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** The one POST body shape (`docs/typesafe-api-reference.md` §2). */
export interface SystemOneRequest {
  readonly state: JevState;
  readonly model: string;
  readonly questions: Readonly<Record<string, JevQuestion>>;
}

// ---------------------------------------------------------------------------
// response (raw wire form; unvalidated)
// ---------------------------------------------------------------------------

export interface SystemOneUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/** Raw JSON as received. Unknown/extra fields are preserved, not stripped. */
export interface SystemOneResponseRaw {
  readonly model: unknown;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly usage: unknown;
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/**
 * Adapter-level error codes (`docs/typesafe-api-reference.md` §7.1, ADR 0003
 * rule 6). Provider-agnostic names so `src/models/` can react without
 * knowing about TypeSafe specifically.
 */
export type JevErrorCode =
  | "jev.rate_limited"
  | "jev.quota_exhausted"
  | "jev.overloaded"
  | "jev.unavailable"
  | "jev.auth"
  | "jev.bad_request"
  | "jev.malformed_response"
  | "jev.cancelled"
  | "jev.disabled"
  | "jev.unknown";

/**
 * A transport-level failure. Never carries a credential: `body` and
 * `message` are expected to already be redacted-safe by the time they reach
 * a caller (the HTTP transport applies the redactor before constructing
 * this).
 */
export class JevTransportError extends Error {
  readonly code: JevErrorCode;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;

  constructor(
    code: JevErrorCode,
    message: string,
    opts: {
      readonly status?: number | null;
      readonly requestId?: string | null;
      readonly retryAfterMs?: number | null;
      readonly retryable?: boolean;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "JevTransportError";
    this.code = code;
    this.status = opts.status ?? null;
    this.requestId = opts.requestId ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.retryable = opts.retryable ?? false;
  }
}

// ---------------------------------------------------------------------------
// evaluate() result
// ---------------------------------------------------------------------------

export interface JevEvaluateOk {
  readonly kind: "ok";
  readonly response: SystemOneResponseRaw;
  readonly requestId: string | null;
  readonly attempts: number;
  readonly elapsedMs: number;
}

export interface JevEvaluateError {
  readonly kind: "error";
  readonly error: JevTransportError;
  readonly attempts: number;
  readonly elapsedMs: number;
}

/**
 * `DisabledJevTransport`'s result for every call: no key, no attempt, no
 * measurable latency (ADR 0007, PLAN §3.J). Kept distinct from `"error"` so
 * callers never treat "no key" as a failure to retry or alert on.
 */
export interface JevEvaluateDisabled {
  readonly kind: "disabled";
  /** One clear, credential-free sentence (from `resolveJevKey`/config). */
  readonly message: string;
}

export type JevEvaluateResult = JevEvaluateOk | JevEvaluateError | JevEvaluateDisabled;

export interface JevEvaluateOptions {
  /** Combined with the transport's own deadline timer. */
  readonly signal?: AbortSignal;
  /** Per-decision deadline in ms, including retries. Overrides config default when given. */
  readonly deadlineMs?: number;
  /** Correlates this call across logs/traces; generated when omitted. */
  readonly requestId?: string;
}

// ---------------------------------------------------------------------------
// the seam
// ---------------------------------------------------------------------------

/**
 * Everything product code needs from Jev. `evaluate()` never throws: every
 * outcome — success, error, disabled, cancelled — is a `JevEvaluateResult`.
 * `ping()` is a cheap reachability probe used by health checks; it shares the
 * same never-throw contract.
 */
export interface JevTransport {
  /** Human-readable name for logs/diagnostics ("http", "mock", "disabled"). */
  readonly kind: "http" | "mock" | "disabled";
  evaluate(request: SystemOneRequest, options?: JevEvaluateOptions): Promise<JevEvaluateResult>;
  ping(options?: JevEvaluateOptions): Promise<JevEvaluateResult>;
}

/**
 * Convenience wrappers matching the three question types 1:1. Product code
 * may call `evaluate` directly with a multi-question batch, or use these for
 * a single-question call (`docs/typesafe-api-reference.md` §2.1–2.3).
 */
export function noulQuestion(instructions: JevState, criteria?: NoulQuestion["criteria"]): NoulQuestion {
  return criteria === undefined ? { type: "noul", instructions } : { type: "noul", instructions, criteria };
}

export function choiceQuestion(
  instructions: JevState,
  criteria: Readonly<Record<string, JevState | null>>,
): ChoiceQuestion {
  return { type: "choice", instructions, criteria };
}

export function scoreQuestion(instructions: JevState, criteria: readonly JevState[]): ScoreQuestion {
  return { type: "score", instructions, criteria };
}
