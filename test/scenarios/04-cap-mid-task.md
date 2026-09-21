# Scenario 4 — Cap hit mid-task

**Source:** PLAN §2.8 (4). **Records:** [docs/records.md](../../docs/records.md).
**Transitions:** [docs/state-machine.md](../../docs/state-machine.md) (§4.1 caps).
**Gates:** [docs/gates.md](../../docs/gates.md). Issue #18; executed in Stage 5 (#73)
and end to end in Stage 8 (#102).

> Primary model returns quota exhausted; Jev ranks substitutes for the task profile;
> handoff packet built; worker continues on the substitute; switch recorded; next task
> retries the primary.

Conventions are those of [01-greenfield.md](01-greenfield.md) § Conventions.

## Fixture

- **Repository:** the scenario 2 fixture repo at `BASE`.
- **Plan:** one phase `P` with two sequential tasks: `T1` (add
  `GET /orders/:id/summary`) and `T2` (add `GET /users/:id/orders`),
  `Task[T2].dependencies == [T1.id]`. Both `Task.riskClass == 'low'`, each with a test
  check and a typecheck check covering its criteria.
- **Model catalog:** three fixture models. `M-primary` (best card for this profile),
  `M-sub` (adequate substitute), `M-weak` (card says unrated / small context).
- **Provider mock:** `M-primary` answers normally for the first N worker turns of `T1`,
  then returns a quota-exhausted error (HTTP 429 with a `quota` classification, #62) with
  a reset hint of 30 minutes. It answers normally again once the test advances the
  injected clock past the estimated reset. `M-sub` and `M-weak` always answer.
- **Worker mock:** `T1` requires several turns; after the cap the substitute worker
  continues from the handoff packet and finishes the same patch. The worktree contains
  uncommitted, in-progress edits at cap time — the test asserts they survive.
- **Jev mock:** the substitute-ranking question (#63) returns `M-sub` ranked first and
  `M-weak` "not adequate"; selection for `T2` returns `M-primary` when it is available.
- **Clock:** injected. Cap occurs at `t0`; `T1` finishes on `M-sub` at `t0 + 10m`;
  `T2` dispatch is evaluated at `t0 + 35m` (past `estimatedReset`).

## Config

```jsonc
{
  "mode": "supervised",
  "models": {
    "allowlist": ["<fixture-provider>/*"],
    "staticFallbackOrder": ["M-primary", "M-sub", "M-weak"],
    "pins": {}
  },
  "fallback": { "midTask": "handoff", "minDwell": "task", "preferWaitIfResetWithinMinutes": 5 },
  "budgets": { "workflow": { "maxSpendUsd": 3, "maxConcurrency": 1 } },
  "jev": { "enabled": true, "optional": false }   // variant B: enabled=false
}
```

`preferWaitIfResetWithinMinutes: 5` with a 30-minute reset ⇒ substitution, not waiting.

## Stages and issues exercised

| Step | Stage | Issues |
| --- | --- | --- |
| Cap detection → `ModelAvailability` | 5 | #62 |
| Substitute ranking (Jev) / static order (no Jev); "none adequate" | 5 | #63 |
| Mid-task handoff packet, intact worktree | 5, 7 | #64, #87 |
| Recovery to primary at task boundary; dwell; no per-task re-probe | 5 | #65 |
| `Attempt` requested/used/fallback; status/models surfaces | 5 | #66 |
| Failure taxonomy: quota is not a failure | 4 | #52 |
| Simulated-cap single-worker run | 5 | #73 |
| Whole scenario end to end | 8 | #102 |

## Variant A — Jev enabled

### Step A1 — `T1` dispatched on the primary

- **When** `/korwf run P` dispatches `T1`.
- **Then**
  - Selection `Decision` (#60): `Decision.action == 'M-primary'`, `Decision.override == null`.
  - `Attempt[A1]`: `Attempt.taskId == T1.id`, `Attempt.requestedModel == 'M-primary'`,
    `Attempt.usedModel == 'M-primary'`, `Attempt.fallbackReason == null`,
    `Attempt.outcome == null`, `Attempt.handedOffFromAttemptId == null`,
    `Attempt.worktree.baseRevision == BASE`.
  - `ModelAvailability[M-primary]`: `ModelAvailability.capKind == 'none'`,
    `ModelAvailability.detectedAt == null` (or absent — row created lazily is acceptable;
    if present it must say `none`).
  - `Task[T1].status == 'running'`.

### Step A2 — primary returns quota exhausted at `t0`

- **When** the provider mock returns the quota error mid-turn.
- **Then**
  - Cap detection (#62) upserts `ModelAvailability[M-primary]`:
    `ModelAvailability.modelId == 'M-primary'`, `ModelAvailability.capKind == 'quota_exhausted'`,
    `ModelAvailability.detectedAt == t0`, `ModelAvailability.estimatedReset == t0 + 30m`,
    `ModelAvailability.lastProbe == {at: t0, result:'capped', detail: <sanitised>}`;
    `ModelAvailability.lastProbe.detail` contains no credential-shaped string.
  - The row is global: `ModelAvailability` has no `workflowId` and a second workflow in
    the same store observes the same `capKind`.
  - Failure taxonomy (#52): the event is classed `quota/rate-limit`, and
    `Task[T1].status` is **not** `failed`; no `AuditEntry` shows `T1` entering `failed`;
    `Task[T1].blocker == null`.
  - `Attempt[A1]` is settled as handed off: `Attempt[A1].outcome == 'handed_off'`,
    `Attempt[A1].timestamps.endedAt == t0` (± harness tolerance),
    `Attempt[A1].usage.requests >= 1`; the store now rejects patches to `A1`.
  - `Attempt[A1].worktree` is intact: the directory at
    `Attempt[A1].worktree.relativePath` still exists with the in-progress uncommitted
    edits; `git status --porcelain` in it is non-empty and unchanged from cap time.

### Step A3 — Jev ranks substitutes for the task profile

- **When** the fallback ranking question (#63) is asked.
- **Then**
  - `Decision[DS]`: `Decision.subject == {taskId: T1.id, taskRevision: 1}`,
    `Decision.questionId` is the substitute-ranking question id (owned by #63),
    `Decision.override == null`, `Decision.jevModelVersion != null`,
    `Decision.rawDistribution` has keys `⊆ {M-sub, M-weak, none_adequate}` — the capped
    `M-primary` is **excluded before** the question (state-machine.md §4.1 "filtered …
    before cap exclusion"; the eligible set is `{M-sub, M-weak}`, nonempty),
    `Decision.action == 'M-sub'`, `Decision.policyRule` names the fallback rule,
    `Decision.freshness.revision == SHA(worktree head at t0)`.
  - Code enforces after selection: `M-sub` is in the allowlist and within
    `Workflow.budgets` (a `Decision` naming a non-allowlisted model would be rejected —
    negative control: mock returns `M-outside`, engine records `Decision.override ==
    {actor:'policy', action:'reject_selection', reason: <allowlist>}` and takes the next
    ranked candidate).
  - Prefer-wait check: `estimatedReset - t0 == 30m > preferWaitIfResetWithinMinutes`,
    so substitution proceeds; the `AuditEntry` detail names the comparison.

### Step A4 — handoff packet built; worker continues on the substitute

- **When** the engine starts the continuation attempt.
- **Then**
  - `Attempt[A2]`: `Attempt.taskId == T1.id`, `Attempt.taskRevision == 1`,
    `Attempt.requestedModel == 'M-primary'`, `Attempt.usedModel == 'M-sub'`,
    `Attempt.fallbackReason == 'quota_exhausted'`,
    `Attempt.handedOffFromAttemptId == A1.id`,
    `Attempt.worktree.relativePath == Attempt[A1].worktree.relativePath`,
    `Attempt.worktree.branch == Attempt[A1].worktree.branch`,
    `Attempt.role == 'implementer'`, `Attempt.taskProfile == Attempt[A1].taskProfile`.
  - Handoff packet (#64/#87): `Attempt[A2].inputs.bundleHash` non-empty and
    `!= Attempt[A1].inputs.bundleHash`; `Attempt[A2].inputs.contextProvenance` includes
    a `Provenance` with `retrievalMethod == 'tool_output'` or `'pinned'` pointing at the
    handoff artifact; the packet is stored as `Attempt[A1].artifacts[*]` with
    `ArtifactRef.relativePath` relative and `ArtifactRef.contentHash` non-empty. Packet
    content references the in-progress diff by hash, the task revision, and the saved
    stage (`implementer`), never absolute paths.
  - `Task[T1].status == 'running'` throughout (no `paused_cap`, because a substitute
    existed); `count(AuditEntry where recordId == T1.id and afterHash ↔ 'paused_cap') == 0`.
  - The switch is surfaced (#66): `/korwf status` lists `T1` with `M-primary → M-sub
  (quota_exhausted)`; `/korwf models` lists `M-primary` as `capped, reset ≈ t0+30m`.

### Step A5 — `T1` completes on the substitute

- **Then**
  - `Attempt[A2].outcome == 'succeeded'`; evidence and gate as in scenario 2 A3/A5 with
    `Evidence.attemptId == A2.id`; `Task[T1].status == 'done'`.
  - `ModelOutcome[O1]`: `ModelOutcome.attemptId == A1.id`, `ModelOutcome.model == 'M-primary'`,
    `ModelOutcome.result == 'handed_off'`, `ModelOutcome.wasFallback == false`.
  - `ModelOutcome[O2]`: `ModelOutcome.attemptId == A2.id`, `ModelOutcome.model == 'M-sub'`,
    `ModelOutcome.result == 'succeeded'`, `ModelOutcome.wasFallback == true`.
  - Dwell (#65): between `t0` and `T1` done there is no `Attempt` with
    `Attempt.usedModel == 'M-primary'` and `Attempt.taskId == T1.id` other than `A1`,
    and `ModelAvailability[M-primary].lastProbe.at == t0` (no re-probe mid-task).

### Step A6 — next task retries the primary at the task boundary

- **When** `T2` becomes `ready` at `t0 + 35m` (`> ModelAvailability[M-primary].estimatedReset`).
- **Then**
  - Availability is re-evaluated once, at the boundary, under the bounded probe policy:
    `ModelAvailability[M-primary].lastProbe.at == t0 + 35m`,
    `ModelAvailability.lastProbe.result == 'available'`,
    `ModelAvailability.capKind == 'none'`, `ModelAvailability.detectedAt == null`,
    `ModelAvailability.estimatedReset == null`.
  - Selection `Decision` for `T2`: `Decision.action == 'M-primary'`, `Decision.override == null`.
  - `Attempt[A3]`: `Attempt.taskId == T2.id`, `Attempt.requestedModel == 'M-primary'`,
    `Attempt.usedModel == 'M-primary'`, `Attempt.fallbackReason == null`,
    `Attempt.handedOffFromAttemptId == null`.
  - Negative control (reset not yet reached): with `T2` ready at `t0 + 10m`, no probe
    happens (`ModelAvailability.lastProbe.at == t0`), selection excludes `M-primary`,
    `Attempt[A3'].usedModel == 'M-sub'`, `Attempt[A3'].requestedModel == 'M-primary'`,
    `Attempt[A3'].fallbackReason == 'quota_exhausted'` — a fallback at *dispatch* is still
    recorded as a fallback.
  - `T2` completes; `Phase[P].gateStatus == 'passed'`; `Phase[P].report.cost.requests`
    equals `Σ Attempt.usage.requests` over `A1, A2, A3` plus decision requests, and
    `Phase[P].report.cost.costBasis` reflects the least-certain contributing basis.

### Step A7 — all candidates capped (phase pause) and auto-resume

- **Given** the same fixture, but the provider mock also caps `M-sub`, and `M-weak` is
  ranked `none_adequate` by the Jev mock.
- **When** the cap hits during `T1`.
- **Then**
  - `Decision[DS'].action == 'none_adequate'`; the eligible set was nonempty
    (`{M-sub, M-weak}`) so this is a genuine all-capped/no-adequate outcome, not a
    configuration blocker.
  - `task-cap`: `Task[T1].status == 'paused_cap'`, `Task[T1].blocker` names the reason
    (`all_candidates_capped` or the distinct "no adequate substitute" reason —
    state-machine.md §4.1 requires the distinction to be recorded; assert `blocker != null`
    and that it contains one of those two literals).
  - `Attempt[A1].outcome == 'paused_cap'` (not `failed`), worktree intact as in A2.
  - `phase-cap`: `Phase[P].gateStatus == 'paused_cap'`; `Workflow.status == 'paused'`.
  - `ModelAvailability` rows for `M-primary` and `M-sub` both have `capKind ∈
    {quota_exhausted, rate_limited}` and `estimatedReset != null`.
  - Not a failure: no `AuditEntry` shows `T1 → failed` or `P → failed`; the failure retry
    counter for `T1` (#53) is unchanged.
  - **Auto-resume:** when the clock passes `min(estimatedReset)` and a probe finds
    `M-sub` available (`ModelAvailability[M-sub].capKind == 'none'`):
    `phase-cap-resume` ⇒ `Phase[P].gateStatus == 'running'`;
    `task-cap-resume` ⇒ `Task[T1].status == 'ready'` (never directly `running`);
    then dispatch ⇒ `Attempt[A2]` with `Attempt.handedOffFromAttemptId == A1.id`,
    `Attempt.usedModel == 'M-sub'`, `Attempt.fallbackReason == 'quota_exhausted'`,
    `Attempt.requestedModel == 'M-primary'`.
  - Budget was not enlarged: `Workflow.budgets` unchanged (`Workflow.updatedAt` did not
    move for a budget patch; `AuditEntry` for `workflow` shows no `budgets` change).

## Variant B — Jev disabled: static fallback order

With Jev disabled there is no ranking question. The substitute is chosen by the
configured static order (PLAN §3.D "Jev unavailable: use the static fallback ordering";
state-machine.md §4.1 "static ordering when Jev unavailable"), filtered by allowlist,
capabilities, pins and availability.

### Step B1 — dispatch

- Selection `Decision` for `T1`: `Decision.override == {actor:'policy', reason:'jev_disabled'}`,
  `Decision.action == 'deterministic_fallback'`, `Decision.usage.requests == 0`;
  `Attempt[A1].requestedModel == 'M-primary'` (`staticFallbackOrder[0]`),
  `Attempt[A1].usedModel == 'M-primary'`, `Attempt[A1].fallbackReason == null`.

### Step B2 — cap detection

- Identical to A2 — cap detection is code, not Jev: `ModelAvailability[M-primary].capKind
  == 'quota_exhausted'`, `estimatedReset == t0 + 30m`; `Attempt[A1].outcome == 'handed_off'`;
  `Task[T1].status == 'running'`; worktree intact.

### Step B3 — static substitute selection

- `Decision[DS]`: `Decision.override == {actor:'policy', reason:'jev_disabled'}`,
  `Decision.action == 'deterministic_fallback'`, `Decision.jevModelVersion == null`,
  `Decision.rawDistribution == {}` or absent-keys-only, `Decision.policyRule` names the
  static-order rule, `Decision.usage.requests == 0`.
- The chosen model is the first entry of `staticFallbackOrder` that is (a) allowlisted,
  (b) not capped in `ModelAvailability`, (c) satisfies hard constraints from registry
  metadata (context window ≥ `TaskProfile.contextSize` requirement, required modalities)
  — i.e. `M-sub`. `M-weak` is only reached if `M-sub` is capped or fails hard constraints.
- `Attempt[A2]`: `Attempt.requestedModel == 'M-primary'`, `Attempt.usedModel == 'M-sub'`,
  `Attempt.fallbackReason == 'static_fallback_order'` — **this is the visible
  difference from Variant A**, where `fallbackReason == 'quota_exhausted'` records the
  cause and the Jev ranking `Decision` records the choice. In the disabled variant the
  cause is still recoverable from `ModelAvailability[M-primary].capKind` at
  `Attempt[A2].timestamps.startedAt`, and `Attempt[A2].handedOffFromAttemptId == A1.id`.
  (See PR "Decisions and deviations" for why `static_fallback_order` is the literal
  used here.)
- Prefer-wait is still applied deterministically: with a 30-minute reset and a 5-minute
  threshold, substitution proceeds. Negative control: `preferWaitIfResetWithinMinutes: 60`
  ⇒ `Task[T1].status == 'paused_cap'`, `Phase[P].gateStatus == 'paused_cap'`,
  `Task[T1].blocker` names the budget/prefer-wait reason, and auto-resume happens when
  `M-primary` clears.

### Step B4 — handoff and completion

- Identical to A4/A5: packet on `Attempt[A1].artifacts`, `Attempt[A2].inputs.bundleHash
  != Attempt[A1].inputs.bundleHash`, same worktree, `Attempt[A2].outcome == 'succeeded'`,
  `Task[T1].status == 'done'` through the `DET_COVERAGE` fallback gate (scenario 2 B3).
- `ModelOutcome[O2].wasFallback == true`, `ModelOutcome[O2].model == 'M-sub'`.

### Step B5 — retry primary at the task boundary

- Identical to A6: at `t0 + 35m` one probe, `ModelAvailability[M-primary].capKind == 'none'`,
  `Attempt[A3].usedModel == 'M-primary'`, `Attempt[A3].fallbackReason == null`.
  The retry rule is time/availability driven, not Jev driven.

### Step B6 — all capped without Jev

- With `M-primary` and `M-sub` capped, the static order yields `M-weak`. Without Jev
  there is no "none adequate" judgement; the deterministic rule is: `M-weak` is used
  **only if** it passes the hard constraints from registry metadata; otherwise the
  eligible set after filtering is empty of available candidates and the engine takes
  `task-cap`/`phase-cap`. The test runs both:
  - `M-weak` passes hard constraints ⇒ `Attempt[A2].usedModel == 'M-weak'`,
    `Attempt[A2].fallbackReason == 'static_fallback_order'`; the degradation is visible
    in `/korwf status` and recorded in `Phase[P].report.openQuestions` ("substitute
    chosen by static order without adequacy judgement").
  - `M-weak` fails hard constraints (fixture card: context window too small) ⇒
    `Task[T1].status == 'paused_cap'`, `Phase[P].gateStatus == 'paused_cap'`,
    `Attempt[A1].outcome == 'paused_cap'`; auto-resume as in A7 when a cap clears.
- `Σ Decision.usage.requests == 0` for the whole workflow.

### Step B7 — pins are never overridden

- With `models.pins: {"T1": "M-primary"}` and the cap: no substitution happens in either
  variant. `Task[T1].status == 'paused_cap'` (or `blocked` with a pin reason — the
  distinct reason is recorded in `Task[T1].blocker`), `Attempt[A1].outcome == 'paused_cap'`,
  `count(Attempt where taskId == T1.id and usedModel != 'M-primary') == 0`; the user is
  asked via the status surface. Resume proceeds only when `M-primary` clears or the user
  changes the pin (`Workflow.planRevision` unchanged; pin change is config, audited).

## Out of scope for this outline

Expensive-substitute budget arithmetic (#65 tests it directly), main-session routing
(#67), and process-tree termination of the capped worker (#71).
