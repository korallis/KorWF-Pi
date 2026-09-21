/**
 * Tests for the provider-rename decision, ADR 0011 (issue #125).
 *
 * AC: "The rename behaviour is implemented, documented, and covered by a
 * test." Decision (a): a renamed provider key is a new route; the old
 * route's availability and outcome history are not carried over, and the
 * orphaned availability row is pruned.
 */
import { describe, it, expect } from "vitest";
import { makeRoute, routesFromRegistry, deriveRouteId } from "../../src/models/route.ts";
import { RouteAvailabilityTable, selectRoute } from "../../src/models/availability.ts";
import { summariseOutcomesByRoute } from "../../src/models/outcomes.ts";

const MODEL = "example-model-5";
const OLD_KEY = "vendor-work";
const NEW_KEY = "work-vendor";
const T0 = "2026-09-21T10:00:00.000Z";
const T1 = "2026-09-21T10:05:00.000Z";

describe("provider rename (AC: rename behaviour implemented and tested — ADR 0011 option (a))", () => {
  it("a renamed provider key derives a different routeId", () => {
    expect(deriveRouteId(OLD_KEY, MODEL)).not.toBe(deriveRouteId(NEW_KEY, MODEL));
  });

  it("a cap recorded under the old key does not follow the model to the new key", () => {
    const before = routesFromRegistry([{ provider: OLD_KEY, id: MODEL }]);
    const table = new RouteAvailabilityTable().markCapped(before[0]!, { capKind: "quota_exhausted", at: T0, estimatedReset: null });
    expect(selectRoute(before, table, T1).kind).toBe("all_capped");

    // User renames the provider key in models.json; Pi's registry now exposes the new key only.
    const after = routesFromRegistry([{ provider: NEW_KEY, id: MODEL }]);
    const sel = selectRoute(after, table, T1);
    expect(sel).toMatchObject({ kind: "selected", route: { providerId: NEW_KEY, modelId: MODEL } });
  });

  it("prune drops the orphaned availability row and reports it (documented failure mode)", () => {
    const old = makeRoute(OLD_KEY, MODEL);
    const table = new RouteAvailabilityTable().markCapped(old, { capKind: "rate_limited", at: T0, estimatedReset: null });
    const after = routesFromRegistry([{ provider: NEW_KEY, id: MODEL }]);
    const dropped = table.prune(after.map((r) => r.routeId));
    expect(dropped).toEqual([old.routeId]);
    expect(table.get(old.routeId)).toBeUndefined();
    expect(table.snapshot()).toEqual([]);
  });

  it("outcome history under the old key is not attributed to the new route", () => {
    const old = makeRoute(OLD_KEY, MODEL);
    const renamed = makeRoute(NEW_KEY, MODEL);
    const summary = summariseOutcomesByRoute([
      { routeId: old.routeId, result: "failed" },
      { routeId: old.routeId, result: "failed" },
    ]);
    expect(summary.get(old.routeId)?.successRate).toBe(0);
    expect(summary.get(renamed.routeId)).toBeUndefined();
  });

  it("swapping two keys swaps nothing: neither new route inherits the other's cap", () => {
    const a = makeRoute("acct-a", MODEL);
    const b = makeRoute("acct-b", MODEL);
    const table = new RouteAvailabilityTable().markCapped(a, { capKind: "rate_limited", at: T0, estimatedReset: null });
    // Same ids after a swap — identity is by key, so a is still a and still capped; b still clear.
    expect(table.isEligible(a.routeId, T1)).toBe(false);
    expect(table.isEligible(b.routeId, T1)).toBe(true);
  });
});
