/**
 * Per-route outcome attribution (issue #125; PLAN §5 `ModelOutcome`).
 *
 * `ModelOutcome` rows are append-only facts about one attempt on one route.
 * Card refinement (layer 4, M7) reads them *per model* for aptitude, but any
 * health or reliability signal must be read *per route*, because one
 * account's poor results (timeouts, quota churn) say nothing about another
 * account's. These helpers make the per-route grouping the default path.
 */
import type { EnvelopeFields, ModelOutcome, OutcomeResult, RouteId } from "../storage/records.ts";
import type { Route } from "./route.ts";

/** `ModelOutcome` minus the store envelope: what a caller supplies. */
export type OutcomeAttribution = Omit<ModelOutcome, EnvelopeFields>;

/** Stamp an outcome with the route it ran on. `model` is set from the route for consistency. */
export function attributeOutcome(
  route: Route,
  outcome: Omit<OutcomeAttribution, "routeId" | "model">,
): OutcomeAttribution {
  return { ...outcome, routeId: route.routeId, model: route.ref };
}

export interface RouteOutcomeSummary {
  readonly routeId: RouteId;
  readonly total: number;
  readonly byResult: Readonly<Record<OutcomeResult, number>>;
  /** succeeded / total; `null` when there are no outcomes. */
  readonly successRate: number | null;
}

const EMPTY: Record<OutcomeResult, number> = { succeeded: 0, failed: 0, needs_changes: 0, cancelled: 0, handed_off: 0 };

/** Group outcomes by route. Outcomes for the same model id on another route never mix. */
export function summariseOutcomesByRoute(
  outcomes: Iterable<Pick<ModelOutcome, "routeId" | "result">>,
): Map<RouteId, RouteOutcomeSummary> {
  const acc = new Map<RouteId, Record<OutcomeResult, number>>();
  for (const o of outcomes) {
    const counts = acc.get(o.routeId) ?? { ...EMPTY };
    counts[o.result] += 1;
    acc.set(o.routeId, counts);
  }
  const out = new Map<RouteId, RouteOutcomeSummary>();
  for (const [routeId, byResult] of acc) {
    const total = Object.values(byResult).reduce((a, b) => a + b, 0);
    out.set(routeId, { routeId, total, byResult, successRate: total === 0 ? null : byResult.succeeded / total });
  }
  return out;
}
