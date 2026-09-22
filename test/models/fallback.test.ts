/**
 * Tests for src/models/fallback.ts (issue #63; PLAN §3.D "Caps and fallback").
 *
 * AC: "All candidates capped → task paused(cap), phase paused, status shows
 *   earliest estimated reset."
 * AC: "Cap clears (fake clock) → auto-resume without user action."
 * AC: "Attempt record shows both models and the reason after a switch."
 */
import { describe, expect, it } from "vitest";
import {
  chooseFallback,
  earliestResetAmong,
  fallbackReasonFromCap,
  inDwell,
  isResumable,
  type FallbackAttemptView,
} from "../../src/models/fallback.ts";
import { RouteAvailabilityTable } from "../../src/models/availability.ts";
import { deriveRouteId } from "../../src/models/route.ts";
import { mergeCards } from "../../src/models/cards.ts";
import type { SelectionCandidate } from "../../src/models/select.ts";
import type { CatalogEntry } from "../../src/models/catalog.ts";
import type { ModelAllowlist, ModelRef } from "../../src/config/types.ts";
import type { TaskProfile } from "../../src/storage/records.ts";
import { MockJevTransport } from "../../src/jev/mock.ts";
import type { AskContext } from "../../src/decisions/ask.ts";

const MODEL = "jev-test";
const T0 = "2026-01-01T00:00:00.000Z";

function entry(id: string, provider: string): CatalogEntry {
  return {
    id: `${provider}/${id}` as CatalogEntry["id"],
    provider,
    name: id,
    routeId: deriveRouteId(provider, id),
    reasoning: true,
    thinkingLevelMap: "unknown",
    input: ["text"],
    contextWindow: "unknown",
    maxTokens: "unknown",
    cost: "unknown",
  };
}

function candidate(id: string, provider: string): SelectionCandidate {
  const e = entry(id, provider);
  return { ref: e.id, routeId: e.routeId, card: mergeCards(e, {}), entry: e };
}

const ALLOW_ALL: ModelAllowlist = { providers: [], models: [], pins: {} };

const PROFILE: TaskProfile = {
  domain: "backend",
  modalities: ["text"],
  reasoningDepth: 0.5,
  contextSize: 0.5,
  risk: "low",
};

function attempt(overrides: Partial<FallbackAttemptView> = {}): FallbackAttemptView {
  return {
    requestedModel: "acme/primary" as ModelRef,
    usedModel: "acme/primary" as ModelRef,
    taskProfile: PROFILE,
    pin: null,
    fallbackSince: null,
    ...overrides,
  };
}

function adequateMock(): AskContext {
  return {
    transport: new MockJevTransport({
      responder: (request) => ({
        kind: "ok",
        response: {
          model: MODEL,
          answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 0.9 }])),
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        requestId: "req",
        attempts: 1,
        elapsedMs: 1,
      }),
    }),
    model: MODEL,
  };
}

function inadequateMock(): AskContext {
  return {
    transport: new MockJevTransport({
      responder: (request) => ({
        kind: "ok",
        response: {
          model: MODEL,
          answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 0.1 }])),
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        requestId: "req",
        attempts: 1,
        elapsedMs: 1,
      }),
    }),
    model: MODEL,
  };
}

describe("fallbackReasonFromCap", () => {
  it("maps each cap kind to the matching FallbackReason", () => {
    expect(fallbackReasonFromCap("quota_exhausted")).toBe("quota_exhausted");
    expect(fallbackReasonFromCap("rate_limited")).toBe("rate_limited");
    expect(fallbackReasonFromCap("budget_cap")).toBe("budget_cap");
    expect(fallbackReasonFromCap("unavailable")).toBe("model_unavailable");
    expect(fallbackReasonFromCap("none")).toBeNull();
  });
});

describe("AC: all candidates capped -> pause with earliest estimated reset", () => {
  it("returns pause reason all_capped with the earliest reset among candidates", async () => {
    const c1 = candidate("primary", "acme");
    const c2 = candidate("sub", "acme");
    const table = new RouteAvailabilityTable();
    table.markCapped({ routeId: c1.routeId, providerId: "acme", modelId: "primary", ref: c1.ref }, {
      capKind: "quota_exhausted",
      at: T0,
      estimatedReset: "2026-01-01T00:30:00.000Z",
    });
    table.markCapped({ routeId: c2.routeId, providerId: "acme", modelId: "sub", ref: c2.ref }, {
      capKind: "rate_limited",
      at: T0,
      estimatedReset: "2026-01-01T00:10:00.000Z",
    });
    const result = await chooseFallback({
      ctx: adequateMock(),
      attempt: attempt(),
      candidates: [c1, c2],
      availability: table,
      now: T0,
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 0,
    });
    expect(result).toEqual({
      kind: "pause",
      reason: "all_capped",
      earliestReset: "2026-01-01T00:10:00.000Z",
      blocker: expect.any(String),
      watchRoutes: [c1.routeId, c2.routeId],
    });
  });
});

