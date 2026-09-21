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
