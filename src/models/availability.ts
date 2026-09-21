/**
 * Route-keyed availability and deterministic route selection
 * (issue #125; PLAN §3.D "Caps and fallback"; PRD §3.4).
 *
 * Every cap is attributed to the *route* that produced it, never to the bare
 * model id. A 429 on one provider account therefore leaves the same model id
 * under another provider eligible, and "all candidates capped" is only true
 * when every *route* is capped.
 *
 * Pure and clock-free: callers pass `now`. No Jev involvement — route
 * identity and cap attribution are deterministic by design (AC: works with
 * Jev disabled). Cap *detection* from transport errors is #62; health and
 * breakers are #123; both key on `RouteId` from here.
 */
import type { CapKind, EnvelopeFields, IsoTimestamp, ModelAvailability, ModelRef, RouteId } from "../storage/records.ts";
import type { Route } from "./route.ts";

/** `ModelAvailability` minus the store envelope: what this module tracks in memory. */
export type RouteAvailability = Omit<ModelAvailability, EnvelopeFields>;

export interface CapObservation {
  readonly capKind: Exclude<CapKind, "none">;
  readonly at: IsoTimestamp;
  /** `null` when the provider gave no reset hint. */
  readonly estimatedReset: IsoTimestamp | null;
  readonly detail?: string | null;
}

function available(route: Route, at: IsoTimestamp | null): RouteAvailability {
  return {
    routeId: route.routeId,
    providerId: route.providerId,
    modelId: route.modelId,
    capKind: "none",
    detectedAt: null,
    estimatedReset: null,
    lastProbe: at === null ? null : { at, result: "available", detail: null },
  };
}

/**
 * In-memory table of per-route availability. Immutable-by-convention: every
 * mutator returns the table for chaining but the entries it hands out are
 * frozen snapshots. Persisting rows to the store (#23) is a later concern;
 * this shape matches `ModelAvailability` field-for-field.
 */
export class RouteAvailabilityTable {
  private readonly rows = new Map<RouteId, RouteAvailability>();

  static fromRows(rows: Iterable<RouteAvailability>): RouteAvailabilityTable {
    const t = new RouteAvailabilityTable();
    for (const r of rows) t.rows.set(r.routeId, r);
    return t;
  }

  get(routeId: RouteId): RouteAvailability | undefined {
    return this.rows.get(routeId);
  }

  /** Every row, in insertion order. */
  snapshot(): readonly RouteAvailability[] {
    return [...this.rows.values()];
  }

  /** Record a cap on exactly one route. Other routes — including other routes to the same model id — are untouched. */
  markCapped(route: Route, cap: CapObservation): this {
    this.rows.set(route.routeId, {
      ...available(route, null),
      capKind: cap.capKind,
      detectedAt: cap.at,
      estimatedReset: cap.estimatedReset,
      lastProbe: { at: cap.at, result: "capped", detail: cap.detail ?? null },
    });
    return this;
  }

  /** Record a successful probe or request; clears any cap on that route. */
  markAvailable(route: Route, at: IsoTimestamp): this {
    this.rows.set(route.routeId, available(route, at));
    return this;
  }

  /**
   * A route is eligible when it has never been capped, its cap was cleared, or
   * its estimated reset has passed (PLAN §3.D: retry at the next task
   * boundary once the cap is estimated to have cleared). A cap with no reset
   * estimate stays in force until `markAvailable`.
   */
  isEligible(routeId: RouteId, now: IsoTimestamp): boolean {
    const row = this.rows.get(routeId);
    if (row === undefined || row.capKind === "none") return true;
    return row.estimatedReset !== null && row.estimatedReset <= now;
  }

  /** Drop rows for routes Pi no longer exposes (e.g. a renamed provider key). Returns the dropped ids. */
  prune(known: Iterable<RouteId>): RouteId[] {
    const keep = new Set(known);
    const dropped: RouteId[] = [];
    for (const id of this.rows.keys()) {
      if (!keep.has(id)) {
        this.rows.delete(id);
        dropped.push(id);
      }
    }
    return dropped;
  }
}

export type RouteSelection =
  | { readonly kind: "selected"; readonly route: Route; readonly rank: number }
  | { readonly kind: "all_capped"; readonly earliestReset: IsoTimestamp | null }
  | { readonly kind: "no_candidates" };

/**
 * Deterministic selection: the first eligible route in rank order.
 *
 * `staticOrder` lists `provider/model` refs (config `fallback.staticOrder`);
 * routes named there come first in that order, then the rest in registry
 * order. Because each ref names a provider, the same model id under a second
 * provider is a distinct, legitimately ranked candidate — so when the
 * first is capped, selection falls through to it instead of pausing.
 *
 * Jev, when enabled, may reorder *eligible* routes upstream of this; it never
 * decides eligibility (PRD §3.1: health is a hard filter, not a Jev input).
 */
export function selectRoute(
  candidates: readonly Route[],
  table: RouteAvailabilityTable,
  now: IsoTimestamp,
  staticOrder: readonly ModelRef[] = [],
): RouteSelection {
  if (candidates.length === 0) return { kind: "no_candidates" };
  const ranked = rankRoutes(candidates, staticOrder);
  for (let i = 0; i < ranked.length; i++) {
    const route = ranked[i]!;
    if (table.isEligible(route.routeId, now)) return { kind: "selected", route, rank: i };
  }
  let earliest: IsoTimestamp | null = null;
  for (const route of ranked) {
    const reset = table.get(route.routeId)?.estimatedReset ?? null;
    if (reset !== null && (earliest === null || reset < earliest)) earliest = reset;
  }
  return { kind: "all_capped", earliestReset: earliest };
}

/** Stable ordering: entries of `staticOrder` first (in that order), then the rest in input order. */
export function rankRoutes(candidates: readonly Route[], staticOrder: readonly ModelRef[]): Route[] {
  const position = new Map<ModelRef, number>();
  staticOrder.forEach((ref, i) => {
    if (!position.has(ref)) position.set(ref, i);
  });
  const pinned: Route[] = [];
  const rest: Route[] = [];
  for (const r of candidates) (position.has(r.ref) ? pinned : rest).push(r);
  pinned.sort((a, b) => position.get(a.ref)! - position.get(b.ref)!);
  return [...pinned, ...rest];
}
