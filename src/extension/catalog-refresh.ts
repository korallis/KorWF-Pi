/**
 * Catalog refresh wiring (issue #56 Scope item 3: "Catalog refresh on Pi
 * model-registry change events").
 *
 * **What Pi actually exposes.** `docs/pi-integration-map.md` (#7) enumerates
 * every extension event Pi emits (`docs/extensions.md` "Lifecycle Overview",
 * read in full for this issue); there is no `model_registry_changed` /
 * `models_refreshed` / settings-file-watch event. The two real,
 * model-related signals are:
 *
 *   - `session_start` — full runtime reload (startup/reload/new/resume/fork).
 *     `ctx.modelRegistry.getAvailable()` is re-read from `models.json` and
 *     auth state at this point (docs/model-registry-fields.md §3: "scope is
 *     resolved once at session start ... re-read it in session_start").
 *   - `model_select` — fires on `/model`, Ctrl+P cycling, or `pi.setModel()`
 *     (docs/extensions.md "Lifecycle Overview": `/model or Ctrl+P →
 *     thinking_level_select? → model_select`). This is a *selection* change,
 *     not a registry-content change, but it is the only other model-related
 *     event Pi emits, and it is the point at which a user who has just
 *     logged in to a new provider or hand-edited `models.json` is most
 *     likely to have triggered Pi to re-resolve the registry (Pi's `/model`
 *     picker reads `getAvailable()` fresh; see `docs/usage.md` "/model").
 *
 * There is no way, documented or observed, to be notified when
 * `~/.pi/agent/models.json` changes on disk mid-session without the user
 * touching model selection or restarting/reloading. **This is a real gap in
 * Pi's extension surface, not an oversight here** — see
 * `docs/model-registry-fields.md` for the full field/API audit this module
 * builds on.
 *
 * **The honest alternative implemented:** treat both real signals as
 * rebuild triggers, and — because that pair still cannot guarantee
 * freshness for an edit nobody selected a model to notice — make every read
 * self-healing: `getCatalog()` always rebuilds from a freshly-read snapshot
 * rather than trusting the cache, so a stale cache is at worst a stale
 * *cached* copy, never a stale *served* one. The cache exists only so
 * `/korwf models`-style callers can show "last refreshed at" state and so a
 * caller that explicitly wants the cheap cached view has one
 * (`getCached()`).
 *
 * `buildCatalog` itself stays pure (`src/models/catalog.ts`); this module is
 * the Pi-importing seam that calls it, per `docs/adr/0002-source-layout.md`
 * ("domain modules never import extension/").
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildCatalog, type CatalogConfig, type CatalogResult, type RegistrySnapshot } from "../models/catalog.ts";

/** Why a rebuild happened; surfaced for logging/tests, never for policy decisions. */
export type CatalogRefreshReason = "session_start" | "model_select" | "manual";

export interface CatalogCacheEntry {
  readonly result: CatalogResult;
  readonly reason: CatalogRefreshReason;
  readonly at: string;
}

/**
 * Holds the most recently built catalog. Not a source of truth by itself —
 * `getCatalog()` on the registrar below always rebuilds first — but gives
 * callers that only want the last-known state (e.g. a status line) a cheap
 * read with no registry access.
 */
export class CatalogStore {
  private entry: CatalogCacheEntry | null = null;

  rebuild(snapshot: RegistrySnapshot, config: CatalogConfig, reason: CatalogRefreshReason, now: () => string): CatalogCacheEntry {
    const result = buildCatalog(snapshot, config);
    this.entry = { result, reason, at: now() };
    return this.entry;
  }

  /** Last built entry, or `null` before the first rebuild. */
  getCached(): CatalogCacheEntry | null {
    return this.entry;
  }
}

/** How to read a fresh, credential-free snapshot and the current config from a live Pi context. */
export interface CatalogSnapshotSource {
  readonly getSnapshot: (ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels">) => RegistrySnapshot;
  readonly getConfig: (ctx: Pick<ExtensionContext, "cwd">) => CatalogConfig | undefined;
}

/**
 * Default snapshot reader: copies exactly the layer-1-relevant fields off
 * Pi's `Model` objects (never `baseUrl`/`headers`/`compat`) into the shape
 * `buildCatalog` expects. `enabledModelsConfigured` is left `false` here —
 * Pi's `ExtensionContext` does not expose the raw `enabledModels`/`--models`
 * setting, only the resolved `scopedModels` (docs/pi-integration-map.md
 * S12), so a caller that needs rule 4's exact "configured but matched
 * nothing" distinction must supply its own `getSnapshot`.
 */
export function defaultGetSnapshot(ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels">): RegistrySnapshot {
  const available = ctx.modelRegistry.getAvailable().map((m) => ({
    id: m.id,
    provider: m.provider,
    name: m.name,
    reasoning: m.reasoning,
    ...(m.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: m.thinkingLevelMap }),
    input: m.input,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    cost: m.cost,
  }));
  const scoped = ctx.scopedModels.map((s) => ({
    model: { id: s.model.id, provider: s.model.provider },
    ...(s.thinkingLevel === undefined ? {} : { thinkingLevel: s.thinkingLevel }),
  }));
  return { available, scoped, enabledModelsConfigured: scoped.length > 0 };
}

export interface RegisterCatalogRefreshOptions {
  readonly source?: CatalogSnapshotSource;
  readonly now?: () => string;
  readonly onRebuild?: (entry: CatalogCacheEntry) => void;
}

/**
 * Wire catalog rebuilds to Pi's two real model-related events
 * (`session_start`, `model_select`) and return the store plus a
 * `getCatalog(ctx)` helper that always rebuilds from a fresh read — so
 * "refresh on registry change" degrades to "never serve a stale read" in the
 * one case Pi gives no signal for (an unselected `models.json` edit).
 */
export function registerCatalogRefresh(
  pi: Pick<ExtensionAPI, "on">,
  getConfigForCwd: (cwd: string) => CatalogConfig | undefined,
  options: RegisterCatalogRefreshOptions = {},
): { readonly store: CatalogStore; readonly getCatalog: (ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels" | "cwd">) => CatalogResult } {
  const store = new CatalogStore();
  const getSnapshot = options.source?.getSnapshot ?? defaultGetSnapshot;
  const now = options.now ?? (() => new Date().toISOString());

  const rebuildFrom = (ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels" | "cwd">, reason: CatalogRefreshReason): void => {
    const config = getConfigForCwd(ctx.cwd);
    if (config === undefined) return;
    const entry = store.rebuild(getSnapshot(ctx), config, reason, now);
    options.onRebuild?.(entry);
  };

  pi.on("session_start", (_event, ctx) => {
    rebuildFrom(ctx, "session_start");
  });
  pi.on("model_select", (_event, ctx) => {
    rebuildFrom(ctx, "model_select");
  });

  const getCatalog = (ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels" | "cwd">): CatalogResult => {
    const config = getConfigForCwd(ctx.cwd);
    if (config === undefined) return store.getCached()?.result ?? { entries: [], excluded: [] };
    return store.rebuild(getSnapshot(ctx), config, "manual", now).result;
  };

  return { store, getCatalog };
}
