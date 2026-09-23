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
 * - `progress.ts` / `limits.ts` / `lifecycle.ts` — progress capture from the
 *   ADR 0004 RPC event stream, per-worker limit predicates, and the
 *   `WorkerRun` supervisor that reserves against the #30 ledger, captures
 *   artifacts and drives pause/resume/cancel (#71).
 * - `handoff.ts` — mid-task cap response: intact-worktree handoff (default)
 *   or restart to the last checkpoint, per `models.fallback.midTaskPolicy`
 *   task-kind policy (#64).
 * - `reconcile.ts` — crash-interrupted attempt reconciliation on startup:
 *   the runtime marker, the crash classifier and the probe handed to #23's
 *   `reconcileAbandonedAttempts` (#72).
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
export * from "./progress.ts";
export * from "./limits.ts";
export * from "./lifecycle.ts";
export * from "./handoff.ts";
export * from "./reconcile.ts";