describe("AC: cap clears (fake clock) -> auto-resume without user action", () => {
  it("isResumable is false while capped and true once a watched route's reset passes", () => {
    const c1 = candidate("primary", "acme");
    const table = new RouteAvailabilityTable();
    table.markCapped({ routeId: c1.routeId, providerId: "acme", modelId: "primary", ref: c1.ref }, {
      capKind: "quota_exhausted",
      at: T0,
      estimatedReset: "2026-01-01T00:30:00.000Z",
    });
    expect(isResumable([c1.routeId], table, T0)).toBe(false);
    expect(isResumable([c1.routeId], table, "2026-01-01T00:15:00.000Z")).toBe(false);
    expect(isResumable([c1.routeId], table, "2026-01-01T00:30:00.000Z")).toBe(true);
  });

  it("chooseFallback resolves to unchanged once the primary clears (no cap on any candidate)", async () => {
    const c1 = candidate("primary", "acme");
    const table = new RouteAvailabilityTable();
    table.markAvailable({ routeId: c1.routeId, providerId: "acme", modelId: "primary", ref: c1.ref }, T0);
    const result = await chooseFallback({
      ctx: adequateMock(),
      attempt: attempt({ fallbackSince: null }),
      candidates: [c1],
      availability: table,
      now: T0,
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 0,
    });
    expect(result).toEqual({ kind: "unchanged" });
  });
});

describe("AC: Attempt record shows both models and the reason after a switch", () => {
  it("a switch from a capped primary carries requestedModel, usedModel and the cap-kind reason", async () => {
    const primary = candidate("primary", "acme");
    const sub = candidate("sub", "acme");
    const table = new RouteAvailabilityTable();
    table.markCapped({ routeId: primary.routeId, providerId: "acme", modelId: "primary", ref: primary.ref }, {
      capKind: "quota_exhausted",
      at: T0,
      estimatedReset: "2026-01-01T00:30:00.000Z",
    });
    table.markAvailable({ routeId: sub.routeId, providerId: "acme", modelId: "sub", ref: sub.ref }, T0);
    const result = await chooseFallback({
      ctx: adequateMock(),
      attempt: attempt(),
      candidates: [primary, sub],
      availability: table,
      now: T0,
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 0,
    });
    expect(result).toEqual({
      kind: "switch",
      requestedModel: "acme/primary",
      usedModel: "acme/sub",
      fallbackReason: "quota_exhausted",
      rationale: expect.any(String),
      decisionId: null,
    });
  });

  it("no Jev context: uses static order and the switch is still recorded with the cap reason", async () => {
    const primary = candidate("primary", "acme");
    const sub = candidate("sub", "acme");
    const table = new RouteAvailabilityTable();
    table.markCapped({ routeId: primary.routeId, providerId: "acme", modelId: "primary", ref: primary.ref }, {
      capKind: "rate_limited",
      at: T0,
      estimatedReset: "2026-01-01T00:05:00.000Z",
    });
    table.markAvailable({ routeId: sub.routeId, providerId: "acme", modelId: "sub", ref: sub.ref }, T0);
    const result = await chooseFallback({
      ctx: null,
      attempt: attempt(),
      candidates: [primary, sub],
      availability: table,
      now: T0,
      allowlist: ALLOW_ALL,
      staticOrder: ["acme/sub" as ModelRef],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 0,
    });
    expect(result).toEqual({
      kind: "switch",
      requestedModel: "acme/primary",
      usedModel: "acme/sub",
      fallbackReason: "rate_limited",
      rationale: expect.any(String),
      decisionId: null,
    });
  });
});

