/**
 * `src/jev/resilience.ts` (issue #26). Every test uses vitest fake timers
 * and the mock transport — no real sleeping, no live API calls.
 *
 * Test names reference the acceptance criterion they exercise:
 *   AC1 a hung transport is abandoned at the deadline; typed timeout returned
 *   AC2 breaker opens after N failures; disabled-mode results while open
 *   AC3 aborting mid-retry stops further attempts within one tick
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  withDeadline,
  withRetry,
  CircuitBreaker,
  CircuitBreakerRegistry,
  DeadlineExceededError,
  RetryAbortedError,
  wrapWithCircuitBreaker,
} from "../../../src/jev/resilience.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import { JevTransportError, type JevEvaluateResult, type SystemOneRequest } from "../../../src/jev/transport.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const REQUEST: SystemOneRequest = {
  state: "s",
  model: "jev-1.13.0",
  questions: { q: { type: "noul", instructions: "?" } },
};

function ok(): JevEvaluateResult {
  return { kind: "ok", response: { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }, requestId: "r", attempts: 1, elapsedMs: 0 };
}

function errorResult(code: JevTransportError["code"], retryable = false): JevEvaluateResult {
  return {
    kind: "error",
    error: new JevTransportError(code, `mock error ${code}`, { retryable }),
    attempts: 1,
    elapsedMs: 0,
  };
}

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {
    /* deliberately hangs */
  });
}

describe("wrapWithCircuitBreaker: end-to-end over the mock transport", () => {
  it("AC1: a transport that never resolves is abandoned at the deadline as a typed jev.unavailable error", async () => {
    const mock = new MockJevTransport({ responder: () => neverSettles<JevEvaluateResult>() });
    const wrapped = wrapWithCircuitBreaker(mock, { deadlineMs: 1000, maxRetries: 0 });
    const promise = wrapped.evaluate(REQUEST);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("jev.unavailable");
  });

  it("AC2: breaker opens after N failures and returns disabled-mode results while open", async () => {
    const mock = new MockJevTransport({
      responder: () => errorResult("jev.unavailable", true),
    });
    const wrapped = wrapWithCircuitBreaker(mock, {
      deadlineMs: 1000,
      maxRetries: 0,
      failureThreshold: 2,
      resetTimeoutMs: 60_000,
    });
    await wrapped.evaluate(REQUEST);
    await wrapped.evaluate(REQUEST);
    expect(wrapped.breakerStatus().state).toBe("open");
    const result = await wrapped.evaluate(REQUEST);
    expect(result.kind).toBe("disabled");
    // No underlying call was made for the third evaluate: breaker short-circuited.
    expect(mock.calls).toHaveLength(2);
  });

  it("a successful call keeps the breaker closed and forwards the ok result", async () => {
    const mock = new MockJevTransport({ responses: [ok()] });
    const wrapped = wrapWithCircuitBreaker(mock, { deadlineMs: 1000, maxRetries: 0 });
    const result = await wrapped.evaluate(REQUEST);
    expect(result.kind).toBe("ok");
    expect(wrapped.breakerStatus().state).toBe("closed");
  });

  it("retries a retryable error up to maxRetries then reports it", async () => {
    const mock = new MockJevTransport({
      responder: () => errorResult("jev.overloaded", true),
    });
    const wrapped = wrapWithCircuitBreaker(mock, {
      deadlineMs: 60_000,
      maxRetries: 2,
      failureThreshold: 100,
    });
    const promise = wrapped.evaluate(REQUEST);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.kind).toBe("error");
    expect(mock.calls).toHaveLength(3);
  });

  it("does not retry a non-retryable error (jev.auth)", async () => {
    const mock = new MockJevTransport({ responses: [errorResult("jev.auth", false)] });
    const wrapped = wrapWithCircuitBreaker(mock, { deadlineMs: 1000, maxRetries: 3 });
    const result = await wrapped.evaluate(REQUEST);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("jev.auth");
    expect(mock.calls).toHaveLength(1);
  });

  it("AC3: aborting mid-retry (during backoff) stops the second attempt from ever starting", async () => {
    const controller = new AbortController();
    const mock = new MockJevTransport({ responder: () => errorResult("jev.overloaded", true) });
    const wrapped = wrapWithCircuitBreaker(mock, {
      deadlineMs: 60_000,
      maxRetries: 3,
      failureThreshold: 100,
    });
    const promise = wrapped.evaluate(REQUEST, { signal: controller.signal });
    // Let the first attempt run and fail; it is now sleeping out the backoff.
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.calls).toHaveLength(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("jev.cancelled");
    // No second attempt was made after the abort, even though maxRetries allowed one.
    expect(mock.calls).toHaveLength(1);
  });

  it("cancellation does not trip the breaker", async () => {
    const controller = new AbortController();
    const mock = new MockJevTransport({ responder: () => errorResult("jev.overloaded", true) });
    const wrapped = wrapWithCircuitBreaker(mock, {
      deadlineMs: 60_000,
      maxRetries: 3,
      failureThreshold: 1,
    });
    const promise = wrapped.evaluate(REQUEST, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await promise;
    expect(wrapped.breakerStatus().state).toBe("closed");
  });

  it("a cancelled half-open probe does not close or reopen the breaker", async () => {
    let now = 0;
    const controller = new AbortController();
    const mock = new MockJevTransport({ responder: () => errorResult("jev.unavailable", false) });
    const wrapped = wrapWithCircuitBreaker(mock, {
      deadlineMs: 60_000,
      maxRetries: 0,
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: () => now,
    });
    // Trip the breaker, then let it become half-open.
    await wrapped.evaluate(REQUEST);
    expect(wrapped.breakerStatus().state).toBe("open");
    now = 1000;

    // A realistic transport observes the signal it is given (like
    // `HttpJevTransport` does via `fetch`); this responder mirrors that.
    mock.setResponder(
      (_req, opts) =>
        new Promise<JevEvaluateResult>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(errorResult("jev.cancelled", false)), { once: true });
        }),
    );
    const promise = wrapped.evaluate(REQUEST, { signal: controller.signal });
    expect(wrapped.breakerStatus().state).toBe("half_open");
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("jev.cancelled");
    // Cancelling the probe neither closes it (still needs a real success) nor
    // reopens it (cancellation is not a failure) — it stays half-open, so the
    // next call gets a fresh probe attempt rather than being locked out.
    expect(wrapped.breakerStatus().state).toBe("half_open");
  });
});

