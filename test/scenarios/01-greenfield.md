# Scenario 1 — Greenfield app, phase 1

**Source:** PLAN §2.8 (1). **Records:** [docs/records.md](../../docs/records.md).
**Transitions:** [docs/state-machine.md](../../docs/state-machine.md).
**Gates:** [docs/gates.md](../../docs/gates.md). Issue #18; executed end to end in Stage 8 (#102).

> Plan from a spec; scaffolding + tests; three feature tasks with two independent;
> parallel execution; integration; phase report.

## Conventions

- Assertions are written `Record.field <op> value`; nested JSON fields use dot paths
  (`Attempt.timestamps.endedAt`). `Record[x]` names a specific row by the alias given in
  the step that creates it. `count(Record where …)` counts rows.
- `SHA(T)` / `SHA(P)` are the current task-worktree / merged-result SHAs as defined in
  gates.md §1; the test reads them through `src/git/`, never from a worker.
- All model and Jev calls are **mocked**. Mocked runs never authorise live requests
  (AGENTS.md §4). The Jev mock returns pre-written distributions; the engine still writes
  real `Decision` rows through `src/jev/`.
- Time (`now`) is injected. Cost figures are asserted on `Usage.costBasis`, not on
  absolute numbers, because the fixture models are proxied/local and may report zero.
- No absolute paths anywhere: `Attempt.worktree.relativePath`, `Provenance.path`,
  `ArtifactRef.relativePath` are always relative (records.md §1).

## Fixture

- **Repository:** none. The test creates an empty temporary directory; KorWF is expected
  to `git init` it (PLAN §2.7). After bootstrap the test records the root commit as
  `ROOT` and asserts `Workflow.repoIdentity.rootCommit == ROOT`,
  `Workflow.repoIdentity.remoteUrl == null`.
- **Spec:** `spec.md` in the temp directory describing a small CLI note-taking app:
  a `notes add <text>`, `notes list`, and `notes delete <id>` command over a JSON file.
  The spec is the only retrieval context until code exists (PLAN §2.7).
- **Expected plan shape** (the test asserts this shape, not exact wording):
  - `Phase[P0]` order 0 — scaffolding: package manifest, test runner, lint/typecheck,
    empty `src/` and `test/`. Tasks `T0a` (scaffold) → `T0b` (test infrastructure).
  - `Phase[P1]` order 1 — feature phase: `T1` (`notes add`), `T2` (`notes list`),
    `T3` (`notes delete`). `T2` and `T3` depend on `T1`; `T2` and `T3` are independent of
    each other and own disjoint paths.
- **Workers:** mocked worker adapter that applies pre-recorded patches per task and then
  issues a completion request. Two patches (for `T2`, `T3`) touch disjoint files.

## Config

```jsonc
{
  "mode": "bounded_autonomous",                // PLAN §2.6 unattended run
  "models": { "allowlist": ["<fixture-provider>/*"] },   // fixture provider, never a real name in code
  "budgets": { "workflow": { "maxSpendUsd": 5, "maxConcurrency": 2 } },
  "jev": { "enabled": true, "optional": false } // variant A; variant B flips enabled=false
}
```

Concurrency `2` is what makes "parallel execution" observable: `T2` and `T3` must run
concurrently while `T1` is a hard dependency.

## Stages and issues exercised

| Step | Stage | Issues |
| --- | --- | --- |
| Plan intake, greenfield bootstrap, plan structure | 3 | #33, #37, #38, #39, #40, #41 |
| Scaffolding tasks, checks registered before ready | 3, 4 | #39, #45 |
| Dispatch, worktrees, scheduler, concurrency | 5, 6 | #68, #74, #75, #76 |
| Task gate, evidence capture, Jev gap / fallback | 4 | #45, #46, #47 |
| Integration, integrated checks, phase gate, report | 6 | #78, #79 |
| Budget/cost accounting on the report | 2, 6 | #30, #81 |
| Whole scenario end to end | 8 | #102 (also #83 for the unattended phase) |

## Variant A — Jev enabled

### Step A1 — `/korwf plan` from the spec

- **Given** the empty directory and `spec.md`; Jev mock answers planning questions with
  confident distributions.
