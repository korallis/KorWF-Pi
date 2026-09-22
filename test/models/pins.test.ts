/**
 * Tests for src/models/pins.ts (issue #61; PLAN §3.D "Pinned model").
 *
 * AC: "Pinned model used regardless of mock Jev ranking."
 * AC: "Pinned model outside allowlist → error explaining why, not silent use."
 * AC: "Fallback from a pin triggers approval class model_substitute_pinned."
 */
import { describe, it, expect } from "vitest";
import { applyPin, resolvePin } from "../../src/models/pins.ts";
import { mergeCards } from "../../src/models/cards.ts";
import { deriveRouteId } from "../../src/models/route.ts";
import type { CatalogEntry } from "../../src/models/catalog.ts";
import type { SelectionCandidate } from "../../src/models/select.ts";
import type { ModelAllowlist, ModelRef } from "../../src/config/types.ts";

const ALLOW_ALL: ModelAllowlist = { providers: [], models: [], pins: {} };

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

describe("resolvePin: task > phase > workflow > config order", () => {
  it("task scope wins over everything", () => {
    const ref = resolvePin(
      { task: "acme/task" as ModelRef, phase: "acme/phase" as ModelRef, workflow: "acme/wf" as ModelRef, config: "acme/cfg" as ModelRef },
      {},
      "default",
    );
    expect(ref).toBe("acme/task");
  });

  it("falls through to phase, then workflow, then config", () => {
    expect(resolvePin({ phase: "acme/phase" as ModelRef, workflow: "acme/wf" as ModelRef }, {}, "default")).toBe("acme/phase");
    expect(resolvePin({ workflow: "acme/wf" as ModelRef }, {}, "default")).toBe("acme/wf");
    expect(resolvePin({}, {}, "default")).toBeNull();
  });

  it("config allowlist pin per task kind is used when no explicit scope is set", () => {
    const ref = resolvePin({}, { implement: "acme/impl" as ModelRef, default: "acme/def" as ModelRef }, "implement");
    expect(ref).toBe("acme/impl");
  });

  it("config allowlist falls back to its own default entry for an unlisted kind", () => {
    const ref = resolvePin({}, { default: "acme/def" as ModelRef }, "test");
    expect(ref).toBe("acme/def");
  });
});

describe("AC: pinned model outside allowlist → error explaining why, not silent use", () => {
  it("applyPin returns needs_ask when the pin fails enforcePolicy", () => {
    const candidates = [candidate("m1", "acme")];
    const allowlist: ModelAllowlist = { providers: [], models: ["acme/other" as ModelRef], pins: {} };
    const result = applyPin("acme/m1" as ModelRef, candidates, allowlist);
    expect(result).toEqual({
      kind: "needs_ask",
      ref: "acme/m1",
      reason: "policy_rejected",
      check: { ok: false, reason: "not_in_allowlist" },
    });
  });

  it("applyPin returns needs_ask (reason capped) when the pin is not in the eligible candidate set at all", () => {
    const candidates = [candidate("m1", "acme")];
    const result = applyPin("acme/m2" as ModelRef, candidates, ALLOW_ALL);
    expect(result.kind).toBe("needs_ask");
    if (result.kind === "needs_ask") expect(result.reason).toBe("capped");
  });
});

describe("AC: pinned model used regardless of ranking (applyPin honours an eligible, allowed pin)", () => {
  it("returns pinned with the matching candidate", () => {
    const candidates = [candidate("m1", "acme"), candidate("m2", "acme")];
    const result = applyPin("acme/m2" as ModelRef, candidates, ALLOW_ALL);
    expect(result.kind).toBe("pinned");
    if (result.kind === "pinned") expect(result.candidate.ref).toBe("acme/m2");
  });

  it("no pin returns no_pin", () => {
    expect(applyPin(null, [], ALLOW_ALL)).toEqual({ kind: "no_pin" });
  });

  it("budget rejection also surfaces as needs_ask, never silently substituted", () => {
    const candidates = [candidate("m1", "acme")];
    const result = applyPin("acme/m1" as ModelRef, candidates, ALLOW_ALL, () => false);
    expect(result.kind).toBe("needs_ask");
    if (result.kind === "needs_ask") expect(result.check?.reason).toBe("budget_unavailable");
  });
});
