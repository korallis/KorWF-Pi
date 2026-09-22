/**
 * Model catalog from Pi's registry, filtered by allowlist (issue #56;
 * PLAN §3.D "Allowlist", "Model cards layer 1"; docs/model-registry-fields.md
 * §4 "Allowlist composition rule"; docs/pi-integration-map.md S12).
 *
 * `buildCatalog(ctx, config)` builds the eligible-model set:
 *
 *   eligible = configured ∩ enabledModels ∩ allowlist
 *
 * where `configured` is Pi's `ctx.modelRegistry.getAvailable()`,
 * `enabledModels` is `ctx.scopedModels` (empty ⇒ everything, *unless* the raw
 * patterns matched nothing — see `EnabledModelsScope`), and `allowlist` is
 * `config.models.allowlist`. Nothing widens the intersection (AGENTS §4:
 * "never weakens its own ... allowlist").
 *
 * Each eligible model becomes a `CatalogEntry` carrying only layer-1 fields
 * (id, provider, name, reasoning, thinkingLevelMap, input, contextWindow,
 * maxTokens, cost) plus the opaque `routeId` (#125) — never `baseUrl`,
 * `headers`, `compat`, or any credential. A field the registry did not
 * provide is `"unknown"`, never invented; `cost` of all-zero (proxied/local
 * models, docs/model-registry-fields.md §1) is represented as `unknown` too,
 * never as free (docs/model-registry-fields.md §4 rule 6).
 *
 * Excluded models are reported in `CatalogResult.excluded` with a reason so
 * `/korwf models` can explain the gap (AC).
 *
 * Pure module: no I/O, no Pi imports, no provider names. Callers pass a
 * duck-typed snapshot of the registry (`RegistrySnapshot`) — the same
 * discipline `route.ts` uses for `RegistryModelLike` — so this module never
 * depends on `@earendil-works/pi-coding-agent` types directly and is safe to
 * unit test with a fake registry.
 */
import type { ModelAllowlist, ModelRef } from "../config/types.ts";
import type { RouteId } from "../storage/records.ts";
import { routeFromRegistryModel, type RegistryModelLike } from "./route.ts";

// ---------------------------------------------------------------------------
// Inputs: a duck-typed, credential-free view of Pi's registry.
// ---------------------------------------------------------------------------

/** Pi's `ThinkingLevelMap` shape (docs/model-registry-fields.md §1); copied verbatim, never invented. */
export type ThinkingLevelMap = Readonly<Record<string, string | null>>;

/** Pi's `ModelCost` shape. All-zero on proxied/local models means "unknown", not "free". */
export interface RegistryCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * The subset of Pi's runtime `Model` this module reads. Deliberately omits
 * `baseUrl`, `headers`, `compat`, `promptCache`, `api` — sensitive or out of
 * scope for layer 1 (docs/model-registry-fields.md §5).
 */
export interface RegistryModel extends RegistryModelLike {
  readonly name: string;
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: ThinkingLevelMap;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly cost: RegistryCost;
}

/** One `ctx.scopedModels[]` entry (docs/pi-integration-map.md S12). */
export interface ScopedModelLike {
  readonly model: RegistryModelLike;
  readonly thinkingLevel?: string;
}

/**
 * What `buildCatalog` needs from Pi, gathered once (e.g. in `session_start`)
 * and passed in — never read live inside this pure module.
 */
export interface RegistrySnapshot {
  /** `ctx.modelRegistry.getAvailable()` — configured *and* authenticated. */
  readonly available: readonly RegistryModel[];
  /** `ctx.scopedModels` — resolved `--models`/`enabledModels` scope. */
  readonly scoped: readonly ScopedModelLike[];
  /**
   * Whether the raw `--models`/`enabledModels` setting had one or more
   * patterns configured. Required to distinguish "not configured" (both
   * empty ⇒ unrestricted) from "configured but matched nothing" (patterns
   * set, `scoped` empty ⇒ empty scope; docs/model-registry-fields.md §4 rule 4).
   * Omitted (or `false`) is treated as "not configured".
   */
  readonly enabledModelsConfigured?: boolean;
}

// ---------------------------------------------------------------------------
// Output: a credential-free catalog entry.
// ---------------------------------------------------------------------------

/** A field the registry did not provide. Never a guessed value. */
export const UNKNOWN = "unknown" as const;
export type Unknown = typeof UNKNOWN;

/** Layer-1 model card fields, safe to log, persist, and send to Jev. */
export interface CatalogEntry {
  /** `provider/id`, matching `ModelRef` / the allowlist syntax. */
  readonly id: ModelRef;
  readonly provider: string;
  readonly name: string;
  /** Opaque per-(provider,model) route id (#125); caps/outcomes key on this. */
  readonly routeId: RouteId;
  readonly reasoning: boolean;
  /** `undefined` levels fall back to Pi's defaults; `null` marks a disabled level. Absent map ⇒ `unknown`. */
  readonly thinkingLevelMap: ThinkingLevelMap | Unknown;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow: number | Unknown;
  readonly maxTokens: number | Unknown;
  /** `unknown` when the registry reports all-zero cost (proxied/local) — never `0` as "free". */
  readonly cost: RegistryCost | Unknown;
  /** Effective thinking level cap for this entry (scope pin ∩ allowlist pin), or `undefined` if uncapped. */
  readonly thinkingLevelCap?: string;
}

