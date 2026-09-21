# KorWF-Pi — implementation plan

## Status and authorization

This is the full-scope plan for a Jev-assisted autonomous development workflow package for Pi. It is intended for public distribution; nothing in the shipped product may depend on the author's machine, providers, or credentials.

- Authorized now: this project folder and planning documents.
- Not authorized by that request: implementation, installations, paid requests, uploading project data.
- The full scope below is one deliverable. Stages express dependency and validation order, not reduced releases.
- Autonomous operation is part of the build. Enabling it requires explicit operating policy and evidence, gathered from the product's own lower operating modes on real tasks, that it meets its acceptance criteria.

## 1. Objective

Let a developer plan an application (or a change to one) inside Pi, then say "implement phase N" or "implement everything", and have the system carry it out with minimal intervention: decomposing work, choosing models per task, executing in isolation, verifying with real checks, using Jev to detect gaps in evidence and to make bounded semantic decisions, recovering from failures, and reporting honestly.

Optimize for time to a verified result, developer intervention, correctness, and total cost — not number of Jev calls or number of agents.

### Responsibility boundaries

| Component | Responsibility |
| --- | --- |
| User | Goals, priorities, scope approval, budgets, data-sharing choices, consequential approvals |
| Coding models (any the user has enabled) | Investigation, reasoning, plans, code, tests, explanations, summaries |
| Jev | Narrow semantic classification, ranking, scoring, uncertainty; task characterisation; model selection and fallback ranking; evidence-gap detection |
| Workflow engine (code) | Permissions, allowlists, dependency scheduling, budgets, cap detection, state transitions, concurrency, persistence |
| Tests and development tools | Executable verification evidence |

Jev is not a generative coding model, a security boundary, or a final correctness oracle. It only sees the text sent to it. Its confidence statistic is not a task-specific guarantee of correctness.

## 2. Primary workflow

This is the product. Sections 3–4 (scope areas A–I) are the supporting capabilities for this pipeline.

### 2.1 Pipeline

```text
/korwf plan <goal>
   -> intake: spec, constraints, exclusions, existing-repo vs greenfield
   -> investigation (scout workers) and clarification questions
   -> structured plan: architecture, phases, tasks, dependencies,
      acceptance criteria, and per-task verification checks
   -> user reviews/edits/approves plan (or phases individually)

/korwf run <phase-id | all> [--mode ...]
   -> for each ready task (dependency-aware, parallel where safe):
        select model via Jev  ->  worker executes in worktree
        -> deterministic checks  ->  Jev evidence-gap review
        -> policy-required model review / human approval
        -> integrate (single owner)  ->  done
   -> phase gate  ->  next phase (if "all")  ->  final report
```

### 2.2 Records

- **Workflow** — goal, repository identity, base revision, mode, budgets, policy version, phases.
- **Phase** — ordered group of tasks with its own acceptance criteria, budget cap, integration point, and gate status. `run` targets a phase or all phases.
- **Task** — atomic unit of work with acceptance criteria, verification checks, ownership (files/components), dependencies, risk class.
- **Attempt**, **Decision**, **Evidence**, **Approval**, **Memory**, **ModelAvailability** — see section 5.

### 2.3 Planner outputs verification, not just tasks

For every task the planner must emit executable checks (test commands, assertions, lint/type checks, or an explicitly required human check). For greenfield projects the planner also produces the test scaffolding as early tasks. A task with no checks is not `ready`. This is what gives the deterministic gate something to gate on.

### 2.4 Success gate (per task)

A task reaches `done` only when all of the following hold:

1. **Deterministic checks pass** — registered commands exit 0 at the exact revision, recorded as evidence.
2. **Jev finds no evidence gap** — completion claim is supported by the presented evidence; every acceptance criterion maps to a check or evidence item; tests exercise the requirement rather than something unrelated.
3. **Policy-required review passes** — independent coding-model review for change classes the policy specifies; human approval for high-risk classes.

Jev cannot waive (1) or (3). A worker's assertion cannot set `done`. A Jev "no gap" result cannot substitute for a failing check.

### 2.5 Phase gate

Phase done = all tasks done ∧ integrated verification passes on the merged result ∧ Jev finds no gap between phase acceptance criteria and accumulated evidence ∧ policy-required phase review passes. Phase completion produces a report: what was built, evidence, open questions, cost.

### 2.6 Unattended operation

`run` may take hours with the user absent. Policy must define, per approval class:

