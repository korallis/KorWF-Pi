# Gate test outline — `TASK_GATE` and `PHASE_GATE`

Test outline for [docs/gates.md](../../docs/gates.md). Each block is one test to be
implemented in Stage 4 under `test/verification/gates/`. Test names are the block ids
(e.g. `T1.pass`, `B3`). Fixtures are in-memory records per docs/records.md; `SHA` and
`now` are injected — no git, no clock, no network, no Jev call in any test. Jev answers
are pre-written `Decision` rows.

Common **Then** for every rejection block: transition does not commit; `Task`/`Phase`
record unchanged (`afterHash = beforeHash`); exactly one `AuditEntry` with
`actor = engine:gate:task|phase`; rejection reason code as stated; re-evaluation with the
same input gives the same result.

## Fixture vocabulary

- `taskInReview()` — `Task{status: review, blocker: null, revision: 3, riskClass: medium}`
  with 2 acceptance criteria `ac1, ac2` and 2 executable checks `chk1` (covers `ac1`) and
  `chk2` (covers `ac2`), `SHA(T) = "a"*40`.
- `passEvidence(c)` — fresh `Evidence` for check `c`: `revision = SHA(T)`,
  `taskRevision = 3`, `exitStatus = {exited, 0}`, `commandIdentity = c`.
- `noGapDecision()` — fresh `Decision{questionId: task_evidence_gap, action: no_gap,
  override: null, stateHash: H(current input), confidence ≥ θ}`.
- `fallbackDecision(reason)` — `Decision{action: deterministic_fallback,
  override: {actor: policy, reason}}`, fresh.
- `policyNone()` — `policy → {modelReview: false, humanApproval: false}` recorded.
- `phaseGating()` — `Phase{gateStatus: verifying}` with 2 done tasks (each with a gate
  receipt) and 1 integrated check `ichk`, `SHA(P) = "b"*40`.

## 1. Task gate — passing baseline

### T1.pass — all conditions hold
- **Given** `taskInReview()`, `passEvidence(chk1)`, `passEvidence(chk2)`,
  `noGapDecision()`, `policyNone()`
- **When** `task-done` is evaluated
- **Then** result `pass`; `Task.status = done`; a gate receipt with `inputHash` is stored in
  the same transaction; one `AuditEntry`.

### T1.pass.jevDisabled — deterministic fallback satisfies C2
- **Given** `taskInReview()`, passing evidence with `requirementId` per criterion and
  provenance paths ∩ `T.ownership.paths ≠ ∅`, `fallbackDecision(jev_no_key)`, `policyNone()`
- **When** `task-done` is evaluated
- **Then** `pass`; audit entry; receipt records `c2Branch = deterministic_fallback`.

## 2. Task gate — per-predicate rejections

### T2.C0.notInReview
- **Given** `taskInReview()` with `status = in_progress`, otherwise all-green
- **When** `task-done` is evaluated
- **Then** rejected `not_in_review`; audit entry.

### T2.C1.noChecks
- **Given** `taskInReview()` with `checks = []`
- **When** evaluated
- **Then** rejected `no_checks`; audit entry.

### T2.C1.criterionUncovered
- **Given** `taskInReview()` where `chk2.coversCriteria = []` (so `ac2` uncovered), all
  evidence passing, `noGapDecision()`
- **When** evaluated
- **Then** rejected `criterion_uncovered` with detail `ac2`; audit entry.

### T2.C1.eachNonPassState (parameterised over fail, flaky, missing, unavailable, timeout)
- **Given** `taskInReview()`, `passEvidence(chk1)`, and `chk2`'s latest fresh evidence in
  state *S*, `noGapDecision()`, `policyNone()`
- **When** evaluated
- **Then** rejected `check_<S>`; detail names state *S* verbatim (not collapsed to `fail`);
  audit entry.

### T2.C1.latestResultWins
- **Given** `chk1` has an older fresh `fail` row and a newer fresh `pass` row (greater
  `createdAt`), rest green
- **When** evaluated
- **Then** `pass` (latest fresh result is used; tie-break by id is covered by
  `T2.C1.latestResultTie`).

### T2.C1.superseded
- **Given** `chk1`'s only passing row has `supersedesId` pointing at it from a later `fail`
- **When** evaluated
- **Then** rejected `evidence_superseded` → check state `missing`; audit entry.

### T2.C2.gap
- **Given** all checks pass, fresh `Decision{action: gap}`
- **When** evaluated
- **Then** rejected `jev_gap`; audit entry.