/** Why a configured-and-authenticated model did not make the catalog. */
export type ExclusionReason =
  | { readonly kind: "not_scoped"; readonly detail: string }
  | { readonly kind: "provider_not_allowlisted"; readonly detail: string }
  | { readonly kind: "model_not_allowlisted"; readonly detail: string }
  | { readonly kind: "disabled_by_override"; readonly detail: string };

export interface ExcludedModel {
  readonly id: ModelRef;
  readonly provider: string;
  readonly reason: ExclusionReason;
}

export interface CatalogResult {
  readonly entries: readonly CatalogEntry[];
  readonly excluded: readonly ExcludedModel[];
}

/** Config this module needs — a subset of `ModelsConfig`, kept minimal and dependency-free. */
export interface CatalogConfig {
  readonly allowlist: ModelAllowlist;
  readonly overrides?: Readonly<Record<ModelRef, { readonly disabled?: boolean }>>;
}

function toModelRef(m: RegistryModelLike): ModelRef {
  return `${m.provider}/${m.id}` as ModelRef;
}

/** `true` when cost is present but every rate is zero (unknown, not free). */
function isZeroCost(cost: RegistryCost): boolean {
  return cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0;
}

function providerAllowed(allowlist: ModelAllowlist, provider: string): boolean {
  return allowlist.providers.length === 0 || allowlist.providers.includes(provider);
}

function modelAllowed(allowlist: ModelAllowlist, ref: ModelRef): boolean {
  return allowlist.models.length === 0 || allowlist.models.includes(ref);
}

/**
 * `ctx.scopedModels` resolved into a lookup keyed by `provider/id`, plus
 * whether the raw setting is "configured" at all
 * (docs/model-registry-fields.md §4 rule 4).
 */
function resolveScope(snapshot: RegistrySnapshot): {
  readonly isConfigured: boolean;
  readonly byRef: ReadonlyMap<ModelRef, ScopedModelLike>;
} {
  const isConfigured = snapshot.enabledModelsConfigured === true || snapshot.scoped.length > 0;
  const byRef = new Map<ModelRef, ScopedModelLike>();
  for (const s of snapshot.scoped) byRef.set(toModelRef(s.model), s);
  return { isConfigured, byRef };
}

/**
 * Effective thinking-level cap for a model: the tighter of an
 * `enabledModels`/`--models` pin and an allowlist pin (rule 5, §4). Neither
 * is ever raised — both are passed through as-is; reconciling with the
 * live thinking-level system is a later concern (#57+), this module only
 * carries the two candidate pins forward.
 */
function thinkingLevelCap(scoped: ScopedModelLike | undefined): string | undefined {
  return scoped?.thinkingLevel;
}

/**
 * Build the eligible-model catalog: Pi registry ∩ enabled models ∩ allowlist,
 * with every excluded (configured-and-authenticated) model reported and why.
 *
 * Deterministic, synchronous, no I/O — `snapshot` must already reflect a
 * single point in time (e.g. captured in `session_start` or a model-registry
 * change handler; see module docs).
 */
export function buildCatalog(snapshot: RegistrySnapshot, config: CatalogConfig): CatalogResult {
  const { allowlist } = config;
  const overrides = config.overrides ?? {};
  const scope = resolveScope(snapshot);

  const entries: CatalogEntry[] = [];
  const excluded: ExcludedModel[] = [];

  for (const model of snapshot.available) {
    const ref = toModelRef(model);
    const provider = model.provider;

    if (scope.isConfigured && !scope.byRef.has(ref)) {
      excluded.push({
        id: ref,
        provider,
        reason: { kind: "not_scoped", detail: "not in Pi's enabledModels/--models scope for this session" },
      });
      continue;
    }
    if (!providerAllowed(allowlist, provider)) {
      excluded.push({
        id: ref,
        provider,
        reason: { kind: "provider_not_allowlisted", detail: `provider "${provider}" is not in models.allowlist.providers` },
      });
      continue;
    }
    if (!modelAllowed(allowlist, ref)) {
      excluded.push({
        id: ref,
        provider,
        reason: { kind: "model_not_allowlisted", detail: `"${ref}" is not in models.allowlist.models` },
      });
      continue;
    }
    if (overrides[ref]?.disabled === true) {
      excluded.push({
        id: ref,
        provider,
        reason: { kind: "disabled_by_override", detail: `"${ref}" is disabled by models.overrides` },
      });
      continue;
    }

    const route = routeFromRegistryModel(model);
    const cap = thinkingLevelCap(scope.byRef.get(ref));
    entries.push({
      id: ref,
      provider,
      name: model.name,
      routeId: route.routeId,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap ?? UNKNOWN,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: isZeroCost(model.cost) ? UNKNOWN : model.cost,
      ...(cap !== undefined ? { thinkingLevelCap: cap } : {}),
    });
  }

  return { entries, excluded };
}

/**
 * Serialise a catalog for logging/export. Guarantees layer-1 fields only —
 * useful for the "no URL or key" acceptance test, which can regex the
 * output rather than trusting field enumeration.
 */
export function serializeCatalog(result: CatalogResult): string {
  return JSON.stringify(result, null, 2);
}
