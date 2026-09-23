# KorWF-Pi — TODO

Design, records, gates, and acceptance criteria live in [PLAN.md](PLAN.md); section references below point there. This file tracks work items only. Order reflects the build sequence (PLAN §8). Full scope is one deliverable.

## 0. Approvals (PLAN §11)

- [x] Create project folder, PLAN.md, TODO.md.
- [ ] Authorization to implement.
- [ ] TypeSafe key availability and secret mechanism agreed.
- [ ] Pilot repository, sample tasks, data-sharing restrictions.
- [ ] Live test budgets (spend/token/request/concurrency).
- [ ] Pilot operating mode and approval classes.
- [ ] Sandbox setup and dependency permissions.

## 1. Discovery and contracts (PLAN §8 Stage 1)

- [x] Read relevant Pi docs and cross-references completely.
- [x] Produce reuse/extend/replace table for the shipped examples listed in PLAN §4; revise source layout. (#8 → `docs/adr/0001`, `docs/adr/0002`)
- [x] Verify current TypeSafe API, JS SDK, Jev model versions, limits, pricing, retention.
- [x] Confirm `ctx.modelRegistry.getAvailable()` / `ctx.scopedModels` field set at runtime (id, provider, name, reasoning, thinkingLevelMap, input, contextWindow, maxTokens, cost) and how `enabledModels` scoping interacts with the allowlist.
- [x] Draft config schema (allowlist, budgets, modes, approval classes, privacy lists, fallback policy, static fallback order, Jev base URL/key source). (#11)
- [x] Define all records (PLAN §5) including Phase, ModelAvailability, ModelOutcome, and Attempt fallback fields.
- [x] Define task and phase state transitions, `paused(cap)`, approval invalidation.
- [x] Write the task gate and phase gate formulas (PLAN §2.4–2.5) as testable specs.
- [x] Define unattended approval classes (auto / queue / stop) (PLAN §2.6). (#15)
- [x] Select worker interface (subagent example vs SDK vs RPC).
- [x] Record architecture decisions and threat boundaries. (#17 → `docs/threat-model.md`, `docs/adr/0006`–`0010`, `docs/adr/README.md`)
- [x] Write scenarios 2.8 as acceptance test outlines.

## 2. Package and adapter foundation (Stage 2)

- [x] Initialise Git; package manifest per `docs/packages.md`; modular layout; namespaced commands/tools/storage.
- [x] Formatting, type checking, unit and integration test scripts.
- [x] Config loading, validation, safe defaults, first-use disclosure. (#21)
- [x] Credential resolution; secrets excluded from all logs and exports. (#22)
- [x] SQLite store, migrations, lockfile ownership, append-only audit, artifact directory.
- [x] Jev transport behind mockable interface; configurable base URL; optional mode when no key.
- [x] Response validation for Choice/Score/Noul (unknown fields, bounds, malformed).
- [x] Cancellation, deadlines, bounded retries, backoff, circuit breaking. (#26)
- [x] Versioned question definitions and composition policy.
- [x] Minimal-state construction, outbound limits, default-deny path/data filtering.
- [x] Revision-aware caching and invalidation.
- [x] Usage accounting; atomic budget reservations; known/estimated/unknown cost.
- [x] Decision traces; retention; raw-payload logging opt-in. (#31)
- [x] Isolated-session load test; no-key load test; lifecycle cleanup test. (#32)

## 3. Context, planning, phases, durable tasks (Stage 3)

- [x] `plan` command; intake for existing-repo and greenfield; clarification questions. (#33)
- [x] Free-text intake classification with unknown/clarify outcomes; deterministic fast paths.
- [x] Candidate retrieval; bounded context-evaluation tool; relevance/staleness/contradiction evaluators; provenance; shortlist expansion; pinned context. (#35)
- [x] Optional skill/tool discovery and ranking; mandatory skill triggers preserved.
- [x] Structured plan generation: architecture, phases, tasks, dependencies, ownership, acceptance criteria, per-task checks (PLAN §2.3).
- [x] Greenfield bootstrap: repo init, scaffolding phase, test infrastructure tasks first. (#38)
- [x] Atomicity/coverage/readiness evaluators; "no checks → not ready" rule.
- [x] Dependency validation and cycle detection.
- [x] Task and phase transitions, blockers, revision tracking, reapproval, scope-change handling. (#41 → `src/workflow/state.ts`, `blockers.ts`, `invalidation.ts`, `scope-change.ts`)
- [x] Session resume/reload/fork/tree reconciliation with live repo state. (#42 → `src/workflow/reconcile.ts`, `src/extension/session-hooks.ts`, `src/git/revision.ts`, `src/storage/action-log.ts`, `docs/session-reconciliation.md`)
- [x] `tasks` and `phases` boards; plan/TODO export. (#43)
- [x] Prompt-injection and misleading-description tests. (#44 → `test/security/injection-stage3.test.ts`, `test/fixtures/repo-injection/`, `src/workflow/weak-checks.ts`)
- [x] Output-budget awareness: planner sizes tasks against the model's `maxTokens`; `stopReason: "length"` recorded and classified as a harness failure that neither consumes the attempt budget nor feeds "criteria unmet" back; repeated truncation bounded separately; role contracts instruct incremental writes and per-file commits (#124 → `docs/output-budget.md`).

## 4. Verification, review, recovery (Stage 4)

- [x] Check registration per task/project; evidence capture at exact revision and environment. (#45)
- [x] Task gate implementation (PLAN §2.4); worker claims and Jev scores cannot set `done`. (#46)
- [x] Completion-claim, evidence-gap, and test-exercises-requirement evaluators.
- [x] Independent review contexts; findings, severity, disposition, recheck. (#48 → `src/verification/review.ts`, `src/decisions/questions/review.ts`)
- [x] Human-approval gates for high-risk classes. (#49 → `src/workflow/approvals.ts`, `src/extension/ui/approval-prompt.ts`, `docs/approvals.md`)
- [x] Evidence invalidation after relevant changes. (#50 → `src/verification/invalidate.ts`)
- [x] Flaky/missing/unavailable checks represented explicitly. (#51 → `src/verification/flaky.ts`, `src/extension/ui/board.ts`)
- [x] Failure taxonomy incl. quota/rate-limit; stall and drift detection.
- [x] Bounded recovery policies; side-effect reconciliation before retry. (#53 → `src/workflow/recovery.ts`, `src/storage/recovery-log.ts`, `docs/recovery.md`)
- [x] Checkpoints and rollback proposals preserving user changes.
- [x] Tests: false completion claims, unrelated passing tests, persistent failure, exhausted budgets, cancellation during recovery. (#55)

## 5. Model catalog, Jev selection, fallback, single-worker execution (Stage 5)

- [x] Catalog from Pi registry filtered by allowlist; no credentials exposed. (#56 → `src/models/catalog.ts`)
- [x] Model cards, four layers (PLAN §D): registry metadata → bundled aptitude hints → user overrides → outcome refinement with uncertainty.
- [x] Bundled aptitude-hints file: id-pattern matching, versioned, "unrated" default for unknown models, update process documented.
- [ ] Task-profile evaluator independent of model names.
- [ ] Bundled aptitude-hints file: id-pattern matching, versioned, "unrated" default for unknown models, update process documented.
- [x] Task-profile evaluator independent of model names.
- [x] Jev selection question against cards; code enforces allowlist/budget/policy after selection.
- [x] User pins and explicit overrides. (#61 → `src/models/pins.ts`, `src/extension/commands/models-pin.ts`)
- [x] Cap detection (429, quota, budget) → ModelAvailability with estimated reset (#62).
- [x] Route identity: opaque `routeId` per (provider, model); availability, health and outcomes keyed per route, cards per model; rename rule in ADR 0011 (#125).
- [x] Fallback: Jev ranks substitutes for the task profile; "none adequate" → pause. (#63)
- [x] Mid-task handoff packet with intact worktree; restart alternative per task-kind policy.
- [x] Recovery to primary at next task boundary; no per-task re-probe.
- [x] Anti-oscillation dwell; all-capped → phase pause and auto-resume.
- [x] Expensive-substitute policy (prefer-wait threshold, budget check).
- [x] Static fallback order when Jev unavailable. (#63)
- [x] Attempt records requested/used model and reason; `status` and `models` surface switches and caps.
- [ ] Opt-in main-session routing at safe boundaries only.
- [x] Worker roles, contracts, launch with explicit model/profile/tools/cwd; resource inheritance control.
- [x] Read-only roles enforced across all mutation routes; sandbox boundaries where supported.
- [x] Dirty-tree preservation and repository identity check.
- [x] Progress, artifacts, usage capture; global/per-worker limits; pause/resume/cancel; process-tree termination. (#71)
- [x] Crash-interrupted attempt reconciliation.
- [x] Single-worker end-to-end run in a disposable repo; simulated-cap test with visible fallback (scenario 4).

## 6. Parallel orchestration, integration, unattended operation (Stage 6)

- [x] `run <phase-id | all>`; cost estimate before start. (#74)
- [x] Dependency-aware scheduling; ready-task selection; duplicate-dispatch prevention. (#75)
- [x] Worktrees for writing workers; ownership overlap checks; semantic-coupling signal; serial default when uncertain.
- [x] Coordinator lockfile; stale-owner recovery.
- [ ] Single-owner integration queue; base-revision validation; merge-conflict workflow.
- [ ] Integrated verification; phase gate (PLAN §2.5); phase report.
- [ ] Unattended approval policy: auto / queue-and-continue / stop; notifications.
- [x] Per-phase and per-workflow budget hard stops; resumable state on any stop.
- [ ] Recoverable worktrees/artifacts after failure; cleanup policy.
- [ ] Tests: simultaneous completion, conflicting edits, scheduler crash, partial cancellation, unattended run to phase completion (scenario 1).

## 7. Memory, compaction, handoffs, adaptive improvements (Stage 7)

- [ ] Memory classification; source-linked summaries; freshness/supersession.
- [ ] Deterministic pins for mandatory instructions and commitments.
- [ ] Compaction integration preserving evidence and tool-message validity.
- [ ] Handoff packets for workers, fallback, and resumed sessions.
- [ ] ModelOutcome collection; card refinement; routing improvement from held-out comparison.
- [ ] Question/routing version drift monitoring and rollback.
- [ ] Proposed instruction/skill diffs for review; opt-in auto-apply for approved low-risk class only; versioned, reversible. (Last.)
- [ ] Guard against autonomous weakening of permissions, allowlist, or spending policy.

## 8. UI and operating modes

- [ ] Namespace conflict check; all `/korwf` commands from PLAN §4.
- [ ] Shadow, advisory, supervised, bounded-autonomous modes; approval requirements documented independently of mode names.
- [ ] Safe `off` behaviour.
- [ ] Compact status: workers, models, fallbacks, blockers, evidence, budget, running cost.
- [ ] `why` decision inspection without secrets.
- [ ] Non-interactive operation never hangs on prompts.
- [ ] Ordinary Pi behaviour preserved when assistance is unavailable.

## 9. Evaluation (PLAN §9)

- [ ] Measure normal-Pi baseline on real work; then set numeric thresholds.
- [ ] Representative task set and held-out split; sanitised fixtures; replay tooling.
- [ ] Run no-Jev and Jev configurations; per-question-family ablations.
- [ ] Calibrate evaluators from shadow/advisory logs; abstention coverage and error rates.
- [ ] Adversarial suite: missing info, contradictions, injection, secrets, misleading descriptions.
- [ ] Fallback correctness and wrong-routing measurement.
- [ ] Capped live Jev and model-comparison runs within approved budgets.

## 10. Hardening and release (Stage 8)

- [ ] Scenarios 2.8 end to end.
- [ ] Pause/resume/reload/restart/fork/tree transitions; cancellation at every async boundary.
- [ ] Outages, malformed responses, disk failures, migrations, scheduler races.
- [ ] No credential leakage in output, logs, artifacts, exports.
- [ ] No gate bypass via bash/custom tools/worker launch paths.
- [ ] User changes survive failures and rollback.
- [ ] README, configuration reference, architecture guide, limitations, privacy/cost disclosure.
- [ ] Install/upgrade/disable/rollback/uninstall on a clean Pi; platform support statement.
- [ ] Publish evaluation results and limitations.
- [ ] Explicit installation and operating-mode approval; install and verify existing Pi workflows.

## Definition of complete

PLAN §10 release criteria are satisfied. A feature is complete only when its permissions, failure behaviour, observability, and acceptance criteria are met — not when a code path exists. Scope changes are explicit and approved, never silently deferred.
