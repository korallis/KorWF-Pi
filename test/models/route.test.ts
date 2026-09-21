/**
 * Tests for src/models/route.ts (issue #125).
 *
 * The author's environment has one proxy provider and cannot reproduce the
 * two-account case, so the two-route scenario lives here (PLAN §2.4,
 * PRD §3.4 method note). Test names reference the acceptance criterion.
 */
import { describe, it, expect } from "vitest";
import {
  ROUTE_ID_PREFIX,
  deriveRouteId,
  makeRoute,
  routesFromRegistry,
  routesForModel,
  hasMultiRouteModels,
  routeLabel,
} from "../../src/models/route.ts";

// Provider keys are user-chosen names (Pi docs/models.md); these are fixtures, not defaults.
const WORK = "vendor-work";
const PERSONAL = "vendor-personal";
const MODEL = "example-model-5";

describe("deriveRouteId (AC: two providers exposing the same model id are tracked as two distinct routes)", () => {
  it("yields different ids for the same model id under two providers", () => {
    expect(deriveRouteId(WORK, MODEL)).not.toBe(deriveRouteId(PERSONAL, MODEL));
  });

  it("is deterministic for the same pair", () => {
    expect(deriveRouteId(WORK, MODEL)).toBe(deriveRouteId(WORK, MODEL));
  });

  it("is opaque: does not embed the provider or model id", () => {
    const id = deriveRouteId(WORK, MODEL);
    expect(id.startsWith(ROUTE_ID_PREFIX)).toBe(true);
    expect(id).not.toContain(WORK);
    expect(id).not.toContain(MODEL);
    expect(id).toMatch(/^r1_[0-9a-f]{32}$/);
  });

  it("length-prefixes components so boundary shifts cannot collide", () => {
    expect(deriveRouteId("ab", "c")).not.toBe(deriveRouteId("a", "bc"));
    expect(deriveRouteId("a/b", "c")).not.toBe(deriveRouteId("a", "b/c"));
  });

  it("rejects empty components", () => {
    expect(() => deriveRouteId("", MODEL)).toThrow();
    expect(() => deriveRouteId(WORK, "")).toThrow();
  });
});

describe("routesFromRegistry (AC: two providers exposing the same model id are tracked as two distinct routes)", () => {
  const registry = [
    { provider: WORK, id: MODEL },
    { provider: PERSONAL, id: MODEL },
    { provider: WORK, id: "other-model" },
  ];

  it("produces one route per (provider, model) pair", () => {
    const routes = routesFromRegistry(registry);
    expect(routes).toHaveLength(3);
    expect(new Set(routes.map((r) => r.routeId)).size).toBe(3);
  });

  it("groups both routes under the shared model id", () => {
    const routes = routesFromRegistry(registry);
    expect(routesForModel(routes, MODEL).map((r) => r.providerId).sort()).toEqual([PERSONAL, WORK].sort());
    expect(hasMultiRouteModels(routes)).toBe(true);
  });

  it("collapses duplicate registry entries", () => {
    expect(routesFromRegistry([...registry, { provider: WORK, id: MODEL }])).toHaveLength(3);
  });
});

describe("single-provider user (AC: a single-provider user sees no behavioural change)", () => {
  it("has exactly one route per model and no multi-route note", () => {
    const routes = routesFromRegistry([
      { provider: "my-proxy", id: MODEL },
      { provider: "my-proxy", id: "other-model" },
    ]);
    expect(routes).toHaveLength(2);
    expect(hasMultiRouteModels(routes)).toBe(false);
    expect(routes.map((r) => r.ref)).toEqual([`my-proxy/${MODEL}`, "my-proxy/other-model"]);
  });
});

describe("routeLabel (AC: route identity is visible in /korwf models / /korwf status output)", () => {
  it("disambiguates two routes to the same model id", () => {
    const a = routeLabel(makeRoute(WORK, MODEL));
    const b = routeLabel(makeRoute(PERSONAL, MODEL));
    expect(a).not.toBe(b);
    expect(a).toContain(`${WORK}/${MODEL}`);
    expect(b).toContain(`${PERSONAL}/${MODEL}`);
    expect(a).toMatch(/\[[0-9a-f]{8}\]$/);
  });
});
