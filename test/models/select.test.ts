/**
 * Tests for src/models/select.ts (issue #60; PLAN §3.D "Selection").
 *
 * AC: "Mock Jev returning an out-of-allowlist id → rejected, audited, next
 *   candidate used (test)."
 * AC: "`none adequate` → returns `none`, no model used."
 * AC: "Static order used when Jev disabled; selection is still recorded as
 *   a Decision with rule `static`."
 */
import { describe, expect, it } from "vitest";
import {
  eligibleCandidates,
  enforcePolicy,
  selectModel,
  type SelectionCandidate,
} from "../../src/models/select.ts";
import { RouteAvailabilityTable } from "../../src/models/availability.ts";
import { deriveRouteId } from "../../src/models/route.ts";
import { mergeCards } from "../../src/models/cards.ts";
import type { CatalogEntry } from "../../src/models/catalog.ts";
import type { ModelAllowlist, ModelRef } from "../../src/config/types.ts";
import type { TaskProfile } from "../../src/storage/records.ts";
import { DisabledJevTransport } from "../../src/jev/disabled.ts";
import { MockJevTransport } from "../../src/jev/mock.ts";
import type { AskContext } from "../../src/decisions/ask.ts";
import { DecisionRecorder, MemoryDecisionSink } from "../../src/decisions/record.ts";
import type { WorkflowId } from "../../src/storage/records.ts";

const MODEL = "jev-test";

function recorder(): { recorder: DecisionRecorder; sink: MemoryDecisionSink } {
  const sink = new MemoryDecisionSink();
  let n = 0;
  return {
    sink,
    recorder: new DecisionRecorder({
      sink,
      workflowId: "wf-1" as WorkflowId,
      revision: "a".repeat(40),
      now: () => "2026-01-01T00:00:00.000Z",
      newId: () => `dc-${(n += 1)}`,
    }),
  };
}

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

describe("eligibleCandidates", () => {
  it("excludes routes with an uncleared cap", () => {
    const e1 = entry("m1", "acme");
    const e2 = entry("m2", "acme");
    const table = new RouteAvailabilityTable();
    table.markCapped({ routeId: e1.routeId, providerId: "acme", modelId: "m1", ref: e1.id }, {
      capKind: "rate_limited",
      at: "2026-01-01T00:00:00.000Z",
      estimatedReset: null,
    });
    const cards = new Map([
      [e1.id, mergeCards(e1, {})],
      [e2.id, mergeCards(e2, {})],
    ]);
    const result = eligibleCandidates([e1, e2], cards, table, "2026-01-01T00:00:00.000Z");
    expect(result.map((c) => c.ref)).toEqual([e2.id]);
  });
});

describe("enforcePolicy", () => {
  it("rejects a model outside the allowlist", () => {
    const allowlist: ModelAllowlist = { providers: [], models: ["acme/m1" as ModelRef], pins: {} };
    const eligible = new Set<ModelRef>(["acme/m1" as ModelRef, "acme/m2" as ModelRef]);
    expect(enforcePolicy("acme/m2" as ModelRef, eligible, allowlist).reason).toBe("not_in_allowlist");
    expect(enforcePolicy("acme/m1" as ModelRef, eligible, allowlist).ok).toBe(true);
  });

  it("rejects a model not in the eligible set even if allowlisted", () => {
    const allowlist: ModelAllowlist = { providers: [], models: [], pins: {} };
    const eligible = new Set<ModelRef>(["acme/m1" as ModelRef]);
    expect(enforcePolicy("acme/other" as ModelRef, eligible, allowlist).reason).toBe("not_eligible");
  });

  it("rejects when the budget check fails", () => {
    const allowlist: ModelAllowlist = { providers: [], models: [], pins: {} };
    const eligible = new Set<ModelRef>(["acme/m1" as ModelRef]);
    const check = enforcePolicy("acme/m1" as ModelRef, eligible, allowlist, () => false);
    expect(check.reason).toBe("budget_unavailable");
  });
});

describe("AC: static order used when Jev disabled; recorded as a Decision with rule 'static'", () => {
  it("selects the first static-order candidate and records rule=static", async () => {
    const candidates = [candidate("m1", "acme"), candidate("m2", "acme")];
    const { recorder: rec, sink } = recorder();
    const result = await selectModel({
      ctx: null,
      profile: PROFILE,
      candidates,
      allowlist: ALLOW_ALL,
      staticOrder: ["acme/m2", "acme/m1"],
      recorder: rec,
    });
    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.usedModel).toBe("acme/m2");
      expect(result.requestedModel).toBe("acme/m2");
      expect(result.fallbackReason).toBeNull();
    }
    expect(sink.rows.some((r) => r.policyRule === "static")).toBe(true);
  });

  it("also falls back to static order when every Jev answer fell back", async () => {
    const candidates = [candidate("m1", "acme")];
    const ctx: AskContext = { transport: new DisabledJevTransport(), model: MODEL };
    const result = await selectModel({
      ctx,
      profile: PROFILE,
      candidates,
      allowlist: ALLOW_ALL,
      staticOrder: ["acme/m1"],
    });
    expect(result.kind).toBe("selected");
    if (result.kind === "selected") expect(result.usedModel).toBe("acme/m1");
  });
});

