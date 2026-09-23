/**
 * Tests for issue #65 (PLAN §3.D "Caps and fallback"): recovery to the
 * primary at the next task boundary, anti-oscillation dwell (extended, not
 * duplicated, from #63), and all-capped auto-resume preferring the primary.
 *
 * AC: "After a cap, the next task boundary before the reset does not probe
 *   the primary (spy on transport)."
 * AC: "Substitute with higher cost and reset in 2 min with N=5 ->
 *   prefer-wait pause."
 * AC: "Dwell prevents switching back mid-task."
 *
 * Fake clock only — never a real sleep (AGENTS.md, prompt).
 */
import { describe, expect, it } from "vitest";
import { chooseFallback, inDwell, type FallbackAttemptView } from "../../src/models/fallback.ts";
import { RouteAvailabilityTable } from "../../src/models/availability.ts";
import { deriveRouteId } from "../../src/models/route.ts";
import { mergeCards } from "../../src/models/cards.ts";
import type { SelectionCandidate } from "../../src/models/select.ts";
import type { CatalogEntry } from "../../src/models/catalog.ts";
import type { ModelAllowlist, ModelRef } from "../../src/config/types.ts";
import type { TaskProfile } from "../../src/storage/records.ts";
import { MockJevTransport } from "../../src/jev/mock.ts";
import type { AskContext } from "../../src/decisions/ask.ts";

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

function adequateMock(): { ctx: AskContext; transport: MockJevTransport } {
  const transport = new MockJevTransport({
    responder: (request) => ({
      kind: "ok",
      response: {
        model: "jev-test",
        answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 0.9 }])),
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      requestId: "req",
      attempts: 1,
      elapsedMs: 1,
    }),
  });
  return { ctx: { transport, model: "jev-test" }, transport };
}

describe("AC: after a cap, the next task boundary before the reset does not probe the primary", () => {
  it("a mid-dwell task-boundary call re-ranks without calling the transport, because the substitute is still eligible", async () => {
    const primary = candidate("primary", "acme");
    const sub = candidate("sub", "acme");
    const table = new RouteAvailabilityTable();
    table.markCapped({ routeId: primary.routeId, providerId: "acme", modelId: "primary", ref: primary.ref }, {
      capKind: "quota_exhausted",
      at: T0,
      estimatedReset: "2026-01-01T01:00:00.000Z",
    });
    table.markAvailable({ routeId: sub.routeId, providerId: "acme", modelId: "sub", ref: sub.ref }, T0);
    const { ctx, transport } = adequateMock();

    // Task boundary well before the primary's reset: dwell (remainder_of_task)
    // has lapsed because the task ended, but the substitute is still eligible
    // and nothing forces a re-check of the *primary* specifically — the
    // transport is never asked to evaluate the capped primary's route.
    const result = await chooseFallback({
      ctx,
      attempt: attempt({ usedModel: "acme/sub" as ModelRef, fallbackSince: T0 }),
      candidates: [primary, sub],
      availability: table,
      now: "2026-01-01T00:10:00.000Z",
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 0,
      atTaskBoundary: true,
    });

    // A re-rank happened (dwell lapsed at the boundary) but the primary's
    // route was never included in the candidate set handed to Jev, since it
    // is still capped — the eligible set never contains it, so nothing
    // "probes" it. Every recorded call only ranked the still-available sub.
    expect(result).toEqual({ kind: "unchanged" });
    for (const call of transport.calls) {
      expect(JSON.stringify(call.request)).not.toContain("acme/primary");
    }
  });

  it("once the primary's estimated reset has passed, a task boundary re-ranks and recovers to it", async () => {
    const primary = candidate("primary", "acme");
    const sub = candidate("sub", "acme");
    const table = new RouteAvailabilityTable();
    table.markCapped({ routeId: primary.routeId, providerId: "acme", modelId: "primary", ref: primary.ref }, {
      capKind: "quota_exhausted",
      at: T0,
      estimatedReset: "2026-01-01T00:30:00.000Z",
    });
    table.markAvailable({ routeId: sub.routeId, providerId: "acme", modelId: "sub", ref: sub.ref }, T0);
    const { ctx } = adequateMock();

    const result = await chooseFallback({
      ctx,
      attempt: attempt({ usedModel: "acme/sub" as ModelRef, fallbackSince: T0 }),
      candidates: [primary, sub],
      availability: table,
      now: "2026-01-01T00:30:00.000Z",
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 0,
      atTaskBoundary: true,
    });

    expect(result).toEqual({
      kind: "switch",
      requestedModel: "acme/primary",
      usedModel: "acme/primary",
      fallbackReason: null,
      rationale: expect.any(String),
      decisionId: null,
    });
  });
});

