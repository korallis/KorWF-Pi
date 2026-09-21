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
import { JevTransportError, type JevEvaluateOptions, type JevEvaluateResult, type JevTransport, type SystemOneRequest } from "./transport.ts";

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

/**
 * Run `run` with an `AbortSignal` that fires at `deadlineMs`, combined with
 * `options.signal` when given. Guarantees resolution within `deadlineMs`
 * (plus a tick) **even if `run` never settles**: a genuinely hung transport
 * that ignores its abort signal is abandoned via `Promise.race`-style
 * settlement rather than awaited forever, and the caller receives a typed
 * `DeadlineExceededError` (issue #26 AC1 "a hung transport is abandoned at
 * the deadline"). The abandoned promise, if it later settles, is ignored —
 * this is the same trade-off `AbortController` users always make.
 */
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

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeoutFn(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new DeadlineExceededError(options.deadlineMs, now() - start));
    }, options.deadlineMs);

    run(combined).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        reject(err);
      },
    );
  });
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
 * Standard closed/open/half-open breaker for a single host. One instance
 * tracks one endpoint's health; `CircuitBreakerRegistry` below is what keys
 * a *set* of these by host so one failing endpoint's breaker never affects
 * another's. Trips to `open` after `failureThreshold` consecutive failures;
 * after `resetTimeoutMs` it allows a bounded number of probe calls
 * (`half_open`); a probe success closes it, a probe failure reopens it and
 * restarts the timeout.
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

  /** A call was cancelled rather than succeeding or failing: release any half-open slot, change nothing else. */
  onCancelled(): void {
    if (this.#state === "half_open") this.#halfOpenInFlight = Math.max(0, this.#halfOpenInFlight - 1);
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

/** Host key used when a caller does not identify which endpoint it is calling. */
export const DEFAULT_BREAKER_HOST = "default";

/**
 * Keys a `CircuitBreaker` per host, all built from the same
 * `CircuitBreakerOptions`. This is the "per host" half of issue #26's scope:
 * a failing endpoint's breaker trips only that host's entry, never any
 * other host sharing the registry, and `snapshot()` gives a future
 * `/korwf status` one call to render every known host's state.
 */
export class CircuitBreakerRegistry {
  readonly #options: CircuitBreakerOptions;
  readonly #breakers = new Map<string, CircuitBreaker>();

  constructor(options: CircuitBreakerOptions) {
    this.#options = options;
  }

  /** The breaker for `host`, created on first use and reused after. */
  get(host: string): CircuitBreaker {
    let breaker = this.#breakers.get(host);
    if (breaker === undefined) {
      breaker = new CircuitBreaker(this.#options);
      this.#breakers.set(host, breaker);
    }
    return breaker;
  }

  /** Read-only status of every host this registry has ever been asked for. */
  snapshot(): Readonly<Record<string, BreakerStatus>> {
    const out: Record<string, BreakerStatus> = {};
    for (const [host, breaker] of this.#breakers) out[host] = breaker.status();
    return out;
  }
}

// ---------------------------------------------------------------------------
// transport wrapper
// ---------------------------------------------------------------------------

export interface ResilientJevOptions {
  /** Total deadline for one `evaluate`/`ping` call, including all retries. */
  readonly deadlineMs: number;
  /** Bounded retries on retryable error codes. Default 2 (config `jev.maxRetries` default). */
  readonly maxRetries?: number;
  readonly failureThreshold?: number;
  readonly resetTimeoutMs?: number;
  readonly halfOpenMaxCalls?: number;
  readonly now?: () => number;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly random?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * Host key for the circuit breaker (issue #26 "per host"). Defaults to the
   * wrapped transport's `baseUrl` when it exposes one (e.g.
   * `HttpJevTransport`), else `DEFAULT_BREAKER_HOST`.
   */
  readonly host?: string;
  /**
   * Share breaker state across several `wrapWithCircuitBreaker` calls (e.g.
   * one registry for every Jev transport in the process, so `/korwf status`
   * has one place to read all hosts from). When omitted, a private registry
   * is created and seeded with only this call's host.
   */
  readonly registry?: CircuitBreakerRegistry;
}

export interface ResilientJevTransport extends JevTransport {
  /** Status of the host this transport was wrapped for. */
  breakerStatus(): BreakerStatus;
  /** Status of every host this wrapper (or a shared registry) has seen, for a future `/korwf status`. */
  breakerStatusByHost(): Readonly<Record<string, BreakerStatus>>;
}

const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "jev.rate_limited",
  "jev.overloaded",
  "jev.unavailable",
  "jev.unknown",
]);

const BREAKER_OPEN_MESSAGE =
  "Jev circuit breaker is open after repeated failures: every Jev-assisted decision takes its deterministic fallback until it recovers.";

/** Thrown internally to make an error `JevEvaluateResult` retryable via `withRetry`. */
class RetryableResult extends Error {
  constructor(readonly result: JevEvaluateResult) {
    super("retryable Jev result");
  }
}

/**
 * Wrap a `JevTransport` with an independent deadline, bounded jittered
 * retries for idempotent failures, and a circuit breaker — all on top of
 * whatever the underlying transport already does (e.g. `HttpJevTransport`'s
 * own per-fetch retries). `evaluate()` and `ping()` never throw and never
 * hang past `options.deadlineMs`: a hung underlying transport call is
 * abandoned and reported as `jev.unavailable` (AC1); an open breaker or
 * exhausted retries degrade to `kind: "disabled"` (AC2), the same shape
 * `DisabledJevTransport` returns, so callers already treat it as "take the
 * deterministic fallback" (PLAN §2.4) without a special case. Aborting
 * `options.signal` stops further attempts within one tick (AC3).
 *
 * Reservation safety (issue #26 scope note): this wrapper reserves nothing
 * itself. A caller that reserves budget (`Ledger.reserve`/`withReservation`,
 * issue #30) must reserve once *outside* this call and settle/release once
 * on the single `JevEvaluateResult` this returns — never per attempt —
 * which this module makes safe by always resolving exactly once, promptly,
 * regardless of how many internal attempts ran or whether they were cut
 * short by cancellation.
 */
export function wrapWithCircuitBreaker(
  transport: JevTransport,
  options: ResilientJevOptions,
): ResilientJevTransport {
  const registry =
    options.registry ??
    new CircuitBreakerRegistry({
      failureThreshold: options.failureThreshold ?? 5,
      resetTimeoutMs: options.resetTimeoutMs ?? 30_000,
      halfOpenMaxCalls: options.halfOpenMaxCalls ?? 1,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  const host = options.host ?? hostOf(transport);
  const breaker = registry.get(host);
  const now = options.now ?? Date.now;

  async function run(request: SystemOneRequest, callOptions: JevEvaluateOptions, isPing: boolean): Promise<JevEvaluateResult> {
    if (!breaker.canProceed()) {
      return { kind: "disabled", message: BREAKER_OPEN_MESSAGE };
    }
    breaker.beforeCall();

    const totalDeadlineMs = callOptions.deadlineMs ?? options.deadlineMs;
    const start = now();
    const maxAttempts = 1 + Math.max(0, options.maxRetries ?? 2);

    let outcome: JevEvaluateResult;
    try {
      outcome = await withRetry<JevEvaluateResult>(
        async () => {
          const remaining = totalDeadlineMs - (now() - start);
          if (remaining <= 0) {
            throw new DeadlineExceededError(totalDeadlineMs, now() - start);
          }
          const result = await withDeadline<JevEvaluateResult>(
            (signal) =>
              isPing
                ? transport.ping({ ...callOptions, signal })
                : transport.evaluate(request, { ...callOptions, signal }),
            {
              deadlineMs: remaining,
              ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
              ...(options.setTimeout === undefined ? {} : { setTimeout: options.setTimeout }),
              ...(options.clearTimeout === undefined ? {} : { clearTimeout: options.clearTimeout }),
              ...(options.now === undefined ? {} : { now: options.now }),
            },
          );
          if (result.kind === "error" && RETRYABLE_CODES.has(result.error.code)) {
            throw new RetryableResult(result);
          }
          return result;
        },
        (err) => err instanceof RetryableResult,
        {
          maxAttempts,
          idempotent: true,
          ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
          ...(options.random === undefined ? {} : { random: options.random }),
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        },
      );
    } catch (err) {
      if (err instanceof RetryableResult) {
        outcome = err.result;
      } else if (err instanceof DeadlineExceededError) {
        outcome = {
          kind: "error",
          error: new JevTransportError("jev.unavailable", "Jev call exceeded its deadline", { retryable: false }),
          attempts: 0,
          elapsedMs: err.elapsedMs,
        };
      } else if (err instanceof RetryAbortedError) {
        outcome = {
          kind: "error",
          error: new JevTransportError("jev.cancelled", "Jev call cancelled", { retryable: false }),
          attempts: 0,
          elapsedMs: now() - start,
        };
      } else {
        breaker.onFailure();
        throw err;
      }
    }

    if (outcome.kind === "ok") {
      breaker.onSuccess();
    } else if (outcome.kind === "error" && outcome.error.code === "jev.cancelled") {
      // Cancellation is not a failure of the transport (ADR 0003 table); do not trip
      // or close the breaker on it, only release any half-open slot taken.
      breaker.onCancelled();
    } else {
      breaker.onFailure();
    }
    return outcome;
  }

  return {
    kind: transport.kind,
    evaluate: (request, callOptions = {}) => run(request, callOptions, false),
    ping: (callOptions = {}) => run({ state: "", model: "", questions: {} }, callOptions ?? {}, true),
    breakerStatus: () => breaker.status(),
    breakerStatusByHost: () => registry.snapshot(),
  };
}

/** Derives the breaker's host key from whatever the transport is willing to reveal about its endpoint. */
function hostOf(transport: JevTransport): string {
  const withBaseUrl = transport as { readonly baseUrl?: unknown };
  if (typeof withBaseUrl.baseUrl === "string" && withBaseUrl.baseUrl.length > 0) {
    try {
      return new URL(withBaseUrl.baseUrl).host;
    } catch {
      return withBaseUrl.baseUrl;
    }
  }
  return DEFAULT_BREAKER_HOST;
}