- **When** the user runs `/korwf plan "Build the notes CLI described in spec.md"`.
- **Then**
  - `Workflow.status == 'ready'` after the user approves the plan;
    `Workflow.goal` contains `notes`; `Workflow.mode == 'bounded_autonomous'`;
    `Workflow.planRevision == 1`; `Workflow.baseRevision` is the bootstrap commit SHA;
    `Workflow.exclusions == []`.
  - `count(Phase where workflowId == W.id) == 2`; `Phase[P0].order == 0`,
    `Phase[P1].order == 1`; both `Phase.gateStatus == 'pending'`,
    `Phase.report == null`.
  - `count(Task where phaseId == P0.id) == 2`; `count(Task where phaseId == P1.id) == 3`.
  - For every task: `Task.status == 'proposed'`, `Task.revision == 1`,
    `Task.checks.length >= 1`, and every `Task.acceptanceCriteria[i].id` appears in some
    `Task.checks[j].coversCriteria` (gates.md C1 criterion coverage).
  - `Task[T0b].dependencies == [T0a.id]`; `Task[T2].dependencies == [T1.id]`;
    `Task[T3].dependencies == [T1.id]`; `Task[T2].ownership.paths ∩ Task[T3].ownership.paths == ∅`.
  - No task has a trivial check: no `Task.checks[j].command` in the gates.md §2 deny-list.
  - Every planning `Decision.override == null`, `Decision.jevModelVersion != null`,
    `Decision.confidence != null`; `Decision.subject` is a task or phase subject.
  - `Approval` rows: one with `Approval.scope.kind == 'plan'`,
    `Approval.actor.kind == 'user'`, `Approval.planRevision == 1`,
    `Approval.invalidation == null`.
  - The plan document is the retrieval context: every `Memory` written during planning
    has `Memory.source.kind == 'excerpt'` with `Memory.source.provenance.path == 'spec.md'`
    and `Memory.source.provenance.retrievalMethod == 'plan_document'`.

### Step A2 — run phase 0 (scaffolding + test infrastructure)

- **When** the user runs `/korwf run P0`.
- **Then** (cost estimate first, then execution)
  - A cost estimate is surfaced before any dispatch: the first `AuditEntry` after the run
    command has `AuditEntry.table == 'phase'`, `AuditEntry.operation == 'update'` and
    `Phase[P0].gateStatus` moves `pending → running` (`phase-start`).
  - `Task[T0a]` follows `proposed → ready → running → verifying → review → done`; each
    transition is present as an `AuditEntry` with `AuditEntry.table == 'task'`,
    `AuditEntry.recordId == T0a.id`, `AuditEntry.actor` starting `engine:`.
  - `Task[T0b].status == 'ready'` only after `Task[T0a].status == 'done'`
    (readiness guard `all dependencies done`).
  - For each of `T0a`, `T0b`: exactly one `Attempt` with `Attempt.role == 'implementer'`,
    `Attempt.taskRevision == 1`, `Attempt.outcome == 'succeeded'`,
    `Attempt.fallbackReason == null`, `Attempt.usedModel == Attempt.requestedModel`,
    `Attempt.worktree.relativePath` non-empty and relative,
    `Attempt.timestamps.endedAt != null`.
  - For each check `c` of each task: `Evidence.checkId == c.id`,
    `Evidence.exitStatus == {kind:'exited', code:0}`, `Evidence.revision == SHA(T)`,
    `Evidence.taskRevision == 1`, `Evidence.commandIdentity.command == c.command`,
    `Evidence.commandIdentity.cwd == c.cwd`, `Evidence.reviewer.kind == 'deterministic'`,
    `Evidence.supersedesId == null`.
  - Per task one fresh `Decision` with `Decision.questionId == 'task_evidence_gap'`,
    `Decision.action == 'no_gap'`, `Decision.override == null`,
    `Decision.subject == {taskId, taskRevision: 1}`, `Decision.freshness.revision == SHA(T)`.
  - `Phase[P0].gateStatus` passes through `integrating → verifying → review → passed`;
    `Phase[P0].report != null`; `Phase[P0].report.evidenceIds` non-empty.
  - After P0 the repository has a runnable test command: `Task[T0b].checks` includes a
    check with `CheckDefinition.kind == 'command'` whose command is the test runner, and
    that same command is present in `Phase[P1].integrationPoint`-level integrated checks.

### Step A3 — run phase 1: `T1` first, then `T2` ∥ `T3`