describe("CircuitBreakerRegistry: per host", () => {
  it("a failing host's breaker trips independently of a healthy host on the same registry", () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeoutMs: 1000 });
    const bad = registry.get("bad.example.com");
    const good = registry.get("good.example.com");
    bad.onFailure();
    bad.onFailure();
    expect(bad.status().state).toBe("open");
    expect(good.status().state).toBe("closed");
    expect(good.canProceed()).toBe(true);
  });

  it("the same host key returns the same breaker instance across calls", () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeoutMs: 1000 });
    const a = registry.get("host-a");
    a.onFailure();
    const aAgain = registry.get("host-a");
    expect(aAgain.status().failures).toBe(1);
  });

  it("snapshot() exposes every seen host's state for a future /korwf status", () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 1, resetTimeoutMs: 1000 });
    registry.get("host-a").onFailure();
    registry.get("host-b");
    const snapshot = registry.snapshot();
    expect(Object.keys(snapshot).sort()).toEqual(["host-a", "host-b"]);
    expect(snapshot["host-a"]!.state).toBe("open");
    expect(snapshot["host-b"]!.state).toBe("closed");
  });

  it("a host never requested is absent from the snapshot", () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 1, resetTimeoutMs: 1000 });
    expect(registry.snapshot()).toEqual({});
  });
});

describe("wrapWithCircuitBreaker: per-host isolation and status exposure over the mock transport", () => {
  it("two transports on different hosts, sharing a registry, fail independently", async () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeoutMs: 60_000 });
    const badMock = new MockJevTransport({ responder: () => errorResult("jev.unavailable", true) });
    const goodMock = new MockJevTransport({ responses: [ok()] });
    const bad = wrapWithCircuitBreaker(badMock, { deadlineMs: 1000, maxRetries: 0, host: "bad.example.com", registry });
    const good = wrapWithCircuitBreaker(goodMock, { deadlineMs: 1000, maxRetries: 0, host: "good.example.com", registry });

    await bad.evaluate(REQUEST);
    await bad.evaluate(REQUEST);
    expect(bad.breakerStatus().state).toBe("open");

    // The good host's own evaluate still runs: its breaker was never touched.
    const result = await good.evaluate(REQUEST);
    expect(result.kind).toBe("ok");
    expect(good.breakerStatus().state).toBe("closed");
    expect(goodMock.calls).toHaveLength(1);
  });

  it("defaults the host key to the transport's baseUrl when it exposes one", async () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    const mockWithBaseUrl = Object.assign(
      new MockJevTransport({ responses: [errorResult("jev.unavailable", true)] }),
      { baseUrl: "https://a.example.com" },
    );
    const wrapped = wrapWithCircuitBreaker(mockWithBaseUrl, { deadlineMs: 1000, maxRetries: 0, registry });
    await wrapped.evaluate(REQUEST);
    expect(Object.keys(registry.snapshot())).toEqual(["a.example.com"]);
  });

  it("exposes breaker state via breakerStatusByHost() for a future /korwf status", async () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    const badMock = new MockJevTransport({ responses: [errorResult("jev.unavailable", true)] });
    const goodMock = new MockJevTransport({ responses: [ok()] });
    const bad = wrapWithCircuitBreaker(badMock, { deadlineMs: 1000, maxRetries: 0, host: "bad-host", registry });
    const good = wrapWithCircuitBreaker(goodMock, { deadlineMs: 1000, maxRetries: 0, host: "good-host", registry });
    await bad.evaluate(REQUEST);
    await good.evaluate(REQUEST);

    const snapshot = bad.breakerStatusByHost();
    expect(snapshot["bad-host"]!.state).toBe("open");
    expect(snapshot["bad-host"]!.failures).toBe(1);
    expect(snapshot["good-host"]!.state).toBe("closed");
    // The other wrapper, sharing the same registry, sees the identical snapshot.
    expect(good.breakerStatusByHost()).toEqual(snapshot);
  });
});

