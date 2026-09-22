/**
 * Phases, state machine, scheduler, approvals, unattended policy, recovery, integration
 * ownership (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Implemented so far:
 * - `transitions.ts` / `approval-classes.ts` — Stage 1 data contracts (#13, #15).
 * - `intake.ts` / `intake-rules.ts` — `/korwf plan` intake, repo resolution, clarification,
 *   free-text classification with an explicit `unknown` outcome (#33, #34).
 * - `output-budget.ts` / `attempt-budget.ts` / `attempt-controller.ts` — task sizing against
 *   the model's `maxTokens`, and truncation classified as a harness failure (#124).
 * - `plan-schema.ts` / `plan-parse.ts` / `planner.ts` / `plan-store.ts` — structured plan
 *   generation with per-task verification checks (#37).
 * - `evaluate-plan.ts` — atomicity, coverage and readiness evaluators (#39).
 * - `graph.ts` — dependency-graph validation, ready set and topological order over persisted
 *   Task records; wired into `plan-store.ts` so an invalid graph can never be saved (#40).
 * - `greenfield.ts` — mandated phase 0 and plan-document retrieval fallback (#38).
 * - `state*.ts` / `invalidation.ts` / `blockers.ts` — runtime transitions (#41).
 * - `reconcile.ts` — session resume/reload/fork/tree reconciliation against live
 *   repository state, and the completed-action replay guard (#42).
 * - `failure.ts` / `stall.ts` — the PLAN §3.G failure taxonomy (deterministic rules first,
 *   `unknown` asks for evidence, truncation folded in from #124 as the `harness` category)
 *   and stall/scope-drift detection over the attempt stream (#52).
 *
 * **Re-export style: `export *`, deliberately.** This barrel previously listed every symbol
 * explicitly, which made it a guaranteed merge conflict: four consecutive PRs (#37, #38,
 * #39, #40) each appended an export block here and each had to be resolved by hand, for no
 * benefit — the resolution was always "keep both". `export *` is additive, so two modules
 * added in parallel do not conflict. A genuine duplicate-name clash still fails the build,
 * which is the outcome we actually want to hear about.
 */
export * from "./approval-classes.ts";
export * from "./attempt-budget.ts";
export * from "./attempt-controller.ts";
export * from "./evaluate-plan.ts";
export * from "./failure.ts";
export * from "./stall.ts";
export * from "./graph.ts";
export * from "./blockers.ts";
export * from "./boards.ts";
export * from "./greenfield.ts";
export * from "./invalidation.ts";
export * from "./intake.ts";
export * from "./intake-rules.ts";
export * from "./output-budget.ts";
export * from "./plan-parse.ts";
export * from "./plan-schema.ts";
export * from "./plan-store.ts";
export * from "./reconcile.ts";
export * from "./planner.ts";
export * from "./scope-change.ts";
export * from "./state.ts";
export * from "./transitions.ts";
export * from "./weak-checks.ts";