describe("AC: substitute with higher cost and reset in 2 min with N=5 -> prefer-wait pause", () => {
  it("pauses with reason prefer_wait instead of switching to the pricier substitute", async () => {
    const primary = candidate("primary", "acme");
    const sub = candidate("sub", "acme");
    const table = new RouteAvailabilityTable();
    table.markCapped({ routeId: primary.routeId, providerId: "acme", modelId: "primary", ref: primary.ref }, {
      capKind: "rate_limited",
      at: T0,
      estimatedReset: "2026-01-01T00:02:00.000Z",
    });
    table.markAvailable({ routeId: sub.routeId, providerId: "acme", modelId: "sub", ref: sub.ref }, T0);
    const { ctx } = adequateMock();

    const result = await chooseFallback({
      ctx,
      attempt: attempt(),
      candidates: [primary, sub],
      availability: table,
      now: T0,
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 5,
      costOf: (ref) => (ref === "acme/sub" ? 10 : 2),
    });

    expect(result).toEqual({
      kind: "pause",
      reason: "prefer_wait",
      earliestReset: "2026-01-01T00:02:00.000Z",
      blocker: expect.any(String),
      watchRoutes: [primary.routeId],
    });
  });
});

describe("AC: dwell prevents switching back mid-task", () => {
  it("mid-task (atTaskBoundary=false), even after the primary's reset has passed, stays on the substitute", async () => {
    const primary = candidate("primary", "acme");
    const sub = candidate("sub", "acme");
    const table = new RouteAvailabilityTable();
    table.markAvailable({ routeId: primary.routeId, providerId: "acme", modelId: "primary", ref: primary.ref }, T0);
    table.markAvailable({ routeId: sub.routeId, providerId: "acme", modelId: "sub", ref: sub.ref }, T0);
    const { ctx, transport } = adequateMock();

    // Primary is fully eligible again (no cap at all), but we are still
    // mid-task on the substitute with a remainder_of_task dwell in force.
    const result = await chooseFallback({
      ctx,
      attempt: attempt({ usedModel: "acme/sub" as ModelRef, fallbackSince: T0 }),
      candidates: [primary, sub],
      availability: table,
      now: "2026-01-01T00:05:00.000Z",
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 0,
      atTaskBoundary: false,
    });

    expect(result).toEqual({ kind: "unchanged" });
    expect(transport.calls).toHaveLength(0);
  });

  it("inDwell itself: remainder_of_task holds mid-task and lapses only at a boundary", () => {
    const a = attempt({ fallbackSince: T0 });
    const cfg = { dwell: "remainder_of_task" as const, dwellMinutes: 0 };
    expect(inDwell(a, cfg, "2026-01-01T05:00:00.000Z", false)).toBe(true);
    expect(inDwell(a, cfg, "2026-01-01T05:00:00.000Z", true)).toBe(false);
  });
});

describe("all-capped auto-resume prefers the primary once it clears (#65 primary-preference half of #63's pause/resume)", () => {
  it("at a task boundary with both primary and a substitute eligible again, selection prefers the primary", async () => {
    const primary = candidate("primary", "acme");
    const sub = candidate("sub", "acme");
    const table = new RouteAvailabilityTable();
    // Both routes cleared (were capped, reset has passed) — the all_capped
    // pause resumed via cap-pause.ts's resumeIfCapCleared; this is the
    // subsequent task-boundary selection that follows the resume.
    table.markAvailable({ routeId: primary.routeId, providerId: "acme", modelId: "primary", ref: primary.ref }, T0);
    table.markAvailable({ routeId: sub.routeId, providerId: "acme", modelId: "sub", ref: sub.ref }, T0);
    const { ctx } = adequateMock();

    // usedModel is still the substitute from before the all-capped pause;
    // no fallbackSince recorded across a pause boundary, so dwell does not
    // apply here and the re-rank explicitly prefers the primary.
    const result = await chooseFallback({
      ctx,
      attempt: attempt({ usedModel: "acme/sub" as ModelRef, fallbackSince: null }),
      candidates: [sub, primary], // deliberately not primary-first in input order
      availability: table,
      now: T0,
      allowlist: ALLOW_ALL,
      staticOrder: [],
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 0,
      atTaskBoundary: true,
    });

    expect(result).toEqual({
      kind: "switch",
      requestedModel: "acme/primary",
      usedModel: "acme/primary",
      fallbackReason: null,
      rationale: expect.any(String),
      decisionId: null,
    });
  });
});