- **When** the user runs `/korwf run P1` and walks away (unattended).
- **Then**
  - `Phase[P1].gateStatus == 'running'`; `Phase[P1].integrationPoint.baseRevision`
    equals the merged SHA that closed P0 (`SHA(P0)`).
  - Ordering: `Task[T1]` reaches `done` before `Task[T2].status` or `Task[T3].status`
    becomes `ready`. Assert via `AuditEntry` order: the `task-ready` entries for `T2` and
    `T3` have `AuditEntry.createdAt > ` the `task-done` entry for `T1`.
  - Parallelism: `Attempt[A2].timestamps.startedAt < Attempt[A3].timestamps.endedAt` and
    `Attempt[A3].timestamps.startedAt < Attempt[A2].timestamps.endedAt` (the two attempts
    overlap in time). Never more than `Workflow.budgets.maxConcurrency` attempts with
    `Attempt.outcome == null` at once.
  - Isolation: `Attempt[A2].worktree.relativePath != Attempt[A3].worktree.relativePath`,
    `Attempt[A2].worktree.branch != Attempt[A3].worktree.branch`, both
    `Attempt.worktree.baseRevision == SHA(T1 completion)`.
  - Every attempt: `Attempt.inputs.taskRevision == 1`,
    `Attempt.inputs.contextProvenance[*].path` is relative and each has a non-empty
    `contentHash`; `Attempt.inputs.bundleHash` non-empty.
  - Every attempt: `Attempt.usage.requests >= 1`, `Attempt.usage.costBasis` in
    `{known, estimated, unknown}` (never absent).
  - Per task, one `ModelOutcome` with `ModelOutcome.attemptId == A.id`,
    `ModelOutcome.result == 'succeeded'`, `ModelOutcome.wasFallback == false`.
  - Task gate for each of `T1`, `T2`, `T3` (gates.md §3): fresh passing `Evidence` per
    check (as in A2), a fresh `Decision.action == 'no_gap'` with `Decision.override == null`,
    and a recorded policy result. Given `Task.riskClass == 'low'` for all three, no
    `Approval` with `Approval.scope.kind == 'task'` is required and none is created; the
    policy evaluation is still recorded (gates.md C3 `policyResultRecorded`).
  - No task went through `needs_changes`, `failed`, `blocked` or `paused_cap`:
    `count(AuditEntry where table == 'task' and afterHash corresponds to those statuses) == 0`
    (implemented as: no `Task.blocker != null` at any audited point).

### Step A4 — integration (single owner) and integrated verification

- **When** all three tasks are `done`.
- **Then**
  - `Phase[P1].gateStatus == 'integrating'` (`phase-gate` from `running`).
  - Exactly one `Attempt` with `Attempt.role == 'integrator'` for P1;
    `Attempt.taskId` refers to a task in P1 (or the phase's integration task as decided in
    Stage 6) and no second integrator attempt overlaps it in time.
  - `SHA(P1)` (head of `Phase[P1].integrationPoint.branch`) is a descendant of each task's
    completion revision (gates.md P0).
  - Integrated checks run at `SHA(P1)`: for every check in `⋃ Task.checks ∪ P.integratedChecks`
    there is `Evidence.revision == SHA(P1)`, `Evidence.exitStatus == {kind:'exited', code:0}`,
    `Evidence.reviewer.kind == 'deterministic'`. Task-worktree evidence
    (`Evidence.revision == SHA(T)`) is **not** reused (gates.md P2).
  - `Phase[P1].gateStatus` moves `integrating → verifying → review`.
  - One fresh `Decision` with `Decision.questionId == 'phase_evidence_gap'`,
    `Decision.subject == {phaseId: P1.id}`, `Decision.action == 'no_gap'`,
    `Decision.override == null`, `Decision.freshness.revision == SHA(P1)`.

### Step A5 — phase gate and report

- **When** the phase gate is evaluated.
- **Then**
  - `Phase[P1].gateStatus == 'passed'` (`phase-done`); exactly one `AuditEntry` with
    `AuditEntry.actor == 'engine:gate:phase'`, `AuditEntry.recordId == P1.id`.
  - `Phase[P1].report != null`; `Phase[P1].report.summary` non-empty;
    `Phase[P1].report.evidenceIds` ⊇ the ids of every integrated-check `Evidence` at `SHA(P1)`;
    `Phase[P1].report.openQuestions` is an array (may be empty);
    `Phase[P1].report.cost.requests == Σ Attempt.usage.requests` over P1 attempts plus
    P1 `Decision.usage.requests`; `Phase[P1].report.cost.costBasis != 'known'` only if some
    contributing `Usage.costBasis != 'known'`; `Phase[P1].report.producedAt != null`.
  - `Workflow.status == 'completed'` (both phases passed, `run` was scoped to P1 which was
    the last phase).
  - Budget: `Phase[P1].report.cost.spendUsd <= Workflow.budgets.maxSpendUsd` when
    `spendUsd != null`.
  - Nothing external happened without approval: `count(Approval where permittedAction
    not in {approve_plan, run_phase}) == 0` (no publish/deploy/etc. approvals exist).

