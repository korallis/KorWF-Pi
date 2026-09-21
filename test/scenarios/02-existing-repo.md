# Scenario 2 — Feature on an existing repo

**Source:** PLAN §2.8 (2). **Records:** [docs/records.md](../../docs/records.md).
**Transitions:** [docs/state-machine.md](../../docs/state-machine.md).
**Gates:** [docs/gates.md](../../docs/gates.md). Issue #18; executed end to end in Stage 8 (#102).

> Retrieval ranks the right files; one task; model chosen for the task type; check
> invalidated after a later edit; re-verification.

Conventions are those of [01-greenfield.md](01-greenfield.md) § Conventions.

## Fixture

- **Repository:** a sanitised fixture repo (`test/fixtures/existing-repo/`, created by
  #96 or inline by this test) with ~40 files: a small HTTP service with
  `src/routes/users.ts`, `src/routes/orders.ts`, `src/db/repo.ts`, `src/auth/session.ts`,
  `test/routes/users.test.ts`, `test/routes/orders.test.ts`, a `README.md`, and several
  decoy files that share vocabulary but are unrelated (`docs/legacy-orders-migration.md`,
  `scripts/seed-orders.ts`). It has one commit, `BASE`, and a clean working tree.
- **Goal:** "Add a `GET /orders/:id/summary` endpoint returning item count and total."
  The correct retrieval set is `{src/routes/orders.ts, src/db/repo.ts,
  test/routes/orders.test.ts}`; `src/auth/session.ts` and the decoys should rank below.
- **Expected plan:** one phase `P` with one task `T` owning
  `src/routes/orders.ts`, `src/db/repo.ts`, `test/routes/orders.test.ts`, with two
  acceptance criteria (`ac1` count, `ac2` total) and two checks:
  `chk1 = <test runner> test/routes/orders.test.ts` (covers `ac1`, `ac2`) and
  `chk2 = <typecheck>` (covers `ac1`, `ac2`).
- **Workers:** mocked adapter applying a pre-recorded patch, then a completion request.
- **Model catalog:** two fixture models with different cards: `M-reason` (hint: deep
  reasoning, higher cost) and `M-fast` (hint: routine edits, tool use). The expected
  selection for this routine, low-risk backend task is `M-fast`.
- **The later edit:** after the task reaches `review`, the test (acting as the user)
  commits a one-line change to `src/db/repo.ts` on the task branch, producing `SHA2`.

## Config

```jsonc
{
  "mode": "supervised",
  "models": { "allowlist": ["<fixture-provider>/*"], "staticFallbackOrder": ["M-fast", "M-reason"] },
  "budgets": { "workflow": { "maxSpendUsd": 2, "maxConcurrency": 1 } },
  "jev": { "enabled": true, "optional": false }   // variant B: enabled=false
}
```

## Stages and issues exercised

| Step | Stage | Issues |
| --- | --- | --- |
| Intake on existing repo, retrieval ranking, provenance | 3 | #33, #35, #37 |
| Task profile and model selection | 5 | #59, #60, #56, #57 |
| Check registration, evidence at exact revision | 4 | #45 |
| Evidence invalidation after a later edit, re-verification | 4 | #50, #51 |
| Task gate (Jev and fallback) | 4 | #46, #47 |
| Dirty-tree / identity checks | 5 | #70 |
| Whole scenario end to end | 8 | #102 |

## Variant A — Jev enabled

### Step A1 — plan: retrieval ranks the right files

- **Given** the fixture repo at `BASE`; Jev mock answers the context-relevance question
  (#35) with high relevance for the three target files and low for decoys.
- **When** the user runs `/korwf plan "<goal>"` and approves.
- **Then**
  - `Workflow.repoIdentity.rootCommit == BASE root`, `Workflow.baseRevision == BASE`,
    `Workflow.planRevision == 1`, `Workflow.status == 'ready'`.
  - Retrieval decisions: for each shortlisted candidate one `Decision` with the #35
    relevance question id, `Decision.subject == null` or the planning-phase subject,
    `Decision.override == null`, `Decision.freshness.revision == BASE`; the ranked
    `Decision.action` for the three target files is the "include" action and for
    `docs/legacy-orders-migration.md` and `scripts/seed-orders.ts` it is not.
  - Provenance: `Attempt.inputs.contextProvenance` on the planner attempt contains an
    entry with `Provenance.path == 'src/routes/orders.ts'`,
    `Provenance.revision == BASE`, `Provenance.retrievalMethod ∈ {search, symbol, dependency}`,
    `Provenance.contentHash` non-empty; no entry has an absolute `Provenance.path`.
  - Original tool output retained alongside the filtered excerpts (PLAN §3.B): a
    `Memory` with `Memory.type == 'temporary_observation'` and
    `Memory.source.kind == 'summary'` whose `Memory.source.provenance` covers the full
    search result, `Memory.revision == BASE`, `Memory.status == 'active'`.
  - Plan: `count(Task where workflowId == W.id) == 1`; `Task[T].revision == 1`;
    `Task[T].ownership.paths` equals the three target files; `Task[T].checks.length == 2`;
    every `Task[T].acceptanceCriteria[i].id` is in some `Task[T].checks[j].coversCriteria`;
    `Task[T].riskClass == 'low'`; `Task[T].status == 'proposed'`.

### Step A2 — model chosen for the task type

- **When** `/korwf run P` is executed and `T` is dispatched.
- **Then**
  - `Task[T].status: proposed → ready → running` with `AuditEntry` per transition.
  - A task-profile `Decision` (#59) with `Decision.subject == {taskId: T.id, taskRevision: 1}`,
    `Decision.override == null`; its result is stored on `Attempt[A1].taskProfile` with
    `TaskProfile.domain` non-empty, `TaskProfile.risk == 'low'`,
    `0 <= TaskProfile.reasoningDepth <= 1`, `0 <= TaskProfile.contextSize <= 1`.
  - A model-selection `Decision` (#60) with `Decision.override == null`,
    `Decision.jevModelVersion != null`, `Decision.rawDistribution` keyed by candidate
    model refs (only allowlisted refs appear), `Decision.action == 'M-fast'`,
    `Decision.policyRule` names the selection rule.
  - `Attempt[A1].requestedModel == 'M-fast'`, `Attempt[A1].usedModel == 'M-fast'`,
    `Attempt[A1].fallbackReason == null`, `Attempt[A1].role == 'implementer'`,
    `Attempt[A1].taskRevision == 1`, `Attempt[A1].worktree.baseRevision == BASE`,
    `Attempt[A1].profile` names the implementer contract.
  - The selection is visible: `/korwf status` output names `M-fast` for `T` (#66).
  - Dirty-tree check: the user's working tree is untouched — `git status --porcelain`
    in the main checkout is empty after dispatch (#70); the worker's edits are on
    `Attempt[A1].worktree.branch`.

### Step A3 — first verification at `SHA1`

- **When** the worker submits (`task-submit`), and checks run.
- **Then**
  - `Attempt[A1].outcome == 'succeeded'`, `Attempt[A1].timestamps.endedAt != null`.
  - `Task[T].status == 'verifying'` then `'review'`.
  - `Evidence[E1]` for `chk1`: `Evidence.checkId == 'chk1'`, `Evidence.revision == SHA1`,
    `Evidence.taskRevision == 1`, `Evidence.attemptId == A1.id`,
    `Evidence.exitStatus == {kind:'exited', code:0}`,
    `Evidence.commandIdentity.command == chk1.command`,
    `Evidence.commandIdentity.environmentHash` non-empty,
    `Evidence.provenance[*].path` includes `test/routes/orders.test.ts`,
    `Evidence.supersedesId == null`.
  - `Evidence[E2]` for `chk2` likewise at `SHA1`.
  - `Decision[D1]`: `Decision.questionId == 'task_evidence_gap'`,
    `Decision.action == 'no_gap'`, `Decision.override == null`,
    `Decision.freshness.revision == SHA1`, `Decision.subject.taskRevision == 1`.
  - `Task[T].status == 'review'`; policy result recorded with
    `modelReview == false`, `humanApproval == false` for `riskClass == 'low'` in
    `supervised` mode (per #15 policy fixture).
