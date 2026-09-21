/**
 * Route identity (issue #125; PRD §2, §3.4; PLAN §3.D "Caps and fallback").
 *
 * A *route* is one rate-limited path to a model: a Pi provider entry plus a
 * model id under it. Pi's `models.json` provider keys are arbitrary,
 * user-chosen names, each with its own `baseUrl` and `apiKey`
 * (Pi docs/models.md), so a user with two subscriptions to one vendor has
 * two providers exposing the same model id, backed by two independent quotas.
 * Anything that tracks quota, health or outcomes must therefore be keyed on
 * the route, not the model id. Model *cards* stay per model: aptitude does
 * not vary by account.
 *
 * `RouteId` is opaque: a hash of `(providerId, modelId)`. It carries no
 * meaning, is never parsed, and is stable for as long as the user keeps the
 * same provider key. Renaming a provider key yields a new route — see
 * docs/adr/0011-route-identity.md for why that is deliberate.
 *
 * Pure module: no I/O, no Pi imports, no provider names.
 */
import { createHash } from "node:crypto";
import type { ModelRef, RouteId } from "../storage/records.ts";

export type { RouteId };

/** Version prefix so a future derivation change cannot collide with v1 ids. */
export const ROUTE_ID_PREFIX = "r1_" as const;

/** A resolved route: identity plus the two components it was derived from. */
export interface Route {
  readonly routeId: RouteId;
  /** Pi provider key exactly as configured (e.g. the user's own name for it). */
  readonly providerId: string;
  /** Bare model id under that provider; joins to the model card. */
  readonly modelId: string;
  /** `provider/model`, the form Pi and the allowlist use. */
  readonly ref: ModelRef;
}

/** Minimal shape of a Pi registry entry this module needs. */
export interface RegistryModelLike {
  readonly provider: string;
  readonly id: string;
}

/**
 * Derive the opaque route id for a provider/model pair. Deterministic and
 * injective over well-formed inputs: the two components are length-prefixed
 * before hashing so `("ab","c")` and `("a","bc")` cannot collide.
 */
export function deriveRouteId(providerId: string, modelId: string): RouteId {
  if (providerId.length === 0) throw new Error("deriveRouteId: providerId must not be empty");
  if (modelId.length === 0) throw new Error("deriveRouteId: modelId must not be empty");
  const h = createHash("sha256");
  h.update(`${providerId.length}:${providerId}|${modelId.length}:${modelId}`);
  return `${ROUTE_ID_PREFIX}${h.digest("hex").slice(0, 32)}` as RouteId;
}

/** `provider/model` reference for a pair. */
export function toModelRef(providerId: string, modelId: string): ModelRef {
  return `${providerId}/${modelId}`;
}

/** Build a `Route` from its components. */
export function makeRoute(providerId: string, modelId: string): Route {
  return {
    routeId: deriveRouteId(providerId, modelId),
    providerId,
    modelId,
    ref: toModelRef(providerId, modelId),
  };
}

/** Build a `Route` from a Pi registry entry. */
export function routeFromRegistryModel(model: RegistryModelLike): Route {
  return makeRoute(model.provider, model.id);
}

/**
 * Enumerate every route Pi exposes. One entry per `(provider, id)` pair;
 * duplicates in the input collapse. The same model id under two providers
 * yields two routes (AC: "two providers exposing the same model id are
 * tracked as two distinct routes").
 */
export function routesFromRegistry(models: Iterable<RegistryModelLike>): Route[] {
  const seen = new Map<RouteId, Route>();
  for (const m of models) {
    const r = routeFromRegistryModel(m);
    if (!seen.has(r.routeId)) seen.set(r.routeId, r);
  }
  return [...seen.values()];
}

/** All routes that serve a given bare model id (any provider). */
export function routesForModel(routes: readonly Route[], modelId: string): Route[] {
  return routes.filter((r) => r.modelId === modelId);
}

/** `true` when some model id is served by more than one route. */
export function hasMultiRouteModels(routes: readonly Route[]): boolean {
  const counts = new Map<string, number>();
  for (const r of routes) counts.set(r.modelId, (counts.get(r.modelId) ?? 0) + 1);
  for (const n of counts.values()) if (n > 1) return true;
  return false;
}

/**
 * Human label that disambiguates routes in `/korwf models` and
 * `/korwf status`. Always `provider/model` — the provider key is the user's
 * own name for the account, so it is the natural disambiguator — followed by
 * a short route-id suffix so two entries are distinguishable even when the
 * user has (unhelpfully) given two providers visually similar keys.
 */
export function routeLabel(route: Route): string {
  return `${route.ref} [${route.routeId.slice(ROUTE_ID_PREFIX.length, ROUTE_ID_PREFIX.length + 8)}]`;
}
