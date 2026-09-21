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