- **Auto-decide** — low-risk classes the user pre-approved for the mode.
- **Queue and continue** — block the task, continue other ready tasks, notify.
- **Stop the phase** — high-risk classes.

Also: per-phase and per-workflow budget caps with hard stop; notification hooks; a cost estimate before `run` begins; a resumable state on any stop.

### 2.7 Greenfield bootstrap

When no repository exists: initialise version control, produce architecture and scaffolding as phase 0, generate test infrastructure before feature tasks, and treat the plan document itself as the retrieval context until code exists.

### 2.8 Scenarios (to validate the design)

1. **Greenfield app, phase 1.** Plan from a spec; scaffolding + tests; three feature tasks with two independent; parallel execution; integration; phase report.
2. **Feature on an existing repo.** Retrieval ranks the right files; one task; model chosen for the task type; check invalidated after a later edit; re-verification.
3. **Worker claims done, test is wrong.** Checks pass but Jev flags the test doesn't exercise the acceptance criterion; task goes to `needs_changes`; recovery path; second attempt succeeds.
4. **Cap hit mid-task.** Primary model returns quota exhausted; Jev ranks substitutes for the task profile; handoff packet built; worker continues on the substitute; switch recorded; next task retries the primary.

## 3. Product scope

### A. Intake and workflow selection

- Primary paths are command-driven (`plan`, `run`). Free-text intake classification (explanation, investigation, implementation, review, planning, clarification) is a secondary convenience.
- Preserve explicit user instructions; distinguish requests to discuss from requests to act.
- Deterministic rules before semantic classification. Keep a short path for trivial work.
- Record scope, exclusions, acceptance criteria, autonomy level, and budgets.
- Never infer authorization for irreversible actions from a Jev score.

### B. Context and capability selection

- Retrieve candidates with ordinary search and symbol/dependency tools; Jev ranks bounded candidates and flags stale, contradictory, or irrelevant material.
- Provenance on every excerpt: revision, path, range, retrieval method, content hash.
- Explicit files, required instructions, and required skills are preserved regardless of ranking.
- Support shortlist expansion; retain original tool output alongside filtered excerpts.
- Suggest optional skills/tools; permit none or several; never override mandatory skill-loading rules.

### C. Planning and task management

- Coding models create structured plans, phases, task decompositions, and per-task checks (2.3).
- Jev evaluates atomic properties: observable outcome, requirement coverage, ambiguity, verification readiness, coupling.
- Schema and dependency-graph validation (including cycles) in code.
- Durable storage of plans, phases, decisions, dependencies, ownership, blockers, evidence.
- Plan revision, scope change, cancellation, reprioritisation, approval invalidation; replan without silent scope expansion.
- Readable task board and exportable plan/TODO view.

### D. Model selection and fallback

**Principle:** model selection is task-specific and Jev decides — initially and on every fallback — within the user's configured allowlist and budgets. Selection is automatic and visible, never silent.

- **Allowlist.** Eligible models are whatever the user's Pi has configured, filtered by an optional provider/model allowlist in config. Default: all configured models. The system never uses a provider or model outside the allowlist.
- **Model cards.** The catalog carries a card per model, merged from four layers so no single source must be complete. Jev ranks against cards, not bare IDs.
  1. **Pi registry metadata (automatic).** `ctx.modelRegistry` / `ctx.scopedModels` provide id, provider, name, `reasoning` and `thinkingLevelMap`, `input` modalities, `contextWindow`, `maxTokens`, and `cost` (may be zero for local/proxied models). Sufficient for hard-constraint filtering with no user effort.
  2. **Bundled aptitude hints (shipped, versioned).** A small package file mapping model families (by id pattern, so proxied/local names match) to short aptitude descriptions — e.g. front-end/UI, deep reasoning, large refactors, tool use, speed. Unknown models get an explicit "unrated" card so Jev knows the gap. Kept small and updated with the package.
  3. **User overrides (config).** Optional per-model notes, aptitude corrections, and pins.
  4. **Measured outcomes (per user, grows over time).** `ModelOutcome` records refine the card with uncertainty for sparse data.

  Registry metadata excludes candidates; hints, overrides, and outcomes rank them. A thin card lets Jev answer "not enough information", which routes to the static fallback order.