describe("AC: none adequate → returns none, no model used", () => {
  it("Jev says every candidate is not adequate", async () => {
    const candidates = [candidate("m1", "acme"), candidate("m2", "acme")];
    const mock = new MockJevTransport({
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
    });
    const ctx: AskContext = { transport: mock, model: MODEL };
    const result = await selectModel({
      ctx,
      profile: PROFILE,
      candidates,
      allowlist: ALLOW_ALL,
      staticOrder: [],
    });
    expect(result).toEqual({ kind: "none", reason: "inadequate", decisionId: null });
  });
});

describe("AC (#61): pinned model used regardless of mock Jev ranking", () => {
  it("honours the pin even when Jev would rank a different candidate adequate", async () => {
    const candidates = [candidate("m1", "acme"), candidate("m2", "acme")];
    const mock = new MockJevTransport({
      responder: (request) => ({
        kind: "ok",
        response: {
          model: MODEL,
          // Jev prefers whatever it is asked about first (m1); the pin names m2.
          answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 0.9 }])),
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        requestId: "req",
        attempts: 1,
        elapsedMs: 1,
      }),
    });
    const ctx: AskContext = { transport: mock, model: MODEL };
    const { recorder: rec, sink } = recorder();
    const result = await selectModel({
      ctx,
      profile: PROFILE,
      candidates,
      allowlist: ALLOW_ALL,
      staticOrder: [],
      pin: "acme/m2" as ModelRef,
      recorder: rec,
    });
    expect(result).toEqual({
      kind: "selected",
      requestedModel: "acme/m2",
      usedModel: "acme/m2",
      fallbackReason: null,
      rationale: "user pin acme/m2",
      decisionId: expect.any(String),
    });
    expect(sink.rows.some((r) => r.policyRule === "pin" && r.action === "acme/m2")).toBe(true);
  });

  it("a pin outside the allowlist is never silently substituted; returns pin_blocked", async () => {
    const candidates = [candidate("m1", "acme")];
    const allowlist: ModelAllowlist = { providers: [], models: ["acme/other" as ModelRef], pins: {} };
    const { recorder: rec, sink } = recorder();
    const result = await selectModel({
      ctx: null,
      profile: PROFILE,
      candidates,
      allowlist,
      staticOrder: [],
      pin: "acme/m1" as ModelRef,
      recorder: rec,
    });
    expect(result).toEqual({
      kind: "pin_blocked",
      ref: "acme/m1",
      reason: "policy_rejected",
      approvalClass: "model_substitute_pinned",
      decisionId: null,
    });
    expect(sink.rows.some((r) => r.policyRule === "pin_blocked:policy_rejected")).toBe(true);
  });

  it("a pin that is capped/ineligible (not in the candidate set) returns pin_blocked with no Jev call", async () => {
    const candidates = [candidate("m1", "acme")];
    const result = await selectModel({
      ctx: null,
      profile: PROFILE,
      candidates,
      allowlist: ALLOW_ALL,
      staticOrder: [],
      pin: "acme/capped" as ModelRef,
    });
    expect(result).toEqual({
      kind: "pin_blocked",
      ref: "acme/capped",
      reason: "capped",
      approvalClass: "model_substitute_pinned",
      decisionId: null,
    });
  });

  it("no pin falls through to normal Jev/static selection", async () => {
    const candidates = [candidate("m1", "acme")];
    const result = await selectModel({
      ctx: null,
      profile: PROFILE,
      candidates,
      allowlist: ALLOW_ALL,
      staticOrder: ["acme/m1"],
      pin: null,
    });
    expect(result.kind).toBe("selected");
  });
});

describe("AC: mock Jev returning an out-of-allowlist id → rejected, audited, next candidate used", () => {
  it("Jev ranks a disallowed candidate first; policy rejects it and the next adequate one is used", async () => {
    const candidates = [candidate("blocked", "acme"), candidate("ok", "acme")];
    const mock = new MockJevTransport({
      responder: (request) => ({
        kind: "ok",
        response: {
          model: MODEL,
          // Both adequate: "blocked" comes first in candidate order, so it is
          // the requested/preferred one, but the allowlist below excludes it.
          answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 0.9 }])),
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        requestId: "req",
        attempts: 1,
        elapsedMs: 1,
      }),
    });
    const ctx: AskContext = { transport: mock, model: MODEL };
    const allowlist: ModelAllowlist = { providers: [], models: ["acme/ok"], pins: {} };
    const { recorder: rec, sink } = recorder();
    const result = await selectModel({
      ctx,
      profile: PROFILE,
      candidates,
      allowlist,
      staticOrder: [],
      recorder: rec,
    });
    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.requestedModel).toBe("acme/blocked");
      expect(result.usedModel).toBe("acme/ok");
      expect(result.fallbackReason).toBe("jev_selected_substitute");
    }
    const rejection = sink.rows.find((r) => r.policyRule === "policy_rejected:not_in_allowlist");
    expect(rejection).toBeDefined();
    expect(rejection?.action).toBe("acme/blocked");
  });

  it("when every adequate candidate is policy-rejected, returns none/inadequate", async () => {
    const candidates = [candidate("blocked1", "acme"), candidate("blocked2", "acme")];
    const mock = new MockJevTransport({
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
    });
    const ctx: AskContext = { transport: mock, model: MODEL };
    const allowlist: ModelAllowlist = { providers: [], models: ["acme/ok"], pins: {} };
    const result = await selectModel({
      ctx,
      profile: PROFILE,
      candidates,
      allowlist,
      staticOrder: [],
    });
    expect(result.kind).toBe("none");
    if (result.kind === "none") expect(result.reason).toBe("inadequate");
  });
});