### T2.C2.belowThreshold
- **Given** fresh `no_gap` with `confidence < θ`
- **When** evaluated
- **Then** rejected `jev_gap`; audit entry.

### T2.C2.staleHash
- **Given** `noGapDecision()` computed before `chk2` was rerun (stateHash differs)
- **When** evaluated
- **Then** rejected `jev_decision_missing`; audit entry.

### T2.C2.errorIsNotDisabled
- **Given** Jev enabled, `jev.optional = false`, `Decision{action: error}` from a transport
  failure, no fallback row
- **When** evaluated
- **Then** rejected `jev_unavailable`; task stays `review`; audit entry.

### T2.C2.optionalUnavailableFallsBack
- **Given** Jev enabled, `jev.optional = true`, `fallbackDecision(jev_unavailable)`,
  `DET_COVERAGE` satisfied
- **When** evaluated
- **Then** `pass`; receipt records `override.reason = jev_unavailable`.

### T2.C3.reviewMissing
- **Given** `policy → {modelReview: true}` recorded, no `model` reviewer evidence
- **When** evaluated
- **Then** rejected `review_missing`; audit entry.

### T2.C3.approvalMissing
- **Given** `T.riskClass = high`, policy recorded, no `Approval`
- **When** evaluated
- **Then** rejected `approval_missing`; audit entry.

### T2.C3.highRiskCannotUnsetHumanApproval
- **Given** `T.riskClass = high`, a policy result recorded as `humanApproval: false`
- **When** evaluated
- **Then** rejected `approval_missing` (the `high ⇒ humanApproval` clause wins); audit entry.

### T2.C3.policyResultMissing
- **Given** everything else green, no recorded policy result row
- **When** evaluated
- **Then** rejected `policy_result_missing`; audit entry.

## 3. Phase gate — per-predicate

### P1.pass
- **Given** `phaseGating()`, `pass` evidence for `ichk` and every task check at `SHA(P)`,
  fresh phase `no_gap`, phase policy result recorded (`none`)
- **When** `phase-done` is evaluated
- **Then** `pass`; `Phase.gateStatus = passed`; receipt; one audit entry.

### P1.pass.jevDisabled
- **Given** `phaseGating()`, integrated evidence passing, `fallbackDecision(jev_disabled)`
  for the phase, every phase criterion mapped down to a task criterion with a gate receipt
  or covered by a passing integrated check
- **When** evaluated
- **Then** `pass`; receipt records `p3Branch = deterministic_fallback`.

### P2.P1.taskNotDone (parameterised over review, cancelled, failed, blocked, paused_cap)
- **Given** one task in state *S*, rest green
- **When** evaluated
- **Then** rejected `tasks_not_done`; audit entry.

### P2.P1.noGateReceipt
- **Given** a task with `status = done` but no gate receipt
- **When** evaluated
- **Then** rejected `no_gate_receipt`; audit entry.

### P2.P2.integratedCheckFails
- **Given** `ichk` latest fresh evidence `fail`, phase `no_gap`
- **When** evaluated
- **Then** rejected `check_fail`; audit entry.

### P2.P3.fallbackCoverageGap
- **Given** Jev disabled, fallback row present, one phase criterion neither mapped down nor
  covered by an integrated check
- **When** evaluated
- **Then** rejected `fallback_coverage_gap`; audit entry.

### P2.P3.noFallbackRow
- **Given** Jev disabled, no `Decision` row for the phase
- **When** evaluated
- **Then** rejected `jev_decision_missing`; audit entry.

### P2.P4.highRiskTaskNeedsPhaseApproval
- **Given** one task `riskClass = high`, no phase `Approval`
- **When** evaluated
- **Then** rejected `approval_missing`; audit entry.

### P2.P0.integrationOwnerInvalid
- **Given** two attempts with role `integrator`, or none
- **When** evaluated
- **Then** rejected `integration_owner_invalid`; audit entry.

## 4. Bypass scenarios (docs/gates.md §8) — every one ⇒ rejected + audit entry

### B1 — worker sets status directly
- **Given** `taskInReview()` with no passing evidence
- **When** a worker tool call / `korwf` command / raw store patch sets `Task.status = done`
  without a gate receipt (also: a resumed session replays such a patch)
- **Then** rejected `status_write_forbidden`; `Task.status` still `review`; audit entry
  with `actor = engine:gate:task`.

### B2 — Jev "no gap" with a failing check
- **Given** `passEvidence(chk1)`, `chk2` fresh `fail`, fresh `noGapDecision()`, `policyNone()`
- **When** `task-done` is evaluated
- **Then** rejected `check_fail`; audit entry. C2 being ⊤ never substitutes for C1.