- **Task profile.** Jev characterises each task (domain, modality needs, reasoning depth, context size, risk) independently of model names.
- **Selection.** Jev chooses from the eligible candidates for the task profile. Code enforces allowlist, budget, and policy after selection.
- **Bootstrap.** Measured-outcome data starts empty for every user. Initial cards come from metadata and config; outcome records refine them per user over time, with uncertainty for sparse data.
- **Caps and fallback.** Code detects quota exhaustion, rate limits, and budget caps, and records them in ModelAvailability with an estimated reset. On a cap, Jev ranks the remaining candidates for the task profile and the workflow switches. Policies:
  - Mid-task: hand off with an explicit handoff packet and intact worktree (default), or restart the task, per task-kind policy.
  - Recovery: retry the primary at the next task boundary once the cap is estimated to have cleared; do not re-probe every task.
  - Anti-oscillation: minimum dwell on the fallback (default: remainder of the current task).
  - All candidates capped: pause the phase, surface state, resume when a cap clears. Not a failure.
  - More expensive substitute: apply the workflow budget; configurable prefer-wait-if-reset-within-N-minutes.
  - No adequate substitute: Jev may answer "none adequate" for hard tasks → pause rather than degrade silently.
  - Pinned model: user pins are not overridden by fallback without asking.
  - Jev unavailable: use the static fallback ordering from config.
- **Main session.** Stable by default; opt-in routing of the main session only at safe boundaries, with visible switch and explicit context handoff.
- Every switch is recorded on the Attempt (`requested_model`, `used_model`, `fallback_reason`) and surfaced in status.

### E. Execution and multi-agent orchestration

- Bounded roles: scout, planner, implementer, verifier, reviewer, integrator.
- Single-worker, sequential, parallel, and dependency-aware workflows.
- Explicit worker contracts: task, tools, artifacts, budget, model, termination criteria.
- Separate Git worktrees for parallel writing workers; one integration owner; never concurrent uncontrolled integration into the user's tree.
- Declared ownership conflicts detected in code; Jev adds a semantic-coupling signal; default to serial when coupling is uncertain.
- Enforce concurrency, recursion depth, elapsed-time, token, and spend limits. Propagate cancellation and terminate child process trees.
- Workers do not inherit orchestration extensions that could spawn recursively unless explicitly allowed.
- Pause, resume, cancel, restart recovery, partial completion.
- Worktrees are change isolation, not security isolation. Restricted execution uses a separately defined sandbox.

### F. Verification, review, and completion

- Implements the success gate (2.4) and phase gate (2.5).
- Evidence records exit code, artifacts, command identity, environment, exact revision.
- Jev flags unsupported completion claims, evidence gaps, and tests that don't exercise the requirement.
- Independent review contexts to reduce anchoring on worker claims.
- Required checks are deterministic; Jev cannot waive them.
- Evidence invalidated after relevant changes; integrated checks after merges.
- Flaky, missing, or unavailable checks are represented explicitly, never as success.

### G. Failure recovery and stall detection

- Failure taxonomy: implementation, environment, missing information, dependency, test expectation, service, quota/rate-limit, unknown.
- Detect repeated approaches, repeated failures, scope drift, no measurable progress.
- Bounded responses: gather evidence, retry, fallback model (D), replan, change worker/profile, request review, ask user, stop.
- No blind retry of side effects; reconcile uncertain outcomes first.
- Checkpoints and approval policy for rollback; preserve uncommitted user work.
- Concise failure evidence and next-step options.

### H. Memory, compaction, and handoffs

- Classify durable decisions, temporary observations, open questions, superseded assumptions, reusable lessons.
- Coding models write summaries; Jev assists selection and consistency.
- Provenance, freshness, supersession, and source revision on entries.
- Deterministic pins for required instructions and unresolved commitments.
- Integrate with Pi compaction without deleting original evidence.
- Explicit handoff packets for workers, model fallback (D), and resumed sessions.
- Proposed project-instruction/skill updates presented as diffs for review; opt-in automatic application only for an explicitly approved low-risk class; versioned and reversible. Lowest priority in the build order.
- The system never weakens its own permission, allowlist, or spending policy.

### I. Observability and workflow improvement

- Task/phase status, workers, selected and fallback models, blockers, budgets, running cost, verification coverage.
- Decisions explained from recorded inputs, returned values, and policy rules — never fabricated rationales.
- Versions recorded: Jev model, question set, policy, schema, package.
- Latency, errors, overrides, retries, actual/estimated/unknown cost tracked explicitly.
- Question and routing changes evaluated against held-out tasks before promotion; drift detection; simple rollback.
- Reproducible replay with recorded, sanitised responses.

