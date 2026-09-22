/**
 * Retrieval, ranking, provenance and pinned context (issue #35; PLAN §3.B).
 *
 * Retrieval (`retrieve.ts`) uses ordinary search tools only. Ranking
 * (`rank.ts`) is the one place a bounded candidate set is sent to Jev, via
 * the versioned questions in `src/decisions/questions/context.ts`. Every
 * excerpt carries the shared `Provenance` record. Pins (`pins.ts`) are
 * preserved regardless of ranking.
 *
 * **Re-export style: `export *`, deliberately.** Listing every symbol explicitly makes this
 * barrel a guaranteed merge conflict: four consecutive PRs each appended an export block to
 * `src/workflow/index.ts` and each had to be resolved by hand, always by keeping both.
 * `export *` is additive, so modules added in parallel do not conflict; a genuine
 * duplicate-name clash still fails the build, which is what we want to hear about.
 */
export * from "./artifacts.ts";
export * from "./capabilities.ts";
export * from "./pins.ts";
export * from "./plan-document.ts";
export * from "./provenance.ts";
export * from "./rank.ts";
export * from "./retrieve.ts";
export * from "./types.ts";
