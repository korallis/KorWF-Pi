/**
 * Tests for src/models/cap-detect.ts (issue #62).
 *
 * Fixture errors for 429 with retry-after, quota text, and budget exceeded
 * each produce the right cap kind and reset estimate (AC1). `isAvailable`
 * (via RouteAvailabilityTable.isEligible) flips back after the estimated
 * reset using a fake clock, never a real sleep (AC2). A cap detected on one
 * route must not mark the same model id capped on another route (#125
 * amendment AC).
 */
import { describe, it, expect } from "vitest";
import { makeRoute } from "../../src/models/route.ts";
import { RouteAvailabilityTable } from "../../src/models/availability.ts";
import {
  detectProviderCap,
  toCapObservation,
  budgetCapObservation,
  resolveEstimatedReset,
  fromQuotaEvent,
} from "../../src/models/cap-detect.ts";

const T0 = "2026-09-22T10:00:00.000Z";

function headers(rec: Record<string, string>) {
  return { get: (name: string) => rec[name] ?? rec[name.toLowerCase()] ?? null };
}

describe("detectProviderCap (AC1: fixture errors produce the right cap kind and reset estimate)", () => {
  it("429 with retry-after seconds header \u2192 rate_limited with reset = now + retry-after", () => {
    const result = detectProviderCap({ httpStatus: 429, headers: headers({ "retry-after": "30" }) }, T0);
    expect(result).not.toBeNull();
    expect(result!.capKind).toBe("rate_limited");
    expect(result!.estimatedReset).toBe("2026-09-22T10:00:30.000Z");
  });

  it("429 with retry-after-ms header \u2192 rate_limited with reset from ms", () => {
    const result = detectProviderCap({ httpStatus: 429, headers: headers({ "retry-after-ms": "5000" }) }, T0);
    expect(result!.capKind).toBe("rate_limited");
    expect(result!.estimatedReset).toBe("2026-09-22T10:00:05.000Z");
  });

  it("429 with no retry-after at all \u2192 quota_exhausted, reset unknown (conservative reading)", () => {
    const result = detectProviderCap({ httpStatus: 429, bodyText: "Too many requests" }, T0);
    expect(result!.capKind).toBe("quota_exhausted");
    expect(result!.estimatedReset).toBeNull();
  });

  it("quota text in body \u2192 quota_exhausted regardless of status", () => {
    const result = detectProviderCap({ httpStatus: 429, bodyText: "Monthly usage limit exceeded for this account" }, T0);
    expect(result!.capKind).toBe("quota_exhausted");
  });

  it("HTTP 402 \u2192 quota_exhausted", () => {
    const result = detectProviderCap({ httpStatus: 402 }, T0);
    expect(result!.capKind).toBe("quota_exhausted");
    expect(result!.detail).toContain("402");
  });

  it("a 5xx service failure is not a cap at all \u2192 null", () => {
    expect(detectProviderCap({ httpStatus: 503, bodyText: "internal server error" }, T0)).toBeNull();
  });

  it("where nothing is stated about reset, records unknown (null) rather than guessing", () => {
    const reset = resolveEstimatedReset({ httpStatus: 429 }, T0);
    expect(reset).toBeNull();
  });

  it("a retry-after mention in body text (no header) still resolves a reset", () => {
    const reset = resolveEstimatedReset({ bodyText: "retry-after: 12" }, T0);
    expect(reset).toBe("2026-09-22T10:00:12.000Z");
  });
});

describe("budgetCapObservation (AC1: budget exceeded produces budget_cap with no clock-based reset)", () => {
  it("budget_cap never carries an estimated reset \u2014 it resets when the user raises the cap, not on a clock", () => {
    const obs = budgetCapObservation("workflow.spendUsd cap exceeded", T0);
    expect(obs.capKind).toBe("budget_cap");
    expect(obs.estimatedReset).toBeNull();
    expect(obs.at).toBe(T0);
  });
});

describe("end-to-end into RouteAvailabilityTable (AC2: isAvailable flips back after the estimated reset, fake clock only)", () => {
  it("a 429 with retry-after caps the route, then a fake clock advance past the reset makes it eligible again", () => {
    const route = makeRoute("vendor-work", "example-model-5");
    const table = new RouteAvailabilityTable();
    const detection = detectProviderCap({ httpStatus: 429, headers: headers({ "retry-after": "60" }) }, T0)!;
    table.markCapped(route, toCapObservation(detection, T0));

    expect(table.isEligible(route.routeId, T0)).toBe(false);

    const justBeforeReset = "2026-09-22T10:00:59.999Z";
    expect(table.isEligible(route.routeId, justBeforeReset)).toBe(false);

    // Fake clock: advance `now` past the estimated reset, no real sleep.
    const atReset = "2026-09-22T10:01:00.000Z";
    expect(table.isEligible(route.routeId, atReset)).toBe(true);
  });

  it("a quota_exhausted cap with unknown reset never flips back on its own \u2014 only markAvailable clears it", () => {
    const route = makeRoute("vendor-work", "example-model-5");
    const table = new RouteAvailabilityTable();
    const detection = detectProviderCap({ httpStatus: 429 }, T0)!;
    table.markCapped(route, toCapObservation(detection, T0));

    const farFuture = "2027-01-01T00:00:00.000Z";
    expect(table.isEligible(route.routeId, farFuture)).toBe(false);
    table.markAvailable(route, farFuture);
    expect(table.isEligible(route.routeId, farFuture)).toBe(true);
  });
});

describe("cap attribution is per-route, not per model id (#125 amendment AC)", () => {
  it("a 429 detected against one provider's route does not cap the same model id under a second provider", () => {
    const workRoute = makeRoute("vendor-work", "example-model-5");
    const personalRoute = makeRoute("vendor-personal", "example-model-5");
    const table = new RouteAvailabilityTable();

    const detection = detectProviderCap({ httpStatus: 429, headers: headers({ "retry-after": "30" }) }, T0)!;
    table.markCapped(workRoute, toCapObservation(detection, T0));

    expect(table.isEligible(workRoute.routeId, T0)).toBe(false);
    expect(table.isEligible(personalRoute.routeId, T0)).toBe(true);
    expect(table.get(personalRoute.routeId)).toBeUndefined();
  });
});

describe("fromQuotaEvent (integration seam with #52 FailureClassification quota events)", () => {
  it("null retryAfterSeconds -> quota_exhausted with unknown reset", () => {
    const obs = fromQuotaEvent({ kind: "quota", providerId: "vendor-work", modelId: "m", retryAfterSeconds: null, reason: "HTTP 429" }, T0);
    expect(obs.capKind).toBe("quota_exhausted");
    expect(obs.estimatedReset).toBeNull();
  });

  it("present retryAfterSeconds -> rate_limited with computed reset", () => {
    const obs = fromQuotaEvent({ kind: "quota", providerId: "vendor-work", modelId: "m", retryAfterSeconds: 15, reason: "HTTP 429" }, T0);
    expect(obs.capKind).toBe("rate_limited");
    expect(obs.estimatedReset).toBe("2026-09-22T10:00:15.000Z");
  });
});