### J. Packaging and configuration (public distribution)

- Distributed as a Pi package per `docs/packages.md`; install/upgrade/disable/uninstall through Pi's mechanism.
- Config schema with validation and safe defaults: allowlist, budgets, modes, approval classes, privacy lists, fallback policy, static fallback order, Jev base URL/key source.
- Runs without a Jev key: deterministic workflow (plan, tasks, worktrees, gates, static routing) fully functional; Jev features off with a clear message.
- No user-specific paths, providers, or credentials in shipped code.
- Namespaced commands, tools, and storage; documented platform support (Linux, macOS; Windows status stated explicitly).
- README, configuration reference, architecture guide, limitations, and cost/privacy disclosure at first use.

## 4. Architecture

Modular TypeScript Pi package, no fork.

```text
Pi extension commands, hooks, tools, UI
                    |
             Workflow coordinator
        /        |         |         \
  policy engine  phase/task store  worker supervisor  model router (Jev-ranked)
       |              |                 |                  |
   Jev adapter     SQLite          Pi worker processes   allowlisted models
       |
  TypeSafe API (user key, configurable base URL)
```

```text
src/
  extension/     Pi lifecycle adapters, commands, tools, UI
  workflow/      phases, state machine, scheduler, approvals, unattended policy, recovery
  decisions/     versioned Jev questions and composition policies
  jev/           transport adapter, validation, deadlines, usage, optional-mode
  models/        catalog, model cards, task profiles, Jev selection, caps/fallback
  workers/       subprocess lifecycle, contracts, role resources, handoff
  context/       retrieval, passage selection, capability suggestions
  verification/  checks, evidence, reviews, task and phase gates
  memory/        provenance, summaries, compaction, handoff packets
  storage/       SQLite, migrations, lockfile, artifacts
  security/      data boundaries, privacy defaults, execution policy, secrets
  telemetry/     decision traces, accounting, metrics
  evaluation/    replay, baselines, calibration, regression suites
  config/        schema, defaults, validation
```

### Reuse of Pi's shipped examples

Stage 1 produces a reuse/extend/replace table for each of: `subagent/`, `plan-mode/`, `sandbox/`, `todo.ts`, `git-checkpoint.ts`, `handoff.ts`, `dirty-repo-guard.ts`, `permission-gate.ts`, `protected-paths.ts`, `custom-compaction.ts`, `git-merge-and-resolve.ts`, `questionnaire.ts`, `structured-output.ts`. The source layout above is revised after that table exists.

### Pi integration surfaces to validate

Commands and custom tools; input/pre-agent hooks; tool-call hooks as policy gates (not sandboxing); tool-result and turn events for evidence and stall detection; settled lifecycle events; session/tree/fork/resume/reload/compaction events; model-selection APIs at safe boundaries; session entries for session-linked summaries; project storage for cross-worker state.

### User interface (names provisional, namespaced)

- `/korwf plan <goal>` — investigate and produce a phased plan.
- `/korwf run <phase-id | all>` — execute within approved scope and mode.
- `/korwf tasks`, `/korwf phases` — boards with dependencies, blockers, evidence.
- `/korwf status` — workers, models in use, fallbacks, budgets, running cost.
- `/korwf pause`, `/korwf resume`, `/korwf cancel`.
- `/korwf review` — artifacts and verification coverage.
- `/korwf why <decision>` — decision inputs and policy application.
- `/korwf models` — catalog, cards, availability/caps, pins.
- `/korwf mode` — shadow, advisory, supervised, bounded autonomous.
- `/korwf off` — disable optional assistance; never removes required safety controls or abandons running workers.
- `/korwf eval` — explicit, budget-approved evaluation runs.

## 5. Data and persistence

**Store: SQLite** (decided), single writer process, lockfile for coordinator ownership, explicit migrations, append-only audit table, artifact directory. Abandoned attempts reconciled on startup.

### Records

