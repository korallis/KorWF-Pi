/**
 * Catalog, model cards, task profiles, Jev selection, caps/fallback
 * (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Implemented so far:
 * - `route.ts` — opaque `routeId` per (provider, model) pair (#125).
 * - `availability.ts` — route-keyed caps and deterministic route selection (#125).
 * - `outcomes.ts` — per-route outcome attribution helpers (#125).
 * - `catalog.ts` — eligible-model catalog: registry ∩ enabled models ∩ allowlist, no credentials (#56).
 * - `cards.ts` — four-layer model card merge: registry (excludes) < hints < user overrides < measured
 *   outcomes with a Wilson interval (#57). Registry metadata never appears here as ranking
 *   material — only hints, overrides, and outcomes rank.
 *
 *
 * **Re-export style: `export *`, deliberately.** A barrel listing every symbol is a
 * guaranteed conflict between parallel branches — #57 and #62 collided here on the same
 * day, as #37-#40 did in `src/workflow/index.ts`. `export *` is additive; a genuine
 * duplicate-name clash still fails the build, which is the outcome worth hearing about.
 */
export * from "./availability.ts";
export * from "./cap-detect.ts";
export * from "./cards.ts";
export * from "./catalog.ts";
export * from "./outcomes.ts";
export * from "./route.ts";
