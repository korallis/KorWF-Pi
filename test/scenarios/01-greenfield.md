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
