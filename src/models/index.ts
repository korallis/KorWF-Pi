/**
 * Catalog, model cards, task profiles, Jev selection, caps/fallback
 * (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Implemented so far:
 * - `route.ts` — opaque `routeId` per (provider, model) pair (#125).
 * - `availability.ts` — route-keyed caps and deterministic route selection (#125).
 * - `outcomes.ts` — per-route outcome attribution helpers (#125).
 * - `catalog.ts` — eligible-model catalog: registry ∩ enabled models ∩ allowlist, no credentials (#56).
 *
 * Model cards (#57), Jev selection and cap detection (#62), health/breakers
 * (#123) build on these and key on `RouteId`.
 *
 * **Re-export style: `export *`, deliberately.** Listing every symbol explicitly makes this
 * barrel a guaranteed merge conflict: four consecutive PRs each appended an export block to
 * `src/workflow/index.ts` and each had to be resolved by hand, always by keeping both.
 * `export *` is additive, so modules added in parallel do not conflict; a genuine
 * duplicate-name clash still fails the build, which is what we want to hear about.
 */
export * from "./availability.ts";
export * from "./catalog.ts";
export * from "./outcomes.ts";
export * from "./route.ts";