describe("no adequate substitute: Jev says none adequate -> pause, never degrade", () => {
  it("returns pause reason no_adequate when Jev finds nothing adequate", async () => {
    const primary = candidate("primary", "acme");
    const weak = candidate("weak", "acme");
    const table = new RouteAvailabilityTable();
    table.markCapped({ routeId: primary.routeId, providerId: "acme", modelId: "primary", ref: primary.ref }, {
      capKind: "quota_exhausted",
      at: T0,
      estimatedReset: null,
    });
    table.markAvailable({ routeId: weak.routeId, providerId: "acme", modelId: "weak", ref: weak.ref }, T0);
    const result = await chooseFallback({
      ctx: inadequateMock(),
      attempt: attempt(),
      candidates: [primary, weak],
      availability: table,
      now: T0,
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 0,
    });
    expect(result).toEqual({
      kind: "pause",
      reason: "no_adequate",
      earliestReset: null,
      blocker: expect.any(String),
      watchRoutes: [primary.routeId, weak.routeId],
    });
  });
});

describe("pinned model: never overridden by fallback without asking", () => {
  it("a capped pin pauses with reason pin_capped instead of substituting", async () => {
    const primary = candidate("primary", "acme");
    const sub = candidate("sub", "acme");
    const table = new RouteAvailabilityTable();
    table.markCapped({ routeId: primary.routeId, providerId: "acme", modelId: "primary", ref: primary.ref }, {
      capKind: "quota_exhausted",
      at: T0,
      estimatedReset: "2026-01-01T00:30:00.000Z",
    });
    table.markAvailable({ routeId: sub.routeId, providerId: "acme", modelId: "sub", ref: sub.ref }, T0);
    const result = await chooseFallback({
      ctx: adequateMock(),
      attempt: attempt({ pin: "acme/primary" as ModelRef }),
      candidates: [primary, sub],
      availability: table,
      now: T0,
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 0,
    });
    expect(result).toEqual({
      kind: "pause",
      reason: "pin_capped",
      earliestReset: "2026-01-01T00:30:00.000Z",
      blocker: expect.any(String),
      watchRoutes: [primary.routeId],
    });
  });

  it("a pin that is still eligible is left unchanged (selectModel honours it separately)", async () => {
    const primary = candidate("primary", "acme");
    const table = new RouteAvailabilityTable();
    table.markAvailable({ routeId: primary.routeId, providerId: "acme", modelId: "primary", ref: primary.ref }, T0);
    const result = await chooseFallback({
      ctx: adequateMock(),
      attempt: attempt({ pin: "acme/primary" as ModelRef }),
      candidates: [primary],
      availability: table,
      now: T0,
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 0,
    });
    expect(result).toEqual({ kind: "unchanged" });
  });
});

describe("more expensive substitute: prefer-wait-if-reset-within-N-minutes", () => {
  it("pauses instead of switching when the primary's reset is within the configured window", async () => {
    const primary = candidate("primary", "acme");
    const sub = candidate("sub", "acme");
    const table = new RouteAvailabilityTable();
    table.markCapped({ routeId: primary.routeId, providerId: "acme", modelId: "primary", ref: primary.ref }, {
      capKind: "rate_limited",
      at: T0,
      estimatedReset: "2026-01-01T00:03:00.000Z",
    });
    table.markAvailable({ routeId: sub.routeId, providerId: "acme", modelId: "sub", ref: sub.ref }, T0);
    const result = await chooseFallback({
      ctx: adequateMock(),
      attempt: attempt(),
      candidates: [primary, sub],
      availability: table,
      now: T0,
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 5,
    });
    expect(result).toEqual({
      kind: "pause",
      reason: "prefer_wait",
      earliestReset: "2026-01-01T00:03:00.000Z",
      blocker: expect.any(String),
      watchRoutes: [primary.routeId],
    });
  });

  it("switches when the reset is farther out than the prefer-wait window", async () => {
    const primary = candidate("primary", "acme");
    const sub = candidate("sub", "acme");
    const table = new RouteAvailabilityTable();
    table.markCapped({ routeId: primary.routeId, providerId: "acme", modelId: "primary", ref: primary.ref }, {
      capKind: "quota_exhausted",
      at: T0,
      estimatedReset: "2026-01-01T00:30:00.000Z",
    });
    table.markAvailable({ routeId: sub.routeId, providerId: "acme", modelId: "sub", ref: sub.ref }, T0);
    const result = await chooseFallback({
      ctx: adequateMock(),
      attempt: attempt(),
      candidates: [primary, sub],
      availability: table,
      now: T0,
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 5,
    });
    expect(result.kind).toBe("switch");
  });

  it("does not wait when a costOf comparator shows the substitute is cheaper or equal", async () => {
    const primary = candidate("primary", "acme");
    const sub = candidate("sub", "acme");
    const table = new RouteAvailabilityTable();
    table.markCapped({ routeId: primary.routeId, providerId: "acme", modelId: "primary", ref: primary.ref }, {
      capKind: "rate_limited",
      at: T0,
      estimatedReset: "2026-01-01T00:03:00.000Z",
    });
    table.markAvailable({ routeId: sub.routeId, providerId: "acme", modelId: "sub", ref: sub.ref }, T0);
    const result = await chooseFallback({
      ctx: adequateMock(),
      attempt: attempt(),
      candidates: [primary, sub],
      availability: table,
      now: T0,
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 5,
      costOf: (ref) => (ref === "acme/sub" ? 1 : 5),
    });
    expect(result.kind).toBe("switch");
  });
});

