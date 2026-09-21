# Scenario 3 — Worker claims done, test is wrong

**Source:** PLAN §2.8 (3). **Records:** [docs/records.md](../../docs/records.md).
**Transitions:** [docs/state-machine.md](../../docs/state-machine.md).
**Gates:** [docs/gates.md](../../docs/gates.md). Issue #18; executed end to end in Stage 8 (#102).

> Checks pass but Jev flags the test doesn't exercise the acceptance criterion; task goes
> to `needs_changes`; recovery path; second attempt succeeds.

Conventions are those of [01-greenfield.md](01-greenfield.md) § Conventions.

## Fixture

- **Repository:** the scenario 2 fixture repo at `BASE` (same files).
- **Goal:** "Reject `POST /orders` with an empty `items` array (HTTP 400, body
  `{error:'empty_order'}`)."
- **Plan:** one phase `P`, one task `T` with `Task.ownership.paths ==
  ['src/routes/orders.ts', 'test/routes/orders.test.ts']`, one acceptance criterion
  `ac1` ("empty items ⇒ 400 empty_order"), two checks:
  `chk1 = <test runner> test/routes/orders.test.ts` (covers `ac1`),
  `chk2 = <typecheck>` (covers `ac1`). `Task.riskClass == 'low'`.
- **Worker patch #1 (the wrong one):** implements the validation in
  `src/routes/orders.ts` **but** the added test asserts only that `POST /orders` with a
  *valid* order returns 201 — it never sends an empty `items` array. All checks pass.
  The worker's completion message says "Implemented and tested empty-order rejection."
- **Worker patch #2 (the right one):** adds a test that posts `items: []` and asserts
  status 400 and body `{error:'empty_order'}`. All checks pass.
- **Jev mock:** for `task_evidence_gap` at the first submission returns a distribution
  where `gap` dominates (the test does not exercise the requirement); at the second
  submission returns `no_gap` above threshold.
