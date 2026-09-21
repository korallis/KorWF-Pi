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
