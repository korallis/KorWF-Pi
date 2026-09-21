/**
 * Tests for src/models/availability.ts (issue #125).
 *
 * Covers the correctness bug the issue exists for: a cap on one provider
 * account must not remove the same model id under another provider, and
 * must not make the workflow believe all candidates are capped
 * (PLAN §3.D "All candidates capped"). Test names reference the criterion.
 */
import { describe, it, expect } from "vitest";
import { makeRoute, routesFromRegistry } from "../../src/models/route.ts";
import { RouteAvailabilityTable, selectRoute, rankRoutes } from "../../src/models/availability.ts";

const WORK = "vendor-work";
const PERSONAL = "vendor-personal";
const MODEL = "example-model-5";
const T0 = "2026-09-21T10:00:00.000Z";
const T1 = "2026-09-21T10:05:00.000Z";
const RESET = "2026-09-21T11:00:00.000Z";
const AFTER_RESET = "2026-09-21T11:00:01.000Z";

const work = makeRoute(WORK, MODEL);
const personal = makeRoute(PERSONAL, MODEL);

describe("RouteAvailabilityTable.markCapped (AC: a quota cap detected on one route does not mark the other route capped)", () => {
  it("caps only the route that produced the 429", () => {
    const table = new RouteAvailabilityTable();
    table.markCapped(work, { capKind: "rate_limited", at: T0, estimatedReset: RESET });
    expect(table.isEligible(work.routeId, T1)).toBe(false);
    expect(table.isEligible(personal.routeId, T1)).toBe(true);
    expect(table.get(personal.routeId)).toBeUndefined();
  });

  it("records provider and model components alongside the routeId", () => {
    const table = new RouteAvailabilityTable();
    table.markCapped(work, { capKind: "quota_exhausted", at: T0, estimatedReset: null, detail: "429" });
    const row = table.get(work.routeId)!;
    expect(row).toMatchObject({ routeId: work.routeId, providerId: WORK, modelId: MODEL, capKind: "quota_exhausted", detectedAt: T0 });
    expect(row.lastProbe).toEqual({ at: T0, result: "capped", detail: "429" });
  });

  it("a cap with no reset estimate stays in force until markAvailable", () => {
    const table = new RouteAvailabilityTable();
    table.markCapped(work, { capKind: "quota_exhausted", at: T0, estimatedReset: null });
    expect(table.isEligible(work.routeId, AFTER_RESET)).toBe(false);
    table.markAvailable(work, AFTER_RESET);
    expect(table.isEligible(work.routeId, AFTER_RESET)).toBe(true);
    expect(table.get(work.routeId)?.capKind).toBe("none");
  });

  it("a cap with a reset estimate clears once the estimate has passed (PLAN §3.D recovery)", () => {
    const table = new RouteAvailabilityTable();
    table.markCapped(work, { capKind: "rate_limited", at: T0, estimatedReset: RESET });
    expect(table.isEligible(work.routeId, RESET)).toBe(true);
    expect(table.isEligible(work.routeId, T1)).toBe(false);
  });
});

describe("selectRoute (AC: the healthy route remains eligible — selection still succeeds after capping one of two routes for the same model id)", () => {
  const routes = routesFromRegistry([
    { provider: WORK, id: MODEL },
    { provider: PERSONAL, id: MODEL },
  ]);

  it("selects the first route when nothing is capped", () => {
    const sel = selectRoute(routes, new RouteAvailabilityTable(), T1);
    expect(sel).toMatchObject({ kind: "selected", route: { routeId: work.routeId }, rank: 0 });
  });

  it("falls through to the second provider's route for the same model id after the first is capped", () => {
    const table = new RouteAvailabilityTable().markCapped(work, { capKind: "rate_limited", at: T0, estimatedReset: RESET });
    const sel = selectRoute(routes, table, T1);
    expect(sel.kind).toBe("selected");
    if (sel.kind === "selected") {
      expect(sel.route.routeId).toBe(personal.routeId);
      expect(sel.route.modelId).toBe(MODEL);
      expect(sel.route.providerId).toBe(PERSONAL);
    }
  });

  it("reports all_capped only when every route is capped, with the earliest reset", () => {
    const table = new RouteAvailabilityTable()
      .markCapped(work, { capKind: "rate_limited", at: T0, estimatedReset: RESET })
      .markCapped(personal, { capKind: "quota_exhausted", at: T0, estimatedReset: AFTER_RESET });
    expect(selectRoute(routes, table, T1)).toEqual({ kind: "all_capped", earliestReset: RESET });
    expect(selectRoute(routes, table, RESET)).toMatchObject({ kind: "selected", route: { routeId: work.routeId } });
  });

  it("returns no_candidates for an empty candidate list", () => {
    expect(selectRoute([], new RouteAvailabilityTable(), T1)).toEqual({ kind: "no_candidates" });
  });
});

describe("selectRoute with a single provider (AC: a single-provider user sees no behavioural change)", () => {
  it("one route per model; capping it yields all_capped exactly as before", () => {
    const routes = routesFromRegistry([{ provider: "my-proxy", id: MODEL }]);
    const only = routes[0]!;
    const table = new RouteAvailabilityTable();
    expect(selectRoute(routes, table, T1)).toMatchObject({ kind: "selected", route: { routeId: only.routeId } });
    table.markCapped(only, { capKind: "rate_limited", at: T0, estimatedReset: RESET });
    expect(selectRoute(routes, table, T1)).toEqual({ kind: "all_capped", earliestReset: RESET });
  });
});

describe("rankRoutes (AC: selection and fallback rank routes; works with Jev disabled)", () => {
  it("honours fallback.staticOrder by provider/model ref, then registry order", () => {
    const other = makeRoute(WORK, "other-model");
    const ranked = rankRoutes([work, other, personal], [`${PERSONAL}/${MODEL}`]);
    expect(ranked.map((r) => r.ref)).toEqual([personal.ref, work.ref, other.ref]);
  });

  it("is deterministic with no static order (registry order)", () => {
    expect(rankRoutes([personal, work], []).map((r) => r.ref)).toEqual([personal.ref, work.ref]);
  });
});