- **Recovery policy fixture (#53):** bounded to 2 attempts per task for failure class
  `test_expectation`; remediation must stay within `Task.ownership.paths`.

## Config

```jsonc
{
  "mode": "supervised",
  "models": { "allowlist": ["<fixture-provider>/*"], "staticFallbackOrder": ["M-fast", "M-reason"] },
  "budgets": { "workflow": { "maxSpendUsd": 2, "maxConcurrency": 1 } },
  "jev": { "enabled": true, "optional": false },   // variant B: enabled=false
  "recovery": { "maxAttemptsPerTask": 2 }
}
```

## Stages and issues exercised

| Step | Stage | Issues |
| --- | --- | --- |
| Task gate: claims and Jev scores cannot set `done` | 4 | #46 |
| Evidence-gap / test-exercises-requirement evaluators | 4 | #47 |
| `needs_changes` transition, bounded recovery, second attempt | 3, 4 | #41, #52, #53 |
| Stage 4 suite: false claims, unrelated passing tests | 4 | #55 |
| Independent review context (not anchored on the claim) | 4 | #48 |
| Whole scenario end to end | 8 | #102 |

## Variant A — Jev enabled

### Step A1 — first attempt submits a passing but wrong test

- **Given** `Task[T].status == 'running'`, `Attempt[A1]` with
  `Attempt.role == 'implementer'`, `Attempt.taskRevision == 1`, `Attempt.outcome == null`.
- **When** the worker applies patch #1 at `SHA1` and requests completion.
- **Then**
  - `Attempt[A1].outcome == 'succeeded'` (the attempt finished; "succeeded" is the
    worker's outcome, not the task's), `Attempt[A1].timestamps.endedAt != null`;
    the store rejects any further patch to `A1`.
  - `Task[T].status == 'verifying'` (`task-submit`); the claim text is stored as an
    `Attempt[A1].artifacts[*]` entry with `ArtifactRef.mediaType == 'text/markdown'`,
    never as a truth value on `Task`.
  - `Evidence[E1]` (`chk1`) and `Evidence[E2]` (`chk2`): `Evidence.revision == SHA1`,
    `Evidence.taskRevision == 1`, `Evidence.exitStatus == {kind:'exited', code:0}`,
    `Evidence.reviewer.kind == 'deterministic'`, `Evidence.attemptId == A1.id`;
    `Evidence[E1].provenance[*].path` includes `test/routes/orders.test.ts`.
  - C1 holds (all checks `pass`) — the test asserts `state(chk1,T) == 'pass'` and
    `state(chk2,T) == 'pass'` to prove the rejection below is C2's, not C1's.

### Step A2 — Jev flags the evidence gap; task goes to `needs_changes`

- **When** the engine asks `task_evidence_gap` for `T` at `SHA1`.
- **Then**
  - `Decision[D1]`: `Decision.questionId == 'task_evidence_gap'`,
    `Decision.subject == {taskId: T.id, taskRevision: 1}`,
    `Decision.freshness.revision == SHA1`, `Decision.rawDistribution['gap'] >
    Decision.rawDistribution['no_gap']`, `Decision.action == 'gap'`,
    `Decision.policyRule` names the composition rule that mapped the distribution,
    `Decision.override == null`, `Decision.jevModelVersion != null`,
    `Decision.confidence != null`, `Decision.latencyMs != null`,
    `Decision.usage.requests == 1`.
  - The decision's findings reference the criterion: the transition evidence for
    `task-changes` carries `ac1` (state-machine.md row `task-changes`, "gap/review
    findings with criterion ids").
  - `Task[T].status == 'needs_changes'` (`verifying → needs_changes`, trigger
    `gap_or_review_changes`); `Task[T].blocker == null` (needs_changes is not blocked);
    `Task[T].revision == 1` (no criteria/check change).
  - Nothing set `done`: `count(AuditEntry where table == 'task' and recordId == T.id
    and actor == 'engine:gate:task') == 0` so far (the task never reached `review`, so
    the task gate was not evaluated); no gate receipt exists.
  - Negative control: the test replays the same records but with a forged fresh
    `Decision.action == 'no_gap'` written outside `src/jev/` — the store rejects the
    write (records.md §4, gates.md §8 invariant "Decision authored by anything other than
    src/jev is rejected"), and `Task[T].status` remains `needs_changes`.
  - `ModelOutcome[O1]`: `ModelOutcome.attemptId == A1.id`,
    `ModelOutcome.result == 'needs_changes'`, `ModelOutcome.wasFallback == false`.

### Step A3 — recovery path

- **When** the recovery policy (#53) evaluates `T`.
- **Then**
  - Failure classification is recorded (#52) as `test_expectation` in the audited
    transition detail; the recovery decision is bounded: attempt count for `T` (`count(Attempt
    where taskId == T.id) == 1`) is `< config.recovery.maxAttemptsPerTask`.
  - No side effects need reconciling (the task is local code); `recovery_authorized` is
    recorded as part of the `task-ready` evidence.
  - `Task[T].status == 'ready'` (`needs_changes → ready`, `task-ready`) with all READY
    guards re-checked: `Task[T].checks.length >= 1`, dependencies done, approvals valid
    (`Approval.invalidation == null` for the plan approval), `Task[T].blocker == null`.
  - `Memory[M1]`: a `Memory` with `Memory.type == 'reusable_lesson'` or
    `'temporary_observation'`, `Memory.source.kind == 'decision'`,
    `Memory.source.decisionId == D1.id`, `Memory.revision == SHA1`,
    `Memory.status == 'active'`, content naming `ac1` — so the second attempt's briefing
    contains the gap finding without the first worker's claim being treated as fact.
  - There is no `needs_changes → running` shortcut: the `AuditEntry` sequence for `T`
    contains a `ready` state between `needs_changes` and the next `running`.

### Step A4 — second attempt succeeds

- **When** `T` is dispatched again and the worker applies patch #2 at `SHA2`.
- **Then**
  - `Attempt[A2]`: `Attempt.taskId == T.id`, `Attempt.taskRevision == 1`,
    `Attempt.handedOffFromAttemptId == null` (a fresh attempt, not a handoff),
    `Attempt.inputs.contextProvenance` includes the gap finding (`Memory[M1]` content
    hash appears in `Attempt.inputs.bundleHash` inputs, or a `Provenance.retrievalMethod
    == 'pinned'` entry for it), `Attempt.worktree.branch == Attempt[A1].worktree.branch`
    or a new branch based on `SHA1` (task-kind policy decides; assert
    `Attempt[A2].worktree.baseRevision ∈ {BASE, SHA1}`).
  - `Attempt[A2].outcome == 'succeeded'`; `Task[T].status == 'verifying'`.
  - `Evidence[E1']`, `Evidence[E2']` at `SHA2`, `Evidence.taskRevision == 1`,
    `Evidence.exitStatus == {kind:'exited', code:0}`, `Evidence.attemptId == A2.id`,
    `Evidence.supersedesId ∈ {E1.id, null}` (the first-attempt rows are superseded or
    simply stale by revision — either way `superseded(E1) ∨ E1.revision != SHA2`).
  - `Decision[D2]`: `Decision.questionId == 'task_evidence_gap'`,
    `Decision.freshness.revision == SHA2`, `Decision.stateHash != D1.stateHash`,
    `Decision.action == 'no_gap'`, `Decision.confidence >= θ`, `Decision.override == null`.
  - `Task[T].status: verifying → review → done`; gate receipt `revision == SHA2`; exactly
    one `AuditEntry` with `AuditEntry.actor == 'engine:gate:task'` and result pass.
  - `ModelOutcome[O2]`: `ModelOutcome.attemptId == A2.id`,
    `ModelOutcome.result == 'succeeded'`; `count(ModelOutcome where workflowId == W.id) == 2`.
  - `D1`, `E1`, `E2`, `O1` all still exist unchanged (append-only; `updatedAt == createdAt`).

### Step A5 — cost and reporting

- `Attempt[A1].usage.requests + Attempt[A2].usage.requests` equals the mock worker's
  request count; `Σ Decision.usage.requests == 2` for `task_evidence_gap` on `T`.
- `Phase[P].report.cost` includes both attempts; `Phase[P].report.openQuestions`
  may mention the first attempt's gap; `Phase[P].report.evidenceIds` contains integrated
  evidence at `SHA(P)` only.
- `/korwf why T` (#92) shows `D1` with its `Decision.rawDistribution`,
  `Decision.policyRule` and `Decision.action` and no credential material.
