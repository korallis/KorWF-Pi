/**
 * `src/extension/catalog-refresh.ts` (issue #56 Scope item 3: "Catalog
 * refresh on Pi model-registry change events").
 *
 * docs/pi-integration-map.md / docs/extensions.md "Lifecycle Overview" name
 * no `model_registry_changed` event; the two real model-related events are
 * `session_start` and `model_select`. These tests fire fake versions of both
 * against a fake `ExtensionAPI` and assert the catalog is rebuilt: a model
 * newly present in the registry snapshot appears, and one removed
 * disappears — without a manual `getCatalog()` call driving the change.
 */
import { describe, it, expect } from "vitest";
import { registerCatalogRefresh, type CatalogSnapshotSource } from "../../../src/extension/catalog-refresh.ts";
import type { CatalogConfig, RegistrySnapshot } from "../../../src/models/catalog.ts";

type Handler = (event: unknown, ctx: unknown) => void;
type FakePi = Parameters<typeof registerCatalogRefresh>[0];

/** Minimal fake `ExtensionAPI`: records handlers by event name so a test can fire them directly. */
function makeFakePi(): { on: (event: string, handler: Handler) => () => void; fire: (event: string, ctx: unknown) => void } {
  const handlers = new Map<string, Handler[]>();
  return {
    on: (event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    fire: (event, ctx) => {
      for (const h of handlers.get(event) ?? []) h(undefined, ctx);
    },
  };
}

const ALLOW_ALL: CatalogConfig = { allowlist: { providers: [], models: [], pins: {} } };
const PROVIDER = "vendor-proxy";

function snapshotWith(ids: readonly string[]): RegistrySnapshot {
  return {
    available: ids.map((id) => ({
      provider: PROVIDER,
      id,
      name: id,
      reasoning: true,
      input: ["text"] as const,
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    scoped: [],
  };
}

describe("registerCatalogRefresh", () => {
  it("registers handlers on session_start and model_select — the only two model-related events Pi's extension API exposes", () => {
    const pi = makeFakePi();
    const registered: string[] = [];
    const wrapped = {
      on: (event: string, handler: Handler) => {
        registered.push(event);
        return pi.on(event, handler);
      },
    };
    registerCatalogRefresh(wrapped as unknown as FakePi, () => ALLOW_ALL);
    expect(registered).toEqual(["session_start", "model_select"]);
  });

  it("rebuilds the catalog on session_start: a model newly present in the registry snapshot appears", () => {
    const pi = makeFakePi();
    let currentSnapshot = snapshotWith(["gpt-6-astra"]);
    const source: CatalogSnapshotSource = { getSnapshot: () => currentSnapshot, getConfig: () => ALLOW_ALL };
    const { store } = registerCatalogRefresh(pi as unknown as FakePi, () => ALLOW_ALL, { source });

    pi.fire("session_start", { cwd: "/proj", modelRegistry: {}, scopedModels: [] });
    expect(store.getCached()?.result.entries.map((e) => e.id)).toEqual([`${PROVIDER}/gpt-6-astra`]);

    // A model is added to the registry (e.g. the user edited models.json and reloaded).
    currentSnapshot = snapshotWith(["gpt-6-astra", "kimi-k3"]);
    pi.fire("session_start", { cwd: "/proj", modelRegistry: {}, scopedModels: [] });
    const ids = store.getCached()?.result.entries.map((e) => e.id) ?? [];
    expect(ids).toContain(`${PROVIDER}/kimi-k3`);
    expect(ids).toHaveLength(2);
  });

  it("rebuilds the catalog on model_select: a model removed from the registry snapshot disappears", () => {
    const pi = makeFakePi();
    let currentSnapshot = snapshotWith(["gpt-6-astra", "kimi-k3"]);
    const source: CatalogSnapshotSource = { getSnapshot: () => currentSnapshot, getConfig: () => ALLOW_ALL };
    const { store } = registerCatalogRefresh(pi as unknown as FakePi, () => ALLOW_ALL, { source });

    pi.fire("session_start", { cwd: "/proj", modelRegistry: {}, scopedModels: [] });
    expect(store.getCached()?.result.entries).toHaveLength(2);

    // A model disappears from the registry (e.g. auth revoked, provider removed).
    currentSnapshot = snapshotWith(["gpt-6-astra"]);
    pi.fire("model_select", { cwd: "/proj", modelRegistry: {}, scopedModels: [] });
    const ids = store.getCached()?.result.entries.map((e) => e.id) ?? [];
    expect(ids).toEqual([`${PROVIDER}/gpt-6-astra`]);
    expect(store.getCached()?.reason).toBe("model_select");
  });

  it("getCatalog always rebuilds from a fresh snapshot, so a read between events is never stale (the honest alternative to an unavailable registry-change event)", () => {
    const pi = makeFakePi();
    let currentSnapshot = snapshotWith(["gpt-6-astra"]);
    const source: CatalogSnapshotSource = { getSnapshot: () => currentSnapshot, getConfig: () => ALLOW_ALL };
    const { getCatalog } = registerCatalogRefresh(pi as unknown as FakePi, () => ALLOW_ALL, { source });

    const before = getCatalog({ cwd: "/proj", modelRegistry: {} as never, scopedModels: [] });
    expect(before.entries.map((e) => e.id)).toEqual([`${PROVIDER}/gpt-6-astra`]);

    // No event fired at all — the registry changed but nothing told us.
    currentSnapshot = snapshotWith(["gpt-6-astra", "kimi-k3"]);
    const after = getCatalog({ cwd: "/proj", modelRegistry: {} as never, scopedModels: [] });
    expect(after.entries.map((e) => e.id).sort()).toEqual([`${PROVIDER}/gpt-6-astra`, `${PROVIDER}/kimi-k3`]);
  });

  it("skips a rebuild (keeps the previous cache) when config cannot be loaded for the cwd, rather than caching an empty catalog", () => {
    const pi = makeFakePi();
    const source: CatalogSnapshotSource = { getSnapshot: () => snapshotWith(["gpt-6-astra"]), getConfig: () => ALLOW_ALL };
    const { store } = registerCatalogRefresh(pi as unknown as FakePi, (cwd) => (cwd === "/good" ? ALLOW_ALL : undefined), { source });

    pi.fire("session_start", { cwd: "/good", modelRegistry: {}, scopedModels: [] });
    expect(store.getCached()?.result.entries).toHaveLength(1);

    pi.fire("session_start", { cwd: "/bad", modelRegistry: {}, scopedModels: [] });
    // Still the last good entry, not wiped to empty.
    expect(store.getCached()?.result.entries).toHaveLength(1);
  });
});
