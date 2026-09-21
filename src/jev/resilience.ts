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
  const setTimeoutFn = options.setTimeout ?? setTimeout;
  const clearTimeoutFn = options.clearTimeout ?? clearTimeout;
  const now = options.now ?? Date.now;
  const start = now();

  const controller = new AbortController();
  const signals = [controller.signal, ...(options.signal ? [options.signal] : [])];
  const combined = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

  let timedOut = false;
  const timer = setTimeoutFn(() => {
    timedOut = true;
    controller.abort();
  }, options.deadlineMs);

  try {
    return await run(combined);
  } catch (err) {
    if (timedOut) {
      throw new DeadlineExceededError(options.deadlineMs, now() - start);
    }
    throw err;
  } finally {
    clearTimeoutFn(timer);
  }
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

const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 5_000;
const DEFAULT_JITTER_RATIO = 0.25;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterRatio: number,
  random: () => number,
): number {
  const base = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  const jitter = base * jitterRatio * random();
  return base + jitter;
}

/**
 * Retry `run` while `isRetryable` says so, up to `maxAttempts` total
 * attempts (the first try plus `maxAttempts - 1` retries), with jittered
 * exponential backoff. `options.idempotent` is a documentation-and-caller
 * contract: PLAN §3.G forbids blind retry of side effects, so callers must
 * only pass `idempotent: true` for calls safe to repeat (Jev `evaluate` is
 * read-only from the workflow's point of view). When `idempotent` is false
 * this function makes exactly one attempt regardless of `maxAttempts`.
 *
 * Aborting `options.signal` stops further attempts within one tick: the
 * in-flight `run` is responsible for observing the signal itself (it is
 * passed through unchanged to the caller's own deadline/cancellation
 * plumbing); this function additionally refuses to start a new attempt or a
 * new sleep once the signal is aborted, and cuts short an in-progress sleep
 * immediately.
 */
export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  isRetryable: (error: unknown, attempt: number) => boolean,
  options: RetryOptions,
): Promise<T> {
  const maxAttempts = options.idempotent ? Math.max(1, options.maxAttempts) : 1;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;

  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw new RetryAbortedError();
    try {
      return await run(attempt);
    } catch (err) {
      if (signal?.aborted) throw new RetryAbortedError();
      const nextAttempt = attempt + 1;
      if (nextAttempt >= maxAttempts || !isRetryable(err, attempt)) throw err;
      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs, jitterRatio, random);
      await sleep(delay, signal ?? new AbortController().signal);
      if (signal?.aborted) throw new RetryAbortedError();
      attempt = nextAttempt;
    }
  }
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

/**
 * Standard closed/open/half-open breaker, per host (one instance per Jev
 * base URL / transport). Trips to `open` after `failureThreshold`
 * consecutive failures; after `resetTimeoutMs` it allows a bounded number of
 * probe calls (`half_open`); a probe success closes it, a probe failure
 * reopens it and restarts the timeout.
 *
 * Success/failure are reported by the caller via `onSuccess`/`onFailure`
 * after `beforeCall` grants permission — this class does not itself know how
 * to run a call, so it composes with any transport.
 */
export class CircuitBreaker {
  readonly #failureThreshold: number;
  readonly #resetTimeoutMs: number;
  readonly #halfOpenMaxCalls: number;
  readonly #now: () => number;

  #state: BreakerState = "closed";
  #failures = 0;
  #openedAt: number | null = null;
  #halfOpenInFlight = 0;

  constructor(options: CircuitBreakerOptions) {
    this.#failureThreshold = options.failureThreshold;
    this.#resetTimeoutMs = options.resetTimeoutMs;
    this.#halfOpenMaxCalls = options.halfOpenMaxCalls ?? 1;
    this.#now = options.now ?? Date.now;
  }

  status(): BreakerStatus {
    this.#maybeTransitionToHalfOpen();
    return {
      state: this.#state,
      failures: this.#failures,
      openedAt: this.#openedAt,
      nextAttemptAt: this.#openedAt === null ? null : this.#openedAt + this.#resetTimeoutMs,
    };
  }

  /** May a call proceed right now? Also performs the open->half_open transition. */
  canProceed(): boolean {
    this.#maybeTransitionToHalfOpen();
    if (this.#state === "closed") return true;
    if (this.#state === "half_open") return this.#halfOpenInFlight < this.#halfOpenMaxCalls;
    return false;
  }

  /** Reserve a half-open probe slot. Call only after `canProceed()` returned true. */
  beforeCall(): void {
    this.#maybeTransitionToHalfOpen();
    if (this.#state === "half_open") this.#halfOpenInFlight += 1;
  }

  onSuccess(): void {
    if (this.#state === "half_open") this.#halfOpenInFlight = Math.max(0, this.#halfOpenInFlight - 1);
    this.#state = "closed";
    this.#failures = 0;
    this.#openedAt = null;
  }

  onFailure(): void {
    if (this.#state === "half_open") {
      this.#halfOpenInFlight = Math.max(0, this.#halfOpenInFlight - 1);
      this.#trip();
      return;
    }
    this.#failures += 1;
    if (this.#failures >= this.#failureThreshold) this.#trip();
  }

  #trip(): void {
    this.#state = "open";
    this.#openedAt = this.#now();
    this.#halfOpenInFlight = 0;
  }

  #maybeTransitionToHalfOpen(): void {
    if (this.#state !== "open" || this.#openedAt === null) return;
    if (this.#now() - this.#openedAt >= this.#resetTimeoutMs) {
      this.#state = "half_open";
      this.#halfOpenInFlight = 0;
    }
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
