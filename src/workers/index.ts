/**
 * Subprocess lifecycle, contracts, role loading, handoff to workers (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Implemented so far:
 * - `truncation.ts` — `stopReason` capture and harness/quality classification (#124).
 * - `roles.ts` — shipped worker role contracts from `resources/roles/` (#124).
 *
 * **Re-export style: `export *`, deliberately.** Listing every symbol explicitly makes this
 * barrel a guaranteed merge conflict: four consecutive PRs each appended an export block to
 * `src/workflow/index.ts` and each had to be resolved by hand, always by keeping both.
 * `export *` is additive, so modules added in parallel do not conflict; a genuine
 * duplicate-name clash still fails the build, which is what we want to hear about.
 */
export * from "./roles.ts";
export * from "./truncation.ts";
export * from "./contract.ts";
export * from "./env.ts";
export * from "./process-tree.ts";
export * from "./spawn.ts";
export * from "./surface.ts";
