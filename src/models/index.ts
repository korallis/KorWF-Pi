/**
 * Catalog, model cards, task profiles, Jev selection, caps/fallback
 * (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Implemented so far:
 * - `route.ts` — opaque `routeId` per (provider, model) pair (#125).
 * - `availability.ts` — route-keyed caps and deterministic route selection (#125).
 * - `outcomes.ts` — per-route outcome attribution helpers (#125).
 *
 * Catalog/cards (#10 follow-ups), Jev selection and cap detection (#62),
 * health/breakers (#123) build on these and key on `RouteId`.
 */
export {
  ROUTE_ID_PREFIX,
  deriveRouteId,
  toModelRef,
  makeRoute,
  routeFromRegistryModel,
  routesFromRegistry,
  routesForModel,
  hasMultiRouteModels,
  routeLabel,
} from "./route.ts";
export type { Route, RouteId, RegistryModelLike } from "./route.ts";
export { RouteAvailabilityTable, selectRoute, rankRoutes } from "./availability.ts";
export type { RouteAvailability, CapObservation, RouteSelection } from "./availability.ts";
export { attributeOutcome, summariseOutcomesByRoute } from "./outcomes.ts";
export type { OutcomeAttribution, RouteOutcomeSummary } from "./outcomes.ts";