- **Workflow** — goal, repo identity, base revision, exclusions, mode, budgets, policy version, session refs.
- **Phase** — id, order, goal, acceptance criteria, budget cap, integration point, gate status, report.
- **Task** — stable id, revision, phase, goal, dependencies, ownership, acceptance criteria, checks, risk class, status.
- **Attempt** — worker id, task profile, requested model, used model, fallback reason, profile, inputs, worktree, timestamps, usage, outcome, artifacts.
- **Decision** — state hash, question version, Jev model version, raw distribution and confidence, policy rule, action, override, freshness.
- **Evidence** — requirement/check id, artifact, revision, command identity, exit status, reviewer, caveats.
- **Approval** — actor, scope, task/plan revision, permitted action, expiry, invalidation.
- **Memory** — source, revision, type, freshness, supersession, status.
- **ModelAvailability** — model id, cap kind, detected at, estimated reset, last probe.
- **ModelOutcome** — model, task profile, result, cost, latency (feeds card refinement).

Pi conversation branching does not undo Git changes or external effects. Fork/resume reconciles live repository state and never resurrects obsolete approvals or replays completed actions.

### Task states

```text
proposed -> ready -> running -> verifying -> review -> done
               \       \           \          \
                blocked / failed / cancelled / needs_changes / paused(cap)
```

Explicit transition table with preconditions and evidence requirements.

## 6. Jev decision design

- Narrow, versioned Choice, Score, and Noul questions with explicit boundary cases and none/unknown outcomes.
- Question families: intake classification; passage relevance/staleness/contradiction; task atomicity/coverage/readiness; task profile; model selection and fallback ranking (against cards); semantic coupling; completion-claim support; evidence gap; test-exercises-requirement; review-finding severity; memory classification.
- Minimal relevant state per evaluation; batch independent questions; stage dependent ones.
- Graph algorithms, arithmetic, counters, schema checks in code.
- Preserve raw distributions; validate schemas and bounds; pin tested Jev versions.
- Cache only with complete versioned keys; never reuse stale approvals or revision-sensitive evidence.
- Thresholds calibrated per evaluator and risk class. Calibration data comes from the product's own shadow and advisory modes on real tasks; until enough data exists, use conservative defaults and abstention.
- Jev is optional at runtime (J): every Jev-assisted decision has a deterministic fallback behaviour.

## 7. Provider, privacy, and security

### Jev transport

Direct TypeSafe API using the user's own key, with a configurable base URL for users who proxy. Key resolved through an approved secret mechanism (env var or Pi's secrets facility), never stored in the repo, transcripts, or logs.

### Data policy (shipped defaults, user-configurable)

- Default-deny outbound for secrets and sensitive paths (`.env*`, key files, credential stores, `node_modules`, build output, and a documented list).
- Minimal outbound snippets; sanitised logs; raw payload logging opt-in with retention and deletion controls.
- First-use disclosure: which data classes go to TypeSafe and to model providers.
- Untrusted repository/tool content isolated from instruction and policy sources. Jev prompt-injection signals never authorise execution or data release.

### Execution policy

- Permissions come from user-approved rules and execution isolation, not semantic confidence.
- Role-specific tools, constrained environments, path boundaries, network policy where the platform supports it.
- All mutation routes tested (bash, custom tools); disabling `edit`/`write` alone is not read-only enforcement.
- High-risk actions (destructive cleanup, deployment, credential access, publishing, remote pushes) require explicit policy/approval regardless of mode.

## 8. Build sequence

### Stage 1: Discovery and contracts
Review installed Pi docs/examples; produce the reuse table; verify current TypeSafe API/SDK/models/pricing/retention; design config schema; define all records, transitions, approval-invalidation rules, and the task/phase gate formulas; record architecture decisions and threat boundaries.
**Exit:** interfaces and boundaries reviewable; config schema drafted; reuse decisions made.

### Stage 2: Package and adapter foundation
Package manifest, modular layout, test harness, config validation, SQLite store and migrations, Jev adapter with mock transport and optional-mode, versioned questions, tracing, accounting, cancellation.
**Exit:** loads in an isolated Pi session; offline tests pass; works with no Jev key; failures cannot hang Pi or leak credentials.

### Stage 3: Context, planning, phases, and durable tasks
Retrieval and ranking; capability suggestion; structured planning with phases and per-task checks; greenfield bootstrap; readiness/coverage evaluators; dependency validation; task and phase boards; persistence; session reconciliation.
**Exit:** a phased plan with checks can be created, revised, resumed, and inspected.

### Stage 4: Verification, review, and recovery
Evidence capture; task and phase gates; independent review; evidence-gap and test-exercises-requirement evaluators; failure taxonomy; stall detection; bounded recovery; checkpoints.
**Exit:** unsupported completion is rejected; failures produce bounded recovery or a clear stop.

