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
