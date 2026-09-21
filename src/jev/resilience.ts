/**
 * Cancellation, deadlines, bounded retries and circuit breaking for the Jev
 * transport (issue #26; PLAN §8 Stage 2 exit "failures cannot hang Pi",
 * PLAN §3.G "no blind retry of side effects").
 *
 * Extends #24 (`src/jev/transport.ts`) and #30 (`src/telemetry/ledger.ts`);
 * redefines neither. `HttpJevTransport` already bounds one `evaluate()` call
 * with its own deadline + retries; this module adds a second, independent
 * safety net (a transport can hang or misbehave regardless) plus a circuit
 * breaker that degrades every call to the same `disabled` result product
 * code already treats as "take the deterministic fallback" (PLAN §2.4).
 */
import type { JevEvaluateOptions, JevEvaluateResult, JevTransport, SystemOneRequest } from "./transport.ts";

// ---------------------------------------------------------------------------
// deadline
// ---------------------------------------------------------------------------

export class DeadlineExceededError extends Error {
  readonly deadlineMs: number;
  readonly elapsedMs: number;

  constructor(deadlineMs: number, elapsedMs: number) {
    super(`Deadline of ${deadlineMs}ms exceeded after ${elapsedMs}ms`);
    this.name = "DeadlineExceededError";
    this.deadlineMs = deadlineMs;
    this.elapsedMs = elapsedMs;
  }
}

export interface WithDeadlineOptions {
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  /** Injectable for tests; defaults to real timers. */
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly now?: () => number;
}

export async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: WithDeadlineOptions,
): Promise<T> {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly idempotent: boolean;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
  readonly signal?: AbortSignal;
  readonly random?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class RetryAbortedError extends Error {
  constructor() {
    super("Retry aborted by signal");
    this.name = "RetryAbortedError";
  }
}

export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  isRetryable: (error: unknown, attempt: number) => boolean,
  options: RetryOptions,
): Promise<T> {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// circuit breaker
// ---------------------------------------------------------------------------

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerStatus {
  readonly state: BreakerState;
  readonly failures: number;
  readonly openedAt: number | null;
  readonly nextAttemptAt: number | null;
}

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  readonly halfOpenMaxCalls?: number;
  readonly now?: () => number;
}

export class CircuitBreaker {
  constructor(_options: CircuitBreakerOptions) {
    throw new Error("not implemented");
  }
}

// ---------------------------------------------------------------------------
// transport wrapper
// ---------------------------------------------------------------------------

export interface ResilientJevOptions {
  readonly key: string;
  readonly deadlineMs: number;
  readonly failureThreshold?: number;
  readonly resetTimeoutMs?: number;
  readonly halfOpenMaxCalls?: number;
  readonly now?: () => number;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

export interface ResilientJevTransport extends JevTransport {
  breakerStatus(): BreakerStatus;
}

export function wrapWithCircuitBreaker(
  _transport: JevTransport,
  _options: ResilientJevOptions,
): ResilientJevTransport {
  throw new Error("not implemented");
}