### Stage 5: Model catalog, Jev selection, fallback, and single-worker execution
Catalog and model cards; task profiles; Jev selection; allowlist/budget enforcement; cap detection and ModelAvailability; fallback policies including mid-task handoff; worker processes and contracts; single-worker end-to-end run; pause/cancel.
**Exit:** a task executes in isolation with Jev-chosen model, survives a simulated cap with a visible fallback, and reports accurate state.

### Stage 6: Parallel orchestration, integration, and unattended operation
Dependency-aware scheduling; worktrees; ownership/coupling checks; coordinator lock; integration queue; merge-conflict workflow; integrated verification; unattended approval policy; notifications; cost estimate before run; `run <phase|all>`.
**Exit:** independent tasks run concurrently, integrate safely, and a full phase completes unattended within budget.

### Stage 7: Memory, compaction, handoffs, and adaptive improvements
Source-grounded memory; compaction integration; handoff packets; outcome-backed card refinement; proposed instruction/skill diffs (auto-apply last); drift monitoring.
**Exit:** resumed and handed-off work preserves commitments; routing improves from outcomes; policy changes are reversible.

### Stage 8: Full-system evaluation, hardening, and release
Scenarios 2.8 end to end; baseline comparisons; privacy/adversarial/outage/crash/migration tests; docs; packaging; install/upgrade/uninstall tests on a clean Pi.
**Exit:** release criteria satisfied.

## 9. Evaluation strategy

Compare (1) normal Pi, (2) KorWF-Pi with Jev disabled (the shipped no-key configuration), (3) KorWF-Pi with Jev.

Baseline distribution for (1) is measured first on the author's real work, then numeric thresholds are set, then (2) and (3) are run. Ablations per Jev question family. Held-out split for question/routing changes. Separate adversarial/failure suite. Mocked tests never authorise live requests; live runs need explicit budgets.

Measure: time to verified completion, intervention time, task success, regressions, missed requirements, retrieval omissions, false warnings/escalations, wrong routing, fallback correctness, total cost, latency.

## 10. Release acceptance criteria

- Scope A–J implemented and documented.
- `plan` → `run <phase>` → gates → phase gate → `run all` works for single and parallel workflows, attended and unattended.
- Model selection and fallback are Jev-driven, task-specific, allowlist-bounded, budget-bounded, visible, and recorded; pinned models respected.
- Product is fully usable without a Jev key.
- No action exceeds approved scope, capability, or budget because a model recommended it.
- Records survive restart with correct revision semantics; fork/resume never replays effects or reuses stale approvals.
- Cancellation stops dispatch and child execution; worktrees remain recoverable; dirty user changes preserved.
- Required checks cannot be bypassed by Jev, worker claims, or any tool path.
- Privacy defaults enforced; no credential leakage in output, logs, artifacts, or exports.
- Installs, upgrades, disables, and uninstalls cleanly on a clean Pi on supported platforms.
- Evaluation results and limitations published.

## 11. Development environment (author-specific; not product policy)

These apply to the author's machine while building and evaluating, and are expressed through the product's own config — never hardcoded.

- Allowlist config: `providers: ["mac-mini"]`. Direct providers remain available only as explicit exceptions.
- Model guidance: `~/.pi/agent/skills/mac-mini-models/SKILL.md`.
- Jev: direct TypeSafe with the author's key via the approved secret mechanism; base URL default.
- Pilot repository, sample tasks, spend/token/request/concurrency caps, and approval classes to be agreed before live tests.

### Decisions needed before implementation/live operation

- Authorization to implement.
- TypeSafe key availability and secret mechanism.
- Pilot repository and data-sharing restrictions.
- Live test budgets.
- Default operating mode and approval classes for the pilot.
- Whether sandbox setup and additional dependencies are permitted.

## 12. References

Planning is based on installed Pi 0.86.0 docs and TypeSafe docs. Verify current APIs, model versions, pricing, and retention before implementation.

Pi: `/home/lee/.local/share/mise/installs/pi/0.86.0/pi/` — `docs/extensions.md`, `docs/sdk.md`, `docs/rpc.md`, `docs/tui.md`, `docs/session-format.md`, `docs/compaction.md`, `docs/packages.md`, `examples/extensions/`.

TypeSafe: https://docs.typesafe.ai/introduction, /models, /api, /confidence, /model-jaggedness/jev-1.13, /concepts/how-to-build-with-system-one, /cookbooks/skill_suggestion, /sdk/javascript.

Checklist: [TODO.md](TODO.md).
