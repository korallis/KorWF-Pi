# Task gate and phase gate — testable specification

Design authority: [PLAN.md](../PLAN.md) §2.4 (task gate), §2.5 (phase gate), §3.F
(evidence invalidation, explicit check states). Records are the ones in
[docs/records.md](records.md) and `src/storage/records.ts`; transitions are the ones in
[docs/state-machine.md](state-machine.md) and `src/workflow/transitions.ts`
(`TASK_DONE_PRECONDITIONS`, `PHASE_DONE_PRECONDITIONS`). This document defines both gates
as **predicates over records**, defines every term they use, fixes the Jev-disabled
fallback, and enumerates the bypass attempts Stage 4 tests must reject. The test outline
is [test/spec/gates.spec.md](../test/spec/gates.spec.md).

Normative words: **MUST** / **MUST NOT** are requirements on the Stage 4 implementation.
The gates are evaluated by the engine only. Nothing else — worker, user command, Jev,
tool, resumed session — may set `Task.status = done` or `Phase.gateStatus = passed`.

## 1. Notation

- `T` — the `Task` record under evaluation; `T.rev` = `Task.revision`;
  `T.checks` = `Task.checks` (list of `CheckDefinition`); `T.ac` = `Task.acceptanceCriteria`.
- `W` — the `Workflow` containing `T`; `W.planRev` = `Workflow.planRevision`;
  `W.policyVersion`, `W.mode` as on the record.
- `P` — a `Phase`; `P.ac` = `Phase.acceptanceCriteria`; `P.tasks` = every `Task` with
  `phaseId = P.id`.
- `E(T)` — every `Evidence` row with `taskId = T.id`. `E(P)` — every `Evidence` row with
  `taskId = null` and whose `requirementId` is a criterion id of `P` (phase-level evidence;
  the storage column is `taskId FK` nullable for this purpose — see §9 decision D1).
- `A` — every `Approval` row of `W`; `D` — every `Decision` row of `W`.
- `SHA(T)` — the **current revision**: the full 40-hex Git SHA at the head of the task's
  worktree at the moment the gate is evaluated, read by `src/git/` (never supplied by the
  worker). `SHA(P)` — the SHA of the merged result on `P.integrationPoint.branch`.
- `now` — the ISO timestamp passed in by the caller; the gate does no clock access.
- `⊤` / `⊥` — the predicate holds / does not hold. `∧` = and, `∨` = or, `∀` = for all,
  `∃` = there exists, `¬` = not.
- A gate **evaluation** returns either `pass` (the transition may commit) or
  `reject(reasonCode, detail)` and MUST write one `AuditEntry` (see §7) in both cases.

Every predicate below is **pure and deterministic**: same records + same `SHA` + same
`now` ⇒ same result. Nothing in a gate reads the network or asks Jev; Jev's answer is a
`Decision` row that already exists (or does not).

## 2. Term definitions (glossary)

