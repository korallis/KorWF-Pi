/**
 * Tests for src/models/catalog.ts (issue #56).
 *
 * Test names reference the acceptance criteria in the issue:
 *  - "A model outside the allowlist never appears in the catalog"
 *  - "Serialised catalog contains no URL or key"
 *  - "Zero-cost proxied model is represented with cost: unknown, not 0"
 */
import { describe, it, expect } from "vitest";
import {
  buildCatalog,
  serializeCatalog,
  UNKNOWN,
  type CatalogConfig,
  type RegistryModel,
  type RegistrySnapshot,
} from "../../src/models/catalog.ts";
import { deriveRouteId } from "../../src/models/route.ts";
import type { ModelAllowlist } from "../../src/config/types.ts";

const PROXIED = "vendor-proxy";
const DIRECT = "vendor-direct";

function model(overrides: Partial<RegistryModel> & Pick<RegistryModel, "provider" | "id">): RegistryModel {
  return {
    name: overrides.id,
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

const allowAll: ModelAllowlist = { providers: [], models: [], pins: {} };

function config(allowlist: ModelAllowlist = allowAll): CatalogConfig {
  return { allowlist };
}

describe("buildCatalog", () => {
  it("includes every configured model when the allowlist is empty (default: all configured)", () => {
    const a = model({ provider: PROXIED, id: "gpt-6-astra" });
    const b = model({ provider: DIRECT, id: "claude-x" });
    const snapshot: RegistrySnapshot = { available: [a, b], scoped: [] };
    const result = buildCatalog(snapshot, config());
    expect(result.entries.map((e) => e.id).sort()).toEqual([`${DIRECT}/claude-x`, `${PROXIED}/gpt-6-astra`]);
    expect(result.excluded).toEqual([]);
  });

  it("AC: a model outside the allowlist never appears in the catalog (fake registry, provider filter)", () => {
    const allowed = model({ provider: PROXIED, id: "gpt-6-astra" });
    const outside = model({ provider: DIRECT, id: "claude-x" });
    const snapshot: RegistrySnapshot = { available: [allowed, outside], scoped: [] };
    const result = buildCatalog(snapshot, config({ providers: [PROXIED], models: [], pins: {} }));
    expect(result.entries.map((e) => e.id)).toEqual([`${PROXIED}/gpt-6-astra`]);
    expect(result.entries.some((e) => e.provider === DIRECT)).toBe(false);
    const excludedIds = result.excluded.map((e) => e.id);
    expect(excludedIds).toContain(`${DIRECT}/claude-x`);
    expect(result.excluded.find((e) => e.id === `${DIRECT}/claude-x`)?.reason.kind).toBe("provider_not_allowlisted");
  });

  it("AC: a model outside the allowlist never appears in the catalog (fake registry, model filter)", () => {
    const kept = model({ provider: PROXIED, id: "gpt-6-astra" });
    const dropped = model({ provider: PROXIED, id: "kimi-k3" });
    const snapshot: RegistrySnapshot = { available: [kept, dropped], scoped: [] };
    const result = buildCatalog(snapshot, config({ providers: [], models: [`${PROXIED}/gpt-6-astra`], pins: {} }));
    expect(result.entries.map((e) => e.id)).toEqual([`${PROXIED}/gpt-6-astra`]);
    expect(result.excluded[0]?.reason.kind).toBe("model_not_allowlisted");
  });

  it("never widens: allowlist naming a model Pi has not configured does not add it", () => {
    const configured = model({ provider: PROXIED, id: "gpt-6-astra" });
    const snapshot: RegistrySnapshot = { available: [configured], scoped: [] };
    const result = buildCatalog(snapshot, config({ providers: [], models: [`${PROXIED}/nonexistent`], pins: {} }));
    expect(result.entries).toEqual([]);
  });

  it("excludes a model outside the enabledModels/--models scope, distinct reason from allowlist", () => {
    const a = model({ provider: PROXIED, id: "gpt-6-astra" });
    const b = model({ provider: PROXIED, id: "kimi-k3" });
    const snapshot: RegistrySnapshot = {
      available: [a, b],
      scoped: [{ model: a }],
      enabledModelsConfigured: true,
    };
    const result = buildCatalog(snapshot, config());
    expect(result.entries.map((e) => e.id)).toEqual([`${PROXIED}/gpt-6-astra`]);
    expect(result.excluded[0]?.reason.kind).toBe("not_scoped");
  });

  it("empty scope from a non-matching pattern excludes everything, not 'all available' (deviation from Pi's own widening)", () => {
    const a = model({ provider: PROXIED, id: "gpt-6-astra" });
    const snapshot: RegistrySnapshot = { available: [a], scoped: [], enabledModelsConfigured: true };
    const result = buildCatalog(snapshot, config());
    expect(result.entries).toEqual([]);
    expect(result.excluded).toHaveLength(1);
  });

  it("excludes a model disabled by a user override, with a distinct reason", () => {
    const a = model({ provider: PROXIED, id: "gpt-6-astra" });
    const snapshot: RegistrySnapshot = { available: [a], scoped: [] };
    const result = buildCatalog(snapshot, { allowlist: allowAll, overrides: { [`${PROXIED}/gpt-6-astra`]: { disabled: true } } });
    expect(result.entries).toEqual([]);
    expect(result.excluded[0]?.reason.kind).toBe("disabled_by_override");
  });

  it("AC: zero-cost proxied model is represented with cost: unknown, not 0", () => {
    const a = model({ provider: PROXIED, id: "gpt-6-astra", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const snapshot: RegistrySnapshot = { available: [a], scoped: [] };
    const result = buildCatalog(snapshot, config());
    expect(result.entries[0]?.cost).toBe(UNKNOWN);
  });

  it("a real (non-zero) cost is passed through unchanged", () => {
    const a = model({ provider: DIRECT, id: "claude-x", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } });
    const snapshot: RegistrySnapshot = { available: [a], scoped: [] };
    const result = buildCatalog(snapshot, config());
    expect(result.entries[0]?.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });

  it("missing thinkingLevelMap is represented as unknown, never invented", () => {
    const a = model({ provider: PROXIED, id: "claude-fable-5-1" });
    const snapshot: RegistrySnapshot = { available: [a], scoped: [] };
    const result = buildCatalog(snapshot, config());
    expect(result.entries[0]?.thinkingLevelMap).toBe(UNKNOWN);
  });

  it("present thinkingLevelMap, including null-disabled levels, is copied verbatim", () => {
    const map = { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
    const a = model({ provider: PROXIED, id: "gpt-6-astra", thinkingLevelMap: map });
    const snapshot: RegistrySnapshot = { available: [a], scoped: [] };
    const result = buildCatalog(snapshot, config());
    expect(result.entries[0]?.thinkingLevelMap).toEqual(map);
  });

  it("carries the opaque routeId for each entry, matching route.ts's derivation (#125)", () => {
    const a = model({ provider: PROXIED, id: "gpt-6-astra" });
    const snapshot: RegistrySnapshot = { available: [a], scoped: [] };
    const result = buildCatalog(snapshot, config());
    expect(result.entries[0]?.routeId).toBe(deriveRouteId(PROXIED, "gpt-6-astra"));
  });

  it("the same model id under two providers yields two distinct catalog entries with distinct routeIds", () => {
    const a = model({ provider: "vendor-work", id: "example-model-5" });
    const b = model({ provider: "vendor-personal", id: "example-model-5" });
    const snapshot: RegistrySnapshot = { available: [a, b], scoped: [] };
    const result = buildCatalog(snapshot, config());
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.routeId).not.toBe(result.entries[1]?.routeId);
  });

  it("carries a scoped thinking-level pin as thinkingLevelCap, never raising it", () => {
    const a = model({ provider: PROXIED, id: "gpt-6-astra" });
    const snapshot: RegistrySnapshot = { available: [a], scoped: [{ model: a, thinkingLevel: "high" }], enabledModelsConfigured: true };
    const result = buildCatalog(snapshot, config());
    expect(result.entries[0]?.thinkingLevelCap).toBe("high");
  });

  it("AC: serialised catalog contains no URL or key (assert by regex)", () => {
    const a = model({
      provider: PROXIED,
      id: "gpt-6-astra",
      // A caller passing extra fields (defensive: registry objects carry more than RegistryModel)
      // must not leak them through serializeCatalog because only layer-1 fields are ever copied.
      ...({ baseUrl: "https://proxy.example.internal/v1", headers: { Authorization: "Bearer sk-should-not-leak" } } as Partial<RegistryModel>),
    });
    const snapshot: RegistrySnapshot = { available: [a], scoped: [] };
    const result = buildCatalog(snapshot, config());
    const serialized = serializeCatalog(result);
    expect(serialized).not.toMatch(/https?:\/\//i);
    expect(serialized).not.toMatch(/bearer/i);
    expect(serialized).not.toMatch(/sk-[a-zA-Z0-9]/);
    expect(serialized).not.toMatch(/apikey|api_key/i);
  });

  it("reports excluded models with a human-readable reason for /korwf models", () => {
    const outside = model({ provider: DIRECT, id: "claude-x" });
    const snapshot: RegistrySnapshot = { available: [outside], scoped: [] };
    const result = buildCatalog(snapshot, config({ providers: [PROXIED], models: [], pins: {} }));
    expect(result.excluded[0]?.reason.detail).toContain(DIRECT);
  });
});
