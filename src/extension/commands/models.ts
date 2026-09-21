/**
 * `/korwf models` and `/korwf status` route listings (issue #125).
 *
 * Both commands render *routes* — one line per (provider, model id) pair —
 * so a user who has the same model id under two providers sees two
 * distinguishable entries with their route ids and per-route cap state.
 * Issue #66 extends these commands with switches, fallbacks and running
 * cost; this module provides the route-aware rendering they build on.
 *
 * Pure formatting: the extension entry passes in whatever Pi's registry
 * exposes; nothing here touches Pi, the network, or sensitive fields
 * (`baseUrl`, `apiKey`, `headers` are never read).
 */
import { routesFromRegistry, routeLabel, hasMultiRouteModels, type RegistryModelLike, type Route } from "../../models/route.ts";
import { RouteAvailabilityTable } from "../../models/availability.ts";
import type { IsoTimestamp } from "../../storage/records.ts";

export interface RouteListingInput {
  readonly models: readonly RegistryModelLike[];
  readonly availability?: RouteAvailabilityTable;
  readonly now: IsoTimestamp;
}

function capSuffix(route: Route, table: RouteAvailabilityTable | undefined, now: IsoTimestamp): string {
  const row = table?.get(route.routeId);
  if (row === undefined || row.capKind === "none") return "available";
  const eligible = table!.isEligible(route.routeId, now);
  const reset = row.estimatedReset === null ? "reset unknown" : `reset ${row.estimatedReset}`;
  return eligible ? `cap cleared (${row.capKind}, ${reset})` : `capped (${row.capKind}, ${reset})`;
}

/** One line per route: `provider/model [routeId8]  <state>`. */
export function renderRouteLines(input: RouteListingInput): string[] {
  const routes = routesFromRegistry(input.models);
  return routes.map((r) => `${routeLabel(r)}  ${capSuffix(r, input.availability, input.now)}`);
}

/** Text printed by `/korwf models`. */
export function modelsMessage(input: RouteListingInput): string {
  const lines = renderRouteLines(input);
  if (lines.length === 0) return "korwf models: no models available from Pi (configure providers in models.json).";
  const routes = routesFromRegistry(input.models);
  const header = `korwf models: ${routes.length} route${routes.length === 1 ? "" : "s"}`;
  const note = hasMultiRouteModels(routes)
    ? "note: a model id served by more than one provider is tracked as separate routes with independent caps."
    : null;
  return [header, ...lines, ...(note === null ? [] : [note])].join("\n");
}

/** Text printed by `/korwf status` (route section; #66 adds the rest). */
export function statusMessage(input: RouteListingInput): string {
  const routes = routesFromRegistry(input.models);
  const table = input.availability;
  const capped = routes.filter((r) => table !== undefined && !table.isEligible(r.routeId, input.now));
  const summary = `korwf status: ${routes.length} route${routes.length === 1 ? "" : "s"}, ${capped.length} capped`;
  if (capped.length === 0) return summary;
  return [summary, ...capped.map((r) => `  ${routeLabel(r)}  ${capSuffix(r, table, input.now)}`)].join("\n");
}