describe("CircuitBreaker: closed/open/half-open", () => {
  it("stays closed below the failure threshold", () => {
    const b = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    b.onFailure();
    b.onFailure();
    expect(b.status().state).toBe("closed");
    expect(b.canProceed()).toBe(true);
  });

  it("AC2: opens after N consecutive failures and blocks further calls", () => {
    const b = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    b.onFailure();
    b.onFailure();
    b.onFailure();
    expect(b.status().state).toBe("open");
    expect(b.canProceed()).toBe(false);
  });

  it("a success resets the failure count and keeps it closed", () => {
    const b = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    b.onFailure();
    b.onFailure();
    b.onSuccess();
    b.onFailure();
    b.onFailure();
    expect(b.status().state).toBe("closed");
  });

  it("transitions to half-open after resetTimeoutMs and allows one probe", () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: () => now });
    b.onFailure();
    expect(b.canProceed()).toBe(false);
    now = 1000;
    expect(b.canProceed()).toBe(true);
    expect(b.status().state).toBe("half_open");
  });

  it("a half-open probe success closes the breaker", () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: () => now });
    b.onFailure();
    now = 1000;
    expect(b.canProceed()).toBe(true);
    b.beforeCall();
    b.onSuccess();
    expect(b.status().state).toBe("closed");
  });

  it("a half-open probe failure reopens the breaker", () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: () => now });
    b.onFailure();
    now = 1000;
    expect(b.canProceed()).toBe(true);
    b.beforeCall();
    b.onFailure();
    expect(b.status().state).toBe("open");
    expect(b.canProceed()).toBe(false);
  });

  it("limits concurrent half-open probes to halfOpenMaxCalls", () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, halfOpenMaxCalls: 1, now: () => now });
    b.onFailure();
    now = 1000;
    expect(b.canProceed()).toBe(true);
    b.beforeCall();
    // A second probe is refused while the first is still in flight.
    expect(b.canProceed()).toBe(false);
  });
});

describe("AC3: aborting mid-retry stops further attempts within one tick", () => {
  it("stops retrying once the signal is aborted, without waiting out the backoff", async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = withRetry<string>(
      async () => {
        calls++;
        throw new Error(`fail ${calls}`);
      },
      () => true,
      { maxAttempts: 5, idempotent: true, signal: controller.signal, baseDelayMs: 1000 },
    );
    const assertion = expect(promise).rejects.toBeInstanceOf(RetryAbortedError);
    // Let the first attempt run and start its backoff sleep.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    // No further attempt was made after the abort.
    expect(calls).toBe(1);
  });

  it("an already-aborted signal prevents even the first attempt", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const promise = withRetry<string>(
      async () => {
        calls++;
        return "never";
      },
      () => true,
      { maxAttempts: 3, idempotent: true, signal: controller.signal },
    );
    await expect(promise).rejects.toBeInstanceOf(RetryAbortedError);
    expect(calls).toBe(0);
  });

  it("idempotent: false makes exactly one attempt regardless of maxAttempts", async () => {
    let calls = 0;
    const promise = withRetry<string>(
      async () => {
        calls++;
        throw new Error("boom");
      },
      () => true,
      { maxAttempts: 5, idempotent: false },
    );
    await expect(promise).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("retries up to maxAttempts then throws the last error", async () => {
    let calls = 0;
    const promise = withRetry<string>(
      async () => {
        calls++;
        throw new Error(`fail ${calls}`);
      },
      () => true,
      { maxAttempts: 3, idempotent: true, baseDelayMs: 10, random: () => 0 },
    );
    const assertion = expect(promise).rejects.toThrow("fail 3");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(calls).toBe(3);
  });

  it("succeeds without retrying once run resolves", async () => {
    let calls = 0;
    const result = await withRetry<string>(
      async () => {
        calls++;
        return "ok";
      },
      () => true,
      { maxAttempts: 5, idempotent: true },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });
});

describe("AC1: withDeadline abandons a hung run and returns a typed timeout", () => {
  it("resolves normally when run finishes before the deadline", async () => {
    const promise = withDeadline(async () => "done", { deadlineMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toBe("done");
  });

  it("a run that never settles is abandoned at the deadline with DeadlineExceededError", async () => {
    const promise = withDeadline(() => neverSettles<string>(), { deadlineMs: 1000 });
    const assertion = expect(promise).rejects.toBeInstanceOf(DeadlineExceededError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("aborts the signal passed to run when the deadline fires", async () => {
    let seenSignal: AbortSignal | undefined;
    const promise = withDeadline((signal) => {
      seenSignal = signal;
      return neverSettles<string>();
    }, { deadlineMs: 500 });
    const assertion = expect(promise).rejects.toBeInstanceOf(DeadlineExceededError);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(seenSignal?.aborted).toBe(true);
  });

  it("does not abandon a run that finishes exactly as the deadline fires", async () => {
    const promise = withDeadline(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("just in time"), 100)),
      { deadlineMs: 1000 },
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBe("just in time");
  });
});
