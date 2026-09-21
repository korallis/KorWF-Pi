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

## Variant B — Jev disabled: the deterministic fallback

With Jev disabled, C2 is `JEV_DISABLED_FALLBACK` = a recorded fallback `Decision` plus
`DET_COVERAGE` (gates.md §5.2). `DET_COVERAGE` is **structural**: it checks that every
criterion maps to a passing check, that a fresh `Evidence.requirementId` row exists per
criterion, and that each command/assertion check's provenance intersects
`Task.ownership.paths`. Patch #1's wrong test lives in `test/routes/orders.test.ts`, which
**is** owned, so the structural proxy is satisfied. The fallback therefore **cannot** see
that the test exercises the wrong behaviour. This variant documents exactly what the
product does instead, and what it must not do.

### Step B0 — config difference

- `jev.enabled = false`. In addition the policy fixture (#15) for `supervised` mode
  requires an **independent model review** for change class `test_change` (any diff
  touching `test/**`): `policy(low, test_change) == {modelReview: true, humanApproval: false}`.
  This is the deterministic mechanism that stands in for Jev's "does the test exercise
  the requirement" judgement. The reviewer is a coding model (#48), not Jev, and its
  verdict is `Evidence`, not a `Decision`.

### Step B1 — first attempt, fallback row, structural coverage passes

- As A1: `E1`, `E2` fresh at `SHA1`, both `exitStatus == {exited, 0}`.
- `Decision[D1]`: `Decision.questionId == 'task_evidence_gap'`,
  `Decision.action == 'deterministic_fallback'`,
  `Decision.override == {actor:'policy', reason:'jev_disabled'}`,
  `Decision.jevModelVersion == null`, `Decision.confidence == null`,
  `Decision.usage.requests == 0`, `Decision.freshness.revision == SHA1`.
- `DET_COVERAGE(T) == ⊤` is asserted explicitly: `ac1 ∈ chk1.coversCriteria`,
  `state(chk1,T) == 'pass'`, ∃ fresh `Evidence.requirementId == 'ac1'` with
  `exitStatus == {exited, 0}`, and `Evidence[E1].provenance[*].path ∩
  Task[T].ownership.paths ≠ ∅`.
- `Task[T].status == 'review'` (`task-review` passed: checks pass and the fallback row is
  present). **This is the documented limitation:** C2 alone did not catch the wrong test.

### Step B2 — independent review catches it; task goes to `needs_changes`

- **When** the engine requests the policy-required review (`task-review` side effect
  "request independent review by policy").
- **Then**
  - `Attempt[R1]`: `Attempt.role == 'reviewer'`, `Attempt.taskId == T.id`,
    `Attempt.taskRevision == 1`, `Attempt.handedOffFromAttemptId == null`, and
    `Attempt[R1].id != A1.id` (independence, gates.md §2); `Attempt[R1].inputs` do not
    include `A1`'s claim artifact as trusted content (independent review context, #48):
    no `Provenance` in `Attempt[R1].inputs.contextProvenance` points at
    `Attempt[A1].artifacts[*].relativePath`.
  - `Evidence[RV1]`: `Evidence.reviewer == {kind:'model', model: <reviewer model>,
    attemptId: R1.id}`, `Evidence.checkId == null`, `Evidence.requirementId == 'ac1'`,
    `Evidence.revision == SHA1`, `Evidence.taskRevision == 1`,
    `Evidence.exitStatus == {kind:'exited', code:1}` (review returned findings),
    `Evidence.caveats` non-empty and naming `ac1`, `Evidence.artifact` pointing at the
    findings file, `Evidence.provenance[*].path` includes `test/routes/orders.test.ts`.
  - `Task[T].status == 'needs_changes'` (`review → needs_changes`, trigger
    `gap_or_review_changes`, guard `changes_required`), `Task[T].blocker == null`.
  - Task gate never passed: `count(AuditEntry where recordId == T.id and actor ==
    'engine:gate:task')` is `0`, or `1` with a rejection reason `review_missing` if the
    engine evaluated `task-done` before the review landed — in either case no gate
    receipt exists and `Task[T].status != 'done'`.
  - `ModelOutcome[O1].result == 'needs_changes'`.

### Step B3 — recovery and second attempt

- As A3/A4, with the gap finding sourced from `Evidence[RV1]` instead of `Decision[D1]`:
  `Memory[M1].source.kind == 'summary'` with `Memory.source.provenance` covering
  `RV1.artifact`, or `Memory.source.kind == 'excerpt'` on the findings file.
- `Attempt[A2]` applies patch #2 at `SHA2`; `E1'`, `E2'` fresh at `SHA2`.
- `Decision[D2]`: a **new** fallback row at `SHA2`
  (`Decision.freshness.revision == SHA2`, `Decision.override.reason == 'jev_disabled'`,
  `Decision.action == 'deterministic_fallback'`); `DET_COVERAGE` holds again.
- Second review: `Attempt[R2].role == 'reviewer'`, `Evidence[RV2].reviewer.kind ==
  'model'`, `Evidence[RV2].reviewer.attemptId == R2.id`, `Evidence[RV2].revision == SHA2`,
  `Evidence[RV2].exitStatus == {kind:'exited', code:0}`, `Evidence[RV2].supersedesId == RV1.id`.
- `Task[T].status == 'done'`; gate receipt at `SHA2`; C3 satisfied by `RV2`
  (`review_not_independent` would fire if `RV2.reviewer.attemptId ∈ {A1.id, A2.id}` —
  negative control included).

### Step B4 — limitation without a review policy (documented false negative)

- **Given** the same fixture but a policy fixture with `modelReview == false`.
- **Then** after patch #1: `Task[T].status == 'done'` with a passing gate receipt at
  `SHA1`, `Decision[D1].action == 'deterministic_fallback'`, `count(Attempt where taskId
  == T.id) == 1`. The test asserts this outcome **and** that the phase report discloses
  it: `Phase[P].report.openQuestions` contains an entry stating that Jev evidence-gap
  assessment was disabled for `T` (PLAN §3.I "overrides tracked explicitly"), and
  `/korwf status` shows Jev disabled. The product must not pretend the semantic check
  happened: `count(Decision where taskId == T.id and action == 'no_gap') == 0`.
- What the fallback must **never** do (bypass controls, gates.md §8):
  - Skip the row: with no fallback `Decision`, `task-done` rejects `jev_decision_missing`.
  - Weaken C1: with `chk1` set to `exitStatus == {exited, 1}` the gate rejects
    `check_fail` regardless of the fallback row.
  - Waive C3: with `policy.modelReview == true` and no `RV*` row the gate rejects
    `review_missing`.

### Step B5 — cost

- `Σ Decision.usage.requests == 0`; reviewer cost is on `Attempt[R1].usage` and
  `Attempt[R2].usage` and rolls into `Phase[P].report.cost`.

## Out of scope for this outline

Calibrating the evidence-gap evaluator (#98), the adversarial suite for misleading
descriptions (#99), and choosing the review policy per mode (#15, #93).