## Variant B — Jev disabled (`jev.enabled = false`, no key)

Same fixture and steps; only the differences are asserted. Deterministic fallbacks
replace every Jev-assisted decision; **C1, C3, P1, P2 and P4 are unchanged** (gates.md
§5.2, §6.1).

### Step B1 — plan

- Same plan shape as A1 is reachable: the planner (a coding model, not Jev) still produces
  two phases and five tasks with checks. Planning evaluators (atomicity, coverage,
  readiness — #39) run in deterministic mode:
  - Every planning `Decision.override == {actor:'policy', reason:'jev_disabled'}`
    (or `'jev_no_key'` when the key is simply absent), `Decision.jevModelVersion == null`,
    `Decision.confidence == null`, `Decision.action == 'deterministic_fallback'`.
  - `Decision.usage.requests == 0` for every such row (no transport was used).
  - `count(Decision where override == null) == 0` for the whole workflow.
- Readiness is unchanged: any task with `Task.checks.length == 0` stays `proposed`
  (state-machine.md §2 READY). The fixture plan has none; the test additionally mutates
  one task to `checks: []` and asserts `Task.status` never reaches `ready`.

### Step B2 — model selection without Jev

- `Attempt.requestedModel` for every attempt equals the first eligible entry of the
  configured static fallback order (PLAN §3.D "Jev unavailable: use the static fallback
  ordering"); `Attempt.fallbackReason == null` because no substitution happened
  (`Attempt.usedModel == Attempt.requestedModel`). The selection `Decision` row (question
  id owned by #60) has `Decision.override.reason == 'jev_disabled'`.

### Step B3 — task gates via `DET_COVERAGE`

- For each of `T0a`, `T0b`, `T1`, `T2`, `T3` (gates.md §5.2):
  - One `Decision` with `Decision.questionId == 'task_evidence_gap'`,
    `Decision.action == 'deterministic_fallback'`,
    `Decision.override == {actor:'policy', reason:'jev_disabled'}`,
    `Decision.freshness.revision == SHA(T)`, `Decision.subject.taskRevision == Task.revision`.
  - For every `a ∈ Task.acceptanceCriteria`: some `Task.checks[j]` with
    `a.id ∈ coversCriteria` has `Evidence.exitStatus == {exited, 0}` at `SHA(T)`, **and**
    some fresh `Evidence.requirementId == a.id` with `exitStatus == {exited, 0}`.
  - For every command/assertion check: `Evidence.provenance[*].path ∩ Task.ownership.paths ≠ ∅`.
  - `Task.status == 'done'` is reached; the gate receipt's reason is `pass`.
- Negative control (mirrors gates.md B11): the test removes the `requirementId` evidence
  row for `T2.ac[0]` in an in-memory copy and asserts the gate rejects with
  `fallback_coverage_gap`, `Task[T2].status` unchanged, one `AuditEntry` with
  `AuditEntry.actor == 'engine:gate:task'` and `afterHash == beforeHash`.

### Step B4 — phase gate via `PHASE_DET_COVERAGE`

- One `Decision.questionId == 'phase_evidence_gap'` with
  `Decision.action == 'deterministic_fallback'`, `Decision.override.reason == 'jev_disabled'`,
  `Decision.subject == {phaseId: P1.id}`, `Decision.freshness.revision == SHA(P1)`.
- Every `Phase[P1].acceptanceCriteria[i].id` is either mapped down to a done task's
  criterion or covered by a passing integrated check at `SHA(P1)` (gates.md §6.1).
- `Phase[P1].gateStatus == 'passed'`; `Phase[P1].report` as in A5.
- Cost: `Phase[P1].report.cost.requests` excludes Jev requests; every `Decision.usage.requests == 0`.

### Step B5 — no-key disclosure

- The status surface (`/korwf status`, #66/#92) reports Jev as disabled; no log, artifact
  or `AuditEntry` contains a credential-shaped string (grep for `apikey|secret|token`
  over `Attempt.artifacts[*]` contents and the audit table is empty or false-positive
  explained).

## Out of scope for this outline

Cap handling (scenario 4), wrong tests (scenario 3), and retrieval ranking on an existing
repository (scenario 2). Conflicting edits between parallel workers are covered by #83.