describe("anti-oscillation: minimum dwell on the fallback", () => {
  it("inDwell is true for remainder_of_task/phase as long as a fallback is in force", () => {
    expect(inDwell(attempt({ fallbackSince: T0 }), { dwell: "remainder_of_task", dwellMinutes: 0 }, "2026-01-01T05:00:00.000Z")).toBe(true);
    expect(inDwell(attempt({ fallbackSince: null }), { dwell: "remainder_of_task", dwellMinutes: 0 }, T0)).toBe(false);
  });

  it("inDwell with dwell=minutes expires after dwellMinutes", () => {
    const since = T0;
    expect(inDwell(attempt({ fallbackSince: since }), { dwell: "minutes", dwellMinutes: 30 }, "2026-01-01T00:10:00.000Z")).toBe(true);
    expect(inDwell(attempt({ fallbackSince: since }), { dwell: "minutes", dwellMinutes: 30 }, "2026-01-01T00:45:00.000Z")).toBe(false);
  });

  it("chooseFallback does not re-rank (does not flap) while dwell holds and the used model is still eligible", async () => {
    const primary = candidate("primary", "acme");
    const sub = candidate("sub", "acme");
    const table = new RouteAvailabilityTable();
    table.markAvailable({ routeId: primary.routeId, providerId: "acme", modelId: "primary", ref: primary.ref }, T0);
    table.markAvailable({ routeId: sub.routeId, providerId: "acme", modelId: "sub", ref: sub.ref }, T0);
    const result = await chooseFallback({
      ctx: adequateMock(),
      attempt: attempt({ usedModel: "acme/sub" as ModelRef, fallbackSince: T0 }),
      candidates: [primary, sub],
      availability: table,
      now: "2026-01-01T00:05:00.000Z",
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 0,
    });
    expect(result).toEqual({ kind: "unchanged" });
  });

  it("a cap on the currently used model forces a re-rank even mid-dwell", async () => {
    const primary = candidate("primary", "acme");
    const sub = candidate("sub", "acme");
    const weak = candidate("weak", "acme");
    const table = new RouteAvailabilityTable();
    table.markCapped({ routeId: primary.routeId, providerId: "acme", modelId: "primary", ref: primary.ref }, {
      capKind: "quota_exhausted",
      at: T0,
      estimatedReset: null,
    });
    table.markCapped({ routeId: sub.routeId, providerId: "acme", modelId: "sub", ref: sub.ref }, {
      capKind: "rate_limited",
      at: "2026-01-01T00:05:00.000Z",
      estimatedReset: null,
    });
    table.markAvailable({ routeId: weak.routeId, providerId: "acme", modelId: "weak", ref: weak.ref }, T0);
    const result = await chooseFallback({
      ctx: adequateMock(),
      attempt: attempt({ usedModel: "acme/sub" as ModelRef, fallbackSince: T0 }),
      candidates: [primary, sub, weak],
      availability: table,
      now: "2026-01-01T00:06:00.000Z",
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 0,
    });
    expect(result.kind).toBe("switch");
    if (result.kind === "switch") expect(result.usedModel).toBe("acme/weak");
  });
});

describe("earliestResetAmong", () => {
  it("returns the earliest non-null reset, or null when none set", () => {
    const c1 = candidate("a", "acme");
    const c2 = candidate("b", "acme");
    const table = new RouteAvailabilityTable();
    table.markCapped({ routeId: c1.routeId, providerId: "acme", modelId: "a", ref: c1.ref }, {
      capKind: "quota_exhausted",
      at: T0,
      estimatedReset: null,
    });
    table.markCapped({ routeId: c2.routeId, providerId: "acme", modelId: "b", ref: c2.ref }, {
      capKind: "rate_limited",
      at: T0,
      estimatedReset: "2026-01-01T00:20:00.000Z",
    });
    expect(earliestResetAmong([c1, c2], table)).toBe("2026-01-01T00:20:00.000Z");
    expect(earliestResetAmong([c1], table)).toBeNull();
  });
});