| Term | Definition (over records) |
| --- | --- |
| **registered check** | An element `c ∈ T.checks` at `T.rev`. Checks are registered by the planner *before* the task becomes `ready` (`checks_registered` precondition). A check added to `T.checks` bumps `T.rev` (records.md §5.1), which invalidates all prior evidence. |
| **executable check** | `c.kind ∈ {command, lint, typecheck, assertion}`. The engine runs `c.command` in `c.cwd` at `SHA(T)` and records the result as `Evidence`. |
| **human check** | `c.kind = human`. Satisfied only by `Evidence` with `reviewer.kind = human` and `exitStatus = {exited, 0}`. |
| **trivial check** | An executable check whose `command`, after trimming and stripping a leading `cd … &&`, is in the deny-list `{true, :, exit 0, /bin/true, echo …, printf …}` or whose command token list contains no reference to the repository (no path, no package script, no test runner). A trivial check is **not** a registered check for gate purposes (§3, C1) and its registration MUST be rejected at `task-ready` with reason `check_trivial`. |
| **check result** | The `Evidence` row `e` with `e.checkId = c.id` and `e.reviewer.kind = deterministic` (or `human` for human checks). |
| **check state** | Derived from `e.exitStatus` (§4). Exactly one of `pass`, `fail`, `flaky`, `missing`, `unavailable`, `timeout`. |
| **fresh evidence** | `e ∈ E(T)` such that `e.taskRevision = T.rev ∧ e.revision = SHA(T) ∧ ¬superseded(e)` where `superseded(e) ⇔ ∃ e' ∈ E(T): e'.supersedesId = e.id`. Any `e` that is not fresh is **stale** and contributes nothing to any gate. |
| **latest result for `c`** | The fresh evidence `e` for `c` with the greatest `createdAt`; if several share `createdAt`, the greatest `id` (deterministic tie-break). If there is none, the check state is `missing`. |
| **current revision** | `SHA(T)` as defined in §1. Supplied by `src/git/`, never by a record written by a worker. |
| **evidence gap** | For a criterion `a ∈ T.ac`: `¬∃ c ∈ T.checks: a.id ∈ c.coversCriteria` (uncovered criterion) **or** a fresh `Decision` (§5) whose `action ≠ no_gap` for `a`. |
| **fresh decision** | `d ∈ D` with `d.subject = {taskId: T.id, taskRevision: T.rev}`, `d.freshness.revision = SHA(T)`, `d.questionId ∈ {task_evidence_gap, phase_evidence_gap}` at the question version pinned by `W.policyVersion`, and `d.stateHash` equal to the hash the engine computes over the current gate input (§5.1). Any other decision is stale and ignored. |
| **Jev disabled** | `W.mode`/config resolves `jev.enabled = false` **or** no Jev credential is present **or** Jev was unreachable/timed out for this evaluation. The engine records which in `Decision.override = {actor: policy, reason: jev_disabled | jev_no_key | jev_unavailable}`. Disabled is a *recorded* state, never inferred from an absent row. |
| **policy** | The review policy at `W.policyVersion` (issue #15): a pure function `policy(T.riskClass, changeClass) → {modelReview: bool, humanApproval: bool}`. |
| **independent review** | `Evidence` with `reviewer.kind = model`, `reviewer.attemptId ≠ any Attempt whose role ∈ {implementer, integrator} for T`, and `exitStatus = {exited, 0}`, fresh. Independence is checked structurally: reviewer attempt `≠` author attempt **and** `reviewer.attemptId.handedOffFromAttemptId` chain does not contain the author attempt. |
| **valid approval** | `a ∈ A` with `approvalInvalidReason(a, {task: T, planRevision: W.planRev, now}) = null`, `a.scope = {task, T.id}`, `a.riskClass ≥ T.riskClass`, `a.permittedAction = complete_task`, `a.actor.kind = user`. A `policy` actor MUST NOT satisfy a high-risk approval. |
| **author** | The `Attempt` whose `outcome` produced the completion claim being gated (the attempt bound to `task-submit`). |
| **audit entry** | An `AuditEntry` row (§7). |

### 2.1 Where the task gate lives (issue #46)

`src/verification/task-gate.ts` implements §3–§5 and §7 for the task gate:

- `evaluateTaskGate(input)` is the pure predicate. It takes the revision as an
  argument rather than reading one, evaluates **all four** conditions (never
  short-circuiting), and returns one `GateConditionResult` per condition plus an
  ordered list of `{condition, reasonCode, detail}`. `C1` and `C3` take no
  `Decision` parameter at all, so §3's "Jev cannot waive (1) or (3)" is a fact
  about the signatures rather than a rule someone has to remember.
- `runTaskGate(store, taskId, options)` builds that input from the store, reads
  the revision through `src/git/` (`revisionAt`), and records **one**
  `gate_receipt` row for the evaluation, pass or reject, before returning.
- `completeTask(store, taskId, …)` is the only supported route to `done`: it
  evaluates, records, and on a pass requests `task-done` with that receipt.
- The single-writer guarantee of §7 is enforced in
  `TaskRepository.beforeUpdate`: a patch setting `status = "done"` without a
  passing, unconsumed, revision-matched receipt is refused with
  `status_write_forbidden`, whatever path it arrives by.
- `/korwf why <taskId>` renders the recorded conditions of the latest receipt,
  so a refusal is explained from stored fields and not from a message string.

## 3. Task gate — `TASK_GATE(T)`

The `task-done` transition (`review → done`) commits **iff** `TASK_GATE(T) = ⊤`. It is
re-evaluated at commit time even if `task-review` passed earlier (state-machine.md §4).

```
TASK_GATE(T) ≝ C1(T) ∧ C2(T) ∧ C3(T) ∧ C0(T)

C0(T)  ≝ T.status = review                                      -- gate entered from review only
       ∧ T.blocker = null
       ∧ author(T).outcome = completion_requested                -- a claim exists but is not evidence

C1(T)  ≝ |T.checks| ≥ 1                                          -- deterministic checks pass
       ∧ ∀ c ∈ T.checks: ¬trivial(c)
       ∧ ∀ c ∈ T.checks: state(c, T) = pass                     -- see §4; `required=false` is NOT an exemption
       ∧ ∀ a ∈ T.ac: ∃ c ∈ T.checks: a.id ∈ c.coversCriteria     -- every criterion has a check

C2(T)  ≝ JEV_NO_GAP(T) ∨ JEV_DISABLED_FALLBACK(T)                 -- exactly one branch is recorded (§5)

C3(T)  ≝ let r = policy(T.riskClass, changeClass(T)) in
         (r.modelReview   ⇒ ∃ fresh independent review e ∈ E(T))
       ∧ (r.humanApproval ⇒ ∃ valid approval a ∈ A)
       ∧ (T.riskClass = high ⇒ r.humanApproval)                  -- policy cannot unset human approval for high risk
       ∧ policyResultRecorded(T)                                 -- a Decision/Evidence row stating r exists, fresh
```

Where `state(c, T)` is defined in §4 and `changeClass(T)` is the change class computed by
`src/git/` from the diff between `W.baseRevision`-derived task base and `SHA(T)` (issue #15
defines classes; the gate only consumes the result).

Consequences, each of which is a bypass test in §8:

- `C1` is unaffected by `C2`: a `no_gap` decision with any check not in `pass` ⇒ `⊥`
  (PLAN §2.4 "a Jev 'no gap' result cannot substitute for a failing check").
- `C1` and `C3` have no Jev term at all, so Jev cannot waive them.
- No term reads `Task.status = done`, `Attempt.outcome`, or any worker-authored string as
  a truth value; the worker's claim only appears in `C0` as "a claim exists".
- All evidence terms require **fresh** evidence (§2), so `e.revision ≠ SHA(T)` ⇒ that
  evidence is invisible ⇒ the check is `missing` ⇒ `C1 = ⊥`.

## 4. Check states

`state(c, T)` maps the latest fresh result `e` for check `c` (§2) to exactly one state:

| State | Condition | Satisfies C1? |
| --- | --- | --- |
| `pass` | `e.exitStatus = {exited, code} ∧ code = c.expectedExitCode ∧ e.commandIdentity.command = c.command ∧ e.commandIdentity.cwd = c.cwd` (human check: `e.reviewer.kind = human ∧ code = 0`) | **yes** — the only one |
| `fail` | `e.exitStatus = {exited, code} ∧ code ≠ c.expectedExitCode`, or `{signalled, _}`, or command identity differs from `c` | no |
| `flaky` | `e.exitStatus = {flaky, runs}` — the engine reran and got differing codes | no |
| `missing` | no fresh evidence for `c` (none recorded, all stale, or all superseded), or `e.exitStatus = {missing}` | no |
| `unavailable` | `e.exitStatus = {unavailable, reason}` — the runner, toolchain or environment could not execute the command | no |
| `timeout` | `e.exitStatus = {timed_out}` | no |

Rules:

- **Only `pass` satisfies C1.** Every other state, including the absence of a row, is a
  distinct, explicit non-success (PLAN §3.F). The gate MUST report the state name in the
  rejection detail; it MUST NOT collapse `flaky`/`missing`/`unavailable`/`timeout` into
  `fail` in the audit entry, and MUST NOT treat any of them as `pass`.
- `expectedExitCode` is read from `c` at `T.rev`. A check whose `expectedExitCode` was
  edited to match an observed failure bumps `T.rev` and invalidates the evidence anyway.
- `CheckDefinition.required = false` changes **nothing** about `state(c, T)` or C1
  (transitions.ts `all_checks_pass_exact_revision`). It exists for reporting only.
- Command identity is compared against the **definition**, so evidence produced by running a
  different command (e.g. `true`) under a registered check id is `fail`, not `pass`.

### 4.1 Where these states come from (issue #45)

`src/verification/checks.ts` (`runCheck`) is the only producer of deterministic
`Evidence`, and `src/verification/evidence.ts` maps one run onto the table above:

- `Evidence.revision` is read from the worktree through `src/git/` **at run time**, never
  supplied by the caller and never cached, so §2 freshness is a property of the run rather
  than of what the runner was told.
- A command that could not be executed — absent binary, `EACCES`, missing `cwd`, no
  revision to pin to — is `{unavailable, reason}`. A shell exit `127` accompanied by a
  not-found message is `unavailable`; a program that *chooses* exit 127 is an ordinary
  `{exited, 127}`, hence `fail`. Neither is ever `pass`.
- A check whose command cannot fail (`isVerifyingCheck`, issue #44) is refused before it
  runs, recorded as `{unavailable, weak_check}` at the current revision.
- A deadline produces `{timed_out}` after killing the whole process tree; descendants are
  snapshotted **before** the kill because a detached child reparents to PID 1 (ADR 0004).
- `human` checks never reach `runCheck`'s evidence path: `requestHumanCheck` returns a
  pending approval request, so a human check is satisfied only by a human-reviewer
  `Evidence` row created from a granted `Approval`.
- Stored `stdout`/`stderr` pass through `src/security/redact.ts` before truncation, so a
  truncated snippet cannot end mid-secret, and the environment is fingerprinted by variable
  **name** only.

Project-wide checks from configuration are merged into the task's registered list by
`registeredChecks` under a `project:` id prefix, so a plan cannot silence `npm test` by
registering a check of its own with the same name.

## 5. Condition 2 — Jev evidence-gap assessment and the Jev-disabled fallback

Condition 2 is a **disjunction of two recorded outcomes**. Exactly one of them must be
present as a fresh `Decision` row; "no row" is neither.

### 5.1 `JEV_NO_GAP(T)` (Jev enabled)

```
JEV_NO_GAP(T) ≝ ∃ d ∈ D:
      d.subject = {taskId: T.id, taskRevision: T.rev}
    ∧ d.freshness.revision = SHA(T)
    ∧ d.questionId = task_evidence_gap ∧ d.questionVersion = pinned(W.policyVersion)
    ∧ d.stateHash = H(T.rev, SHA(T), T.ac, T.checks, {(c.id, state(c,T)) | c ∈ T.checks},
                      {e.id, e.provenance.contentHash | fresh e ∈ E(T)})
    ∧ d.override = null
    ∧ d.action = no_gap
    ∧ d.confidence ≥ θ(W.policyVersion)          -- threshold from policy, deterministic
```

`H` is the engine's canonical state hash (records.md §7). Because the hash covers check
states, a decision made while a check was `fail` is stale the moment the check is rerun; a
decision cannot be "carried" across a fix. `d.action` is set by the **composition policy
rule** (`d.policyRule`) from `d.rawDistribution`, in code; the raw model output never sets
`action` directly.

What Jev is asked (question `task_evidence_gap`, versioned under `src/decisions/`): given
`T.ac`, `T.checks`, the fresh evidence and its provenance, (a) is every criterion supported
by presented evidence, (b) do the tests exercise the requirement rather than something
unrelated? Any answer other than a parseable `no_gap` above threshold — `gap`, `unknown`,
malformed, error, timeout — yields `d.action ∈ {gap, error}` or no row, and C2 falls to
§5.2 only if the disabled fallback is *separately* recorded. **An error is not disabled.**

### 5.2 `JEV_DISABLED_FALLBACK(T)` (Jev disabled, no key, or unavailable)

The product MUST work with no Jev key (AGENTS.md §4). When Jev is disabled, condition 2 is
**replaced by a deterministic predicate**, never skipped and never assumed true:

```
JEV_DISABLED_FALLBACK(T) ≝ ∃ d ∈ D:
      d.subject = {taskId: T.id, taskRevision: T.rev}
    ∧ d.freshness.revision = SHA(T)
    ∧ d.questionId = task_evidence_gap
    ∧ d.override = {actor: policy, reason ∈ {jev_disabled, jev_no_key, jev_unavailable}}
    ∧ d.action = deterministic_fallback
    ∧ d.stateHash = H(...)                       -- same hash as §5.1
    ∧ DET_COVERAGE(T)

DET_COVERAGE(T) ≝ ∀ a ∈ T.ac:
      ∃ c ∈ T.checks: a.id ∈ c.coversCriteria ∧ state(c,T) = pass       -- covered by a passing check
    ∧ ∀ a ∈ T.ac: ∃ e fresh ∈ E(T): e.requirementId = a.id ∧ state(e) = pass -- evidence row per criterion
    ∧ ∀ c ∈ T.checks with kind ∈ {command, assertion}:
          ∃ p ∈ provenance(latest(c)): p.path ∩ T.ownership.paths ≠ ∅       -- the test touched owned code
```

Properties:

- The fallback is **stricter on structure** than Jev: it demands one-to-one criterion →
  passing-check → evidence-row coverage, and that each command/assertion check's
  provenance intersects the task's ownership (a deterministic proxy for "tests exercise
  the requirement").
- The fallback row is written **by the engine** when it observes disabled/no-key/
  unavailable *before* asking, or after a transport failure. A worker or tool cannot write
  `Decision` rows (records.md §4: `decision` is engine-append-only).
- `jev_unavailable` (transport error/timeout while enabled) records the fallback **only
  if** `W.mode`/config permits `jev.optional = true`; otherwise the gate rejects with
  `jev_unavailable` and the task stays in `review` for retry. This is the conservative
  choice (§9 D2).
- When disabled, **C1 and C3 are unchanged**. Disabling Jev removes an advisory signal; it
  never removes a deterministic check or a policy-required review.
- The fallback also covers the "no Jev key at startup" case: `jev_no_key` is detected
  once per workflow and every decision in that workflow is a recorded fallback.

Truth table for C2 (rows are the recorded state; anything not listed ⇒ `⊥`):

| Jev config | Recorded row | C2 |
| --- | --- | --- |
| enabled | fresh `no_gap`, above threshold, no override | ⊤ |
| enabled | fresh `gap` / `error` / below threshold | ⊥ (`jev_gap` / `jev_error`) |
| enabled | none, or stale hash/revision | ⊥ (`jev_decision_missing`) |
| enabled, `jev.optional=true`, transport failed | override `jev_unavailable` + `DET_COVERAGE` ⊤ | ⊤ |
| enabled, `jev.optional=false`, transport failed | override `jev_unavailable` | ⊥ (`jev_unavailable`) |
| disabled / no key | override `jev_disabled`/`jev_no_key` + `DET_COVERAGE` ⊤ | ⊤ |
| disabled / no key | override recorded, `DET_COVERAGE` ⊥ | ⊥ (`fallback_coverage_gap`) |
| disabled / no key | no override row | ⊥ (`jev_decision_missing`) — "skipped" is not a state |

## 6. Phase gate — `PHASE_GATE(P)`

The `phase-done` transition (`gating → done`, `Phase.gateStatus = passed`) commits **iff**
`PHASE_GATE(P) = ⊤`. It is evaluated on the **merged result** at `SHA(P)`, by the sole
integration owner (PLAN §3.E), and re-evaluated whenever `SHA(P)` changes
(`phase-stale-evidence`).

```
PHASE_GATE(P) ≝ P1(P) ∧ P2(P) ∧ P3(P) ∧ P4(P) ∧ P0(P)

P0(P)  ≝ P.gateStatus ∈ gating substates (integrating|verifying|review)
       ∧ integrationOwner(P) is a single Attempt with role = integrator
       ∧ SHA(P) is an ancestor-descendant of every done task's completion revision
                                                                  -- merged result contains the work

P1(P)  ≝ |P.tasks| ≥ 1                                            -- all tasks done
       ∧ ∀ T ∈ P.tasks: T.status = done
       ∧ ∀ T ∈ P.tasks: gateReceipt(T) exists                     -- done was reached via task-done, not by write
         -- cancelled, failed, blocked, paused_cap ⇒ ⊥. A cancelled task must be removed
         -- from the phase (plan revision bump) before the phase can pass.

P2(P)  ≝ let CH = ⋃_{T ∈ P.tasks} T.checks ∪ P.integratedChecks in   -- integrated verification
         |CH| ≥ 1
       ∧ ∀ c ∈ CH: stateP(c, P) = pass
         -- stateP is §4 with fresh(e) ≝ e.revision = SHA(P) ∧ e.taskRevision matches the
         -- owning task's current revision (or null for phase-level checks) ∧ ¬superseded(e).
         -- Task-level evidence from the task's own worktree does NOT count here: it was
         -- captured at SHA(T) ≠ SHA(P).

P3(P)  ≝ PHASE_JEV_NO_GAP(P) ∨ PHASE_JEV_DISABLED_FALLBACK(P)       -- §6.1

P4(P)  ≝ let r = policy(max_{T ∈ P.tasks} T.riskClass, phaseChangeClass(P)) in
         (r.modelReview   ⇒ ∃ fresh independent review e ∈ E(P) at SHA(P))
       ∧ (r.humanApproval ⇒ ∃ a ∈ A: valid, a.scope = {phase, P.id}, a.planRevision = W.planRev,
                                      a.permittedAction = complete_phase, a.actor.kind = user)
       ∧ (∃ T ∈ P.tasks: T.riskClass = high ⇒ r.humanApproval)
       ∧ policyResultRecorded(P)
```

`P.integratedChecks` are the workflow-level checks registered on the phase (PLAN §3.F
"integrated checks after merges"); they live in `Phase.integrationPoint` config and are
part of `Workflow.planRevision`, so adding one after the fact bumps the plan revision and
invalidates phase approvals.

### 6.1 Phase condition 3 and the Jev-disabled fallback

Identical in shape to §5 with `questionId = phase_evidence_gap`, subject
`{phaseId: P.id, planRevision: W.planRev}`, `freshness.revision = SHA(P)`, and the hash
over `P.ac`, every task's gate receipt, `{(c.id, stateP(c,P))}` and fresh phase evidence.

```
PHASE_JEV_DISABLED_FALLBACK(P) ≝ ∃ d ∈ D (override reason ∈ {jev_disabled, jev_no_key, jev_unavailable},
                                          action = deterministic_fallback, fresh)
    ∧ PHASE_DET_COVERAGE(P)

PHASE_DET_COVERAGE(P) ≝ ∀ a ∈ P.ac:
      ∃ T ∈ P.tasks, a' ∈ T.ac: a'.coversPhaseCriterion = a.id ∧ TASK_GATE receipt for T   -- mapped down
    ∨ ∃ c ∈ P.integratedChecks: a.id ∈ c.coversCriteria ∧ stateP(c,P) = pass                 -- or integrated
```

The same truth table as §5.2 applies with the phase reason codes. When Jev is disabled,
**P1, P2 and P4 are unchanged.** `PHASE_JEV_NO_GAP` never substitutes for `P2`
(a failing integrated check with `no_gap` ⇒ `⊥`), and never for `P1` (a task that is not
`done` cannot be "assessed as effectively done").

## 7. Rejection, audit and non-bypassability

Every gate evaluation, pass or reject, writes exactly one `AuditEntry`:

```
AuditEntry{ table: "task" | "phase", recordId: T.id | P.id, operation: "update",
            beforeHash: H(record before), afterHash: H(record after — equal to beforeHash on reject),
            actor: "engine:gate:task" | "engine:gate:phase" }
```

and a gate receipt (on pass) or a rejection record (on reject) containing
`{gate, reasonCode, detail, revision, taskRevision|planRevision, evaluatedAt, inputHash}`.
Rejection reason codes (closed set; tests assert on them):

`not_in_review`, `no_checks`, `check_trivial`, `check_fail`, `check_flaky`,
`check_missing`, `check_unavailable`, `check_timeout`, `criterion_uncovered`,
`evidence_stale_revision`, `evidence_stale_task_revision`, `evidence_superseded`,
`command_identity_mismatch`, `jev_gap`, `jev_error`, `jev_decision_missing`,
`jev_unavailable`, `fallback_coverage_gap`, `review_missing`, `review_not_independent`,
`approval_missing`, `approval_invalid:<approvalInvalidReason>`, `approval_actor_not_user`,
`policy_result_missing`, `status_write_forbidden`, `tasks_not_done`, `no_gate_receipt`,
`integration_owner_invalid`, `merged_revision_changed`.

Structural guarantees the implementation MUST provide (each is a bypass test in §8):

1. **Single writer.** `Task.status → done` and `Phase.gateStatus → passed` are written only
   inside `task-done` / `phase-done` by the engine, in the same transaction as the gate
   receipt. The store rejects any patch to these fields that does not carry a gate receipt
   whose `inputHash` matches (`status_write_forbidden`). This applies to every path: worker
   tool calls, `korwf` commands, bash, direct SQLite access through the product, resume,
   fork, and migration.
2. **No waiver field.** No record has a field whose value can make C1/C3 or P1/P2/P4
   evaluate to `⊤` without the evidence they name. `CheckDefinition.required`,
   `Decision.override`, `Approval`, `W.mode` and `W.policyVersion` cannot do so.
3. **Freshness is derived, not stored.** Freshness is recomputed from `SHA` and
   `Task.revision` on every evaluation; there is no `evidence.valid` flag to flip.
4. **Decisions are engine-only.** `Decision` rows are append-only and written by
   `src/jev/`/`src/decisions/`; a worker cannot write one (records.md §4).
5. **Audit before return.** The audit entry is written before the evaluation result is
   returned, so a crash after rejection still leaves the entry.

## 8. Bypass scenarios (all ⇒ `rejected + audit entry`)

Every row is a Stage 4 test (`test/spec/gates.spec.md` B1–B14). The expected outcome of
**every** row is the same: the transition does not commit, the record is unchanged
(`afterHash = beforeHash`), an `AuditEntry` with `actor = engine:gate:*` is written, and
the rejection carries the listed reason code.

| # | Bypass attempt | Gate term that rejects | Reason code |
| --- | --- | --- | --- |
| B1 | Worker sets `Task.status = done` directly (tool call, bash, SQLite, resume) | §7 guarantee 1 — no gate receipt | `status_write_forbidden` |
| B2 | Jev returns fresh `no_gap` while one check is `fail` | C1 has no Jev term; C2 ⊤ does not imply C1 | `check_fail` |
| B3 | Evidence recorded at a previous SHA (`e.revision ≠ SHA(T)`) | fresh evidence (§2) ⇒ check `missing` | `evidence_stale_revision` |
| B4 | Evidence at the right SHA but `e.taskRevision ≠ T.rev` (check list edited after run) | fresh evidence (§2) | `evidence_stale_task_revision` |
| B5 | Check registered after the fact with command `true` / `exit 0` / `echo ok` | trivial check (§2), C1 `¬trivial(c)` | `check_trivial` |
| B6 | Registered command replaced at run time: evidence `commandIdentity ≠ c.command` | §4 `pass` requires identity match | `command_identity_mismatch` |
| B7 | Review approval from the same attempt (or its handoff chain) that wrote the code | independent review (§2), C3 | `review_not_independent` |
| B8 | Human approval for a high-risk task supplied by a `policy`/`engine` actor, or scoped to another task / an older plan revision | valid approval (§2), C3 | `approval_actor_not_user` / `approval_invalid:<reason>` |
| B9 | Check marked `required = false` and left `fail`/`missing` | §4 rules — `required` is reporting only | `check_fail` / `check_missing` |
| B10 | Jev disabled and no fallback row (“skipped”) | §5.2 — absence is not a state | `jev_decision_missing` |
| B11 | Jev disabled, fallback row present, but a criterion has no passing check/evidence | `DET_COVERAGE` ⊥ | `fallback_coverage_gap` |
| B12 | Check result `flaky` / `timeout` / `unavailable` presented as success | §4 — only `pass` satisfies C1 | `check_flaky` / `check_timeout` / `check_unavailable` |
| B13 | Phase: Jev `no_gap` on the phase while a task is not `done` or an integrated check fails | P1 / P2 have no Jev term | `tasks_not_done` / `check_fail` |
| B14 | Phase: task-level evidence at `SHA(T)` offered as integrated evidence at `SHA(P)`; or `SHA(P)` moved after evaluation | P2 freshness at `SHA(P)`; P0 | `evidence_stale_revision` / `merged_revision_changed` |

Additional invariants the same tests assert:

- A rejected evaluation MUST NOT leave partial state: no `Task.status` change, no
  `Phase.gateStatus` change, no gate receipt.
- Re-running the gate with unchanged input yields the same reason code (determinism §1).
- A `Decision` row authored by anything other than `src/jev/`/`src/decisions/` is
  rejected at write time (records.md §4) and therefore never reaches C2/P3.

## 9. Decisions and open points

- **D1** — Phase-level evidence uses `Evidence.taskId = null` + `requirementId` of a phase
  criterion. If records.md later adds `phaseId`, replace `E(P)` accordingly; the gate is
  unchanged.
- **D2** — `jev_unavailable` (enabled but unreachable) falls back to `DET_COVERAGE` only
  when config `jev.optional = true`; otherwise the task waits in `review`. Rationale: an
  operator who turned Jev on expects its judgement; silently degrading would be a hidden
  policy change. Configurable, never implicit.
- **D3** — Human checks (`kind = human`) count under C1 and need a `human` reviewer row;
  they do not double as the C3 approval, which is a separate `Approval` record.
- **D4** — The trivial-check deny-list is deliberately small and structural; issue #15
  (policy) may extend it. Extending it bumps `W.policyVersion`.