### B3 — evidence from a stale revision
- **Given** all evidence has `revision = "0"*40 ≠ SHA(T)`, `noGapDecision()` fresh
- **When** evaluated
- **Then** rejected `evidence_stale_revision` (checks reported `missing`); audit entry.

### B4 — evidence from a stale task revision
- **Given** evidence with `revision = SHA(T)` but `taskRevision = 2` while `T.rev = 3`
  (a check was added after the run)
- **When** evaluated
- **Then** rejected `evidence_stale_task_revision`; audit entry.

### B5 — check registered after the fact with `true`
- **Given** a task in `review` and a request to register `CheckDefinition{command: "true"}`
  (also `exit 0`, `: `, `/bin/true`, `echo ok`, `cd x && true`)
- **When** the check is registered, then `task-done` evaluated
- **Then** registration rejected `check_trivial` at `task-ready`; if forced into the record,
  gate rejects `check_trivial`; audit entry for both.

### B6 — command identity mismatch
- **Given** `chk1.command = "npm test"` but its evidence has
  `commandIdentity.command = "true"` and exit 0
- **When** evaluated
- **Then** rejected `command_identity_mismatch` (state `fail`, not `pass`); audit entry.

### B7 — review from the authoring context
- **Given** `policy → {modelReview: true}`, review evidence whose `reviewer.attemptId`
  equals the implementer attempt, or an attempt whose `handedOffFromAttemptId` chain
  contains it
- **When** evaluated
- **Then** rejected `review_not_independent`; audit entry.

### B8 — approval by a non-user actor or wrong scope
- **Given** `T.riskClass = high`; `Approval` with `actor.kind = policy`, or with
  `scope = {task, otherId}`, or `planRevision ≠ W.planRev`, or `expiresAt < now`
- **When** evaluated
- **Then** rejected `approval_actor_not_user` / `approval_invalid:<reason>`; audit entry.

### B9 — `required = false` as an exemption
- **Given** `chk2.required = false` and `chk2` state `missing`
- **When** evaluated
- **Then** rejected `check_missing`; audit entry.

### B10 — Jev disabled, condition 2 "skipped"
- **Given** Jev disabled (`jev.enabled = false` and no key), all checks pass, no `Decision`
  row at all
- **When** evaluated
- **Then** rejected `jev_decision_missing`; audit entry. Absence is never ⊤.

### B11 — Jev disabled, fallback structurally unsatisfied
- **Given** `fallbackDecision(jev_disabled)`, all checks pass, but `ac2` has no evidence row
  with `requirementId = ac2` (or provenance of `chk2` has no path in `T.ownership.paths`)
- **When** evaluated
- **Then** rejected `fallback_coverage_gap`; audit entry.

### B12 — non-pass states presented as success (flaky / timeout / unavailable)
- **Given** `chk2` evidence `exitStatus ∈ {{flaky, runs}, {timed_out}, {unavailable, r}}`
  and a worker report saying "all green", fresh `no_gap`
- **When** evaluated
- **Then** rejected `check_flaky` / `check_timeout` / `check_unavailable`; audit entry.

### B13 — phase Jev "no gap" over an undone task or failing integrated check
- **Given** `phaseGating()` with one task in `review` (or `ichk` failing), fresh phase
  `no_gap`
- **When** `phase-done` is evaluated
- **Then** rejected `tasks_not_done` (or `check_fail`); audit entry.

### B14 — task-worktree evidence offered as integrated evidence; merged SHA moved
- **Given** `phaseGating()` where the only evidence for task checks is at `SHA(T) ≠ SHA(P)`;
  separately, `SHA(P)` changes between evaluation start and commit
- **When** `phase-done` is evaluated
- **Then** rejected `evidence_stale_revision` / `merged_revision_changed`; audit entry.

## 5. Cross-cutting invariants

### X1 — audit entry written before return
- **Given** any rejecting fixture above, store instrumented to throw after the audit write
- **When** evaluated
- **Then** the `AuditEntry` persists; no receipt; record unchanged.

### X2 — determinism
- **Given** any fixture above
- **When** evaluated twice with identical records, `SHA`, `now`
- **Then** identical result and reason code; no network/Jev calls observed by the mock.

### X3 — Jev disabled leaves C1/C3 (P1/P2/P4) unchanged
- **Given** `fallbackDecision(jev_no_key)` and a failing check (task) / missing high-risk
  approval (phase)
- **When** evaluated
- **Then** rejected `check_fail` / `approval_missing` — disabling Jev never relaxes a
  deterministic or policy term; audit entry.
