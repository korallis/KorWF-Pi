/**
 * Subprocess lifecycle, contracts, role loading, handoff to workers (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Implemented so far:
 * - `truncation.ts` — `stopReason` capture and harness/quality classification (#124).
 * - `roles.ts` — shipped worker role contracts and per-role tool allowlists (#124, #68).
 * - `contract.ts` — `WorkerContract` and pre-spawn validation (#68).
 * - `env.ts` — credential scrubbing and the depth marker (#68).
 * - `process-tree.ts` / `spawn.ts` — launch, RPC framing, three-tier cancel (#68).
 * - `surface.ts` — best-effort worktree Space visibility (#68).
 * - `worktree.ts` — attempt worktree lifecycle under `.korwf/worktrees/<attempt>`,
 *   built from the base revision, never touching the main tree (#70).
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
export * from "./worktree.ts";
export * from "./tool-gate.ts";
