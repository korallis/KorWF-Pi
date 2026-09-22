/**
 * Per-route usage attribution (issue #71, extending #30's ledger and #125's
 * route identity).
 *
 * A *route* is one rate-limited path to a model — a Pi provider key plus a
 * model id under it (ADR 0011). A user with two subscriptions to one vendor
 * has two providers exposing the same model id, backed by two independent
 * quotas, so usage attributed to a bare model id mixes two accounts and both
 * reports are wrong. Everything here therefore keys on `RouteId`.
 *
 * This module adds **no second accounting path**. The facts still live in the
 * #30 ledger rows; a charge names its route in `LedgerEntry.label` (the field
 * docs/records.md already reserves for "question id, task kind, route id"),
 * and these functions read that label back out. Nothing is stored twice.
 *
 * Unknown cost stays unknown. Summing a route's spend never turns an
 * unpriced call into `$0.00` (#56, #30): unpriced requests are counted
 * separately and `spendUsd` is `null` when nothing in the group was priced.
 */
import type { LedgerEntry, RouteId, Usage } from "../storage/records.ts";
import type { Route } from "../models/route.ts";

/** Label prefix that marks a ledger row as belonging to a route. */
export const ROUTE_LABEL_PREFIX = "route:" as const;

/** The `LedgerEntry.label` value for a route. */
export function routeLabel(routeId: RouteId): string {
  return `${ROUTE_LABEL_PREFIX}${routeId}`;
}

/** Route id carried by a ledger label, or `null` when the label is not a route. */
export function parseRouteLabel(label: string | null | undefined): RouteId | null {
  if (typeof label !== "string" || !label.startsWith(ROUTE_LABEL_PREFIX)) return null;
  const id = label.slice(ROUTE_LABEL_PREFIX.length);
  return id.length === 0 ? null : (id as RouteId);
}

/** Usage totals for one route. */
export interface RouteUsage {
  readonly routeId: RouteId;
  /** Provider key the route belongs to, when the caller supplied the route. */
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly requests: number;
  /** `null` when no charge in this group carried a dollar figure. */
  readonly spendUsd: number | null;
  /** Requests whose cost the registry did not state. Never folded into spend. */
  readonly unknownCostRequests: number;
  readonly estimatedSpendUsd: number;
  readonly knownSpendUsd: number;
}

function emptyRouteUsage(routeId: RouteId): {
  routeId: RouteId;
  providerId: string | null;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  spendUsd: number | null;
  unknownCostRequests: number;
  estimatedSpendUsd: number;
  knownSpendUsd: number;
} {
  return {
    routeId,
    providerId: null,
    modelId: null,
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
    spendUsd: null,
    unknownCostRequests: 0,
    estimatedSpendUsd: 0,
    knownSpendUsd: 0,
  };
}

/** Add one `Usage` into a mutable route accumulator. */
function addUsage(acc: ReturnType<typeof emptyRouteUsage>, usage: Usage): void {
  acc.inputTokens += usage.inputTokens ?? 0;
  acc.outputTokens += usage.outputTokens ?? 0;
  acc.requests += usage.requests;
  if (usage.costBasis === "unknown" || usage.spendUsd === null) {
    acc.unknownCostRequests += usage.requests;
    return;
  }
  acc.spendUsd = (acc.spendUsd ?? 0) + usage.spendUsd;
  if (usage.costBasis === "estimated") acc.estimatedSpendUsd += usage.spendUsd;
  else acc.knownSpendUsd += usage.spendUsd;
}

/**
 * Sum settled ledger rows per route.
 *
 * Only `settlement` and `abandonment` rows count: a `reservation` is a claim
 * that has not happened yet and a `release` is a claim that never happened,
 * so counting either would double-count or invent usage. `routes` is an
 * optional lookup that decorates the result with the provider and model the
 * route was derived from.
 */
export function summariseUsageByRoute(
  entries: Iterable<Pick<LedgerEntry, "entryKind" | "label" | "usage">>,
  routes: Iterable<Route> = [],
): Map<RouteId, RouteUsage> {
  const byId = new Map<RouteId, Route>();
  for (const route of routes) byId.set(route.routeId, route);

  const acc = new Map<RouteId, ReturnType<typeof emptyRouteUsage>>();
  for (const entry of entries) {
    if (entry.entryKind !== "settlement" && entry.entryKind !== "abandonment") continue;
    const routeId = parseRouteLabel(entry.label);
    if (routeId === null) continue;
    const current = acc.get(routeId) ?? emptyRouteUsage(routeId);
    addUsage(current, entry.usage);
    const route = byId.get(routeId);
    if (route !== undefined) {
      current.providerId = route.providerId;
      current.modelId = route.modelId;
    }
    acc.set(routeId, current);
  }
  const out = new Map<RouteId, RouteUsage>();
  for (const [routeId, value] of acc) out.set(routeId, { ...value });
  return out;
}

/**
 * Combine several `Usage` values into one, preserving the honesty rule: the
 * result is `unknown` (with `spendUsd === null`) unless at least one input
 * carried a figure, and it is `estimated` if any contributing figure was an
 * estimate. Unpriced inputs still contribute their tokens and requests.
 */
export function mergeUsage(usages: Iterable<Usage>): Usage {
  let inputTokens = 0;
  let outputTokens = 0;
  let requests = 0;
  let spend: number | null = null;
  let sawEstimate = false;
  let sawAny = false;
  for (const usage of usages) {
    sawAny = true;
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    requests += usage.requests;
    if (usage.costBasis === "unknown" || usage.spendUsd === null) continue;
    spend = (spend ?? 0) + usage.spendUsd;
    if (usage.costBasis === "estimated") sawEstimate = true;
  }
  if (!sawAny) return { inputTokens: 0, outputTokens: 0, requests: 0, spendUsd: null, costBasis: "unknown" };
  if (spend === null) {
    return { inputTokens, outputTokens, requests, spendUsd: null, costBasis: "unknown" };
  }
  return { inputTokens, outputTokens, requests, spendUsd: spend, costBasis: sawEstimate ? "estimated" : "known" };
}
