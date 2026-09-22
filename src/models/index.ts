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
 * - `hints.ts` — bundled aptitude hints (#58): id-pattern matching against `resources/hints.json`,
 *   ignoring provider prefixes and cosmetic (date/quant) suffixes so proxied names still match.
 * - `profile.ts` — task-profile evaluator, independent of model names (#59). Composes
 *   `src/decisions/questions/profile.ts` (domain/reasoningDepth/contextSize) with
 *   deterministic modality/risk signals into a `TaskProfile`; never imports this barrel's
 *   own catalog/cards/cap-detect/route modules and never handles a `ModelRef`.
 * - `select.ts` — Jev selection against cards (#60): code computes the eligible set
 *   (allowlist, hard constraints, route availability), Jev ranks it via `models.rank@1`
 *   (`src/decisions/questions/models.ts`), and `enforcePolicy` re-checks the winner
 *   against the allowlist/eligible-set/budget before it is ever used — a Jev answer can
 *   only narrow, never widen, what selection returns.
 * - `pins.ts` — user pins (#61): `resolvePin` resolves task > phase > workflow > config
 *   scope; `selectModel`'s `pin` param, when set, is honoured ahead of any Jev ranking, but
 *   still passes through `enforcePolicy` — a pin that is capped or fails allowlist/budget
 *   never falls back silently, it returns `pin_blocked` for the caller to raise the
 *   `model_substitute_pinned` approval class and ask.
 *
 *
 * **Re-export style: `export *`, deliberately.** A barrel listing every symbol is a
 * guaranteed conflict between parallel branches — #57 and #62 collided here on the same
 * day, as #37-#40 did in `src/workflow/index.ts`. `export *` is additive; a genuine
 * duplicate-name clash still fails the build, which is the outcome worth hearing about.
 */
export * from "./availability.ts";
export * from "./cap-detect.ts";
export * from "./cap-pause.ts";
export * from "./fallback.ts";
export * from "./cards.ts";
export * from "./catalog.ts";
export * from "./hints.ts";
export * from "./outcomes.ts";
export * from "./profile.ts";
export * from "./pins.ts";
export * from "./route.ts";
export * from "./select.ts";
