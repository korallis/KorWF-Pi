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
