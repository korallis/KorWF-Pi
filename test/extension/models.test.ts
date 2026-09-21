/**
 * Tests for src/extension/commands/models.ts (issue #125).
 *
 * AC: "Route identity is visible in /korwf models / /korwf status output."
 */
import { describe, it, expect } from "vitest";
import { modelsMessage, statusMessage, renderRouteLines } from "../../src/extension/commands/models.ts";
import { makeRoute } from "../../src/models/route.ts";
import { RouteAvailabilityTable } from "../../src/models/availability.ts";

const MODEL = "example-model-5";
const T0 = "2026-09-21T10:00:00.000Z";
const T1 = "2026-09-21T10:05:00.000Z";
const two = [
  { provider: "vendor-work", id: MODEL },
  { provider: "vendor-personal", id: MODEL },
];

describe("/korwf models (AC: route identity is visible in /korwf models output)", () => {
  it("lists two distinguishable entries for the same model id under two providers", () => {
    const lines = renderRouteLines({ models: two, now: T1 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toBe(lines[1]);
    expect(lines[0]).toContain(`vendor-work/${MODEL} [`);
    expect(lines[1]).toContain(`vendor-personal/${MODEL} [`);
    expect(modelsMessage({ models: two, now: T1 })).toContain("separate routes with independent caps");
  });

  it("shows the cap on one route only", () => {
    const work = makeRoute("vendor-work", MODEL);
    const table = new RouteAvailabilityTable().markCapped(work, { capKind: "rate_limited", at: T0, estimatedReset: null });
    const [a, b] = renderRouteLines({ models: two, availability: table, now: T1 });
    expect(a).toMatch(/capped \(rate_limited, reset unknown\)$/);
    expect(b).toMatch(/available$/);
  });

  it("single-provider output has no multi-route note (AC: no behavioural change for a single-provider user)", () => {
    const msg = modelsMessage({ models: [{ provider: "my-proxy", id: MODEL }], now: T1 });
    expect(msg).toContain("1 route");
    expect(msg).not.toContain("separate routes");
  });

  it("never renders sensitive registry fields", () => {
    const models = [{ provider: "p", id: MODEL, baseUrl: "https://secret.example/v1", apiKey: "sk-secret" }];
    const msg = modelsMessage({ models, now: T1 });
    expect(msg).not.toContain("secret");
  });
});

describe("/korwf status (AC: route identity is visible in /korwf status output)", () => {
  it("counts routes and names the capped one by route", () => {
    const work = makeRoute("vendor-work", MODEL);
    const table = new RouteAvailabilityTable().markCapped(work, { capKind: "quota_exhausted", at: T0, estimatedReset: null });
    const msg = statusMessage({ models: two, availability: table, now: T1 });
    expect(msg).toContain("2 routes, 1 capped");
    expect(msg).toContain(`vendor-work/${MODEL} [`);
    expect(msg).not.toContain(`vendor-personal/${MODEL} [`);
  });
});
