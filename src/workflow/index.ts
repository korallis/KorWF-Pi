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
 * - `recovery.ts` — bounded recovery policies chosen from that taxonomy, and side-effect
 *   reconciliation (over #42's receipts) before any retry (#53).
 * - `scheduler.ts` — the dependency-aware dispatch loop: ready-task selection over
 *   `graph.ts`, a transactional claim that makes a duplicate dispatch lose, the
 *   concurrency cap, ownership/coupling serialisation, and a cancel drain (#75).
 * - `coupling.ts` — glob-intersection ownership overlap, the revision-keyed coupling
 *   cache behind `canRunConcurrently`, and the rule that a writing worker never runs in
 *   the user's main tree (#76).
 * - `checkpoint.ts` — working-tree checkpoints, the dirty-tree guard, and rollback as an
 *   approval-gated PROPOSAL that never discards uncommitted user work (#54).
 * - `integrate.ts` — the single-owner integration queue: a durable FIFO, the
 *   integration lease (#77's lock mechanism on its own file) that makes two
 *   simultaneous finishers merge sequentially, the base-revision check that
 *   sends work whose base moved back through #50 instead of merging it on
 *   trust, the merge-conflict workflow (bounded resolution task restricted to
 *   the conflicted paths, re-verified; unresolved ⇒ phase blocked and
 *   notified), and `proposeUserBranchMerge`, which only ever *asks* for the
 *   high-risk `merge_to_user_branch` approval (#78).
 * - `budget-stops.ts` — the scheduler's reaction to a #30 ledger cap refusal: a latch so no
 *   task starts after a cumulative cap is reached, a pause through #74's `stopRun` into the
 *   same resumable shape #72 produces, resume after the user raises the cap, and remaining
 *   budget per scope for status (#81). It enforces no caps of its own.
 *
 * **Re-export style: `export *`, deliberately.** This barrel previously listed every symbol
 * explicitly, which made it a guaranteed merge conflict: four consecutive PRs (#37, #38,
 * #39, #40) each appended an export block here and each had to be resolved by hand, for no
 * benefit — the resolution was always "keep both". `export *` is additive, so two modules
 * added in parallel do not conflict. A genuine duplicate-name clash still fails the build,
 * which is the outcome we actually want to hear about.
 */
export * from "./approval-classes.ts";
export * from "./approvals.ts";
export * from "./attempt-budget.ts";
export * from "./attempt-controller.ts";
export * from "./checkpoint.ts";
export * from "./coupling.ts";
export * from "./evaluate-plan.ts";
export * from "./failure.ts";
export * from "./failure-classify.ts";
export * from "./stall.ts";
export * from "./graph.ts";
export * from "./blockers.ts";
export * from "./coordinator.ts";
export * from "./boards.ts";
export * from "./budget-stops.ts";
export * from "./greenfield.ts";
export * from "./integrate.ts";
export * from "./invalidation.ts";
export * from "./intake.ts";
export * from "./intake-rules.ts";
export * from "./output-budget.ts";
export * from "./plan-parse.ts";
export * from "./plan-schema.ts";
export * from "./plan-store.ts";
export * from "./reconcile.ts";
export * from "./recovery.ts";
export * from "./planner.ts";
export * from "./scheduler.ts";
export * from "./scope-change.ts";
export * from "./state.ts";
export * from "./transitions.ts";
export * from "./weak-checks.ts";
