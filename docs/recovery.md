# Bounded recovery and side-effect reconciliation

Status: **implemented** (issue #53, Stage 4). Authority: `PLAN.md` §3.G.
Code: [`src/workflow/recovery.ts`](../src/workflow/recovery.ts),
[`src/storage/recovery-log.ts`](../src/storage/recovery-log.ts).
Config: [`config-reference.md` §10a](config-reference.md#10a-recovery).

> **PLAN §3.G** — Bounded responses: gather evidence, retry, fallback model (D), replan,
> change worker/profile, request review, ask user, stop. No blind retry of side effects;
> reconcile uncertain outcomes first.

## 1. What this module is, and is not

It answers one question: **given a failure that has already been classified, what does the
workflow do next, and how many more times may it do anything at all?**

It does *not* classify failures. [`docs/failure-taxonomy.md`](failure-taxonomy.md) and
`src/workflow/failure.ts` (#52) are the taxonomy; a `FailureClassification` is an *input*
here. There is exactly one taxonomy in this repository.

It does not own transport retry either: `src/jev/resilience.ts` (#26) has the retry bounds
and the circuit breaker for service calls. A `service` failure that reaches recovery has
already exhausted those, which is why the `service` ladder does not retry the same route.

Choosing a fallback model (PLAN §3.D, Stage 5) and producing a new plan (Stage 3) are
returned as *decisions* for the caller's hooks to execute; recovery invokes them through
interfaces rather than implementing them.

## 2. Why every policy is bounded

The failure mode this issue exists to prevent has already happened in this project: six
attempts on one issue burnt roughly 400k tokens and produced zero files. An unbounded retry
loop looks like progress from the inside — each attempt has a fresh rationale — and is only
visible from outside, in a log, as the same rung being climbed repeatedly.

So there are three independent bounds, and a decision has to pass all of them:

| Bound | Where | What it stops |
|---|---|---|
| Attempt ceiling | `recovery.maxAttemptsPerTask` / `maxAttemptsPerPhase` | Any further automatic attempt at all. Checked **first**, before the ladder, so no branch can route around it. |
| Per-response cap | `maxEvidenceGatherings`, `maxReplans`, `maxModelFallbacks`, `maxWorkerChanges` | One rung being chosen over and over. Gathering evidence forever is a stall, not a recovery. |
| Ladder length | `RECOVERY_LADDERS` | Running off the end of a category's escalation, which yields `recovery.finalResponse`. |

`projectRecovery()` renders the whole remaining ladder for a subject; a test asserts that for
every failure category the projection terminates within the attempt ceiling and ends on a
terminal response. A policy that could run forever would show up as a projection that never
terminates.

## 3. The ladders

`RECOVERY_LADDERS[category][attempt - 1]` is the response, with rungs skipped when their own
cap is spent. No ladder contains `ask_user` or `stop`: terminality comes from the bound, not
from a rung.

| Failure category (#52) | Ladder | Why |
|---|---|---|
| `implementation` | retry → fallback_model → request_review | The code is wrong and the failure is visible to the worker; one plain retry is worth it, then a different model, then human eyes. |
| `environment` | gather_evidence | Retrying an `ENOENT` changes nothing. Establish which command and which path, then ask — the user owns the machine. |
| `missing_information` | *(empty)* | Nobody supplied the information; no number of retries invents it. Asks immediately. |
| `dependency` | retry → replan | A prerequisite may have completed since; then make the dependency an explicit task. |
| `test_expectation` | replan → request_review | The test asserts the wrong thing. Re-running a wrong assertion reproduces it exactly. **Never a plain retry.** |
| `service` | fallback_model | #26 already retried and tripped the breaker. Change route, then stop. |
| `quota` | fallback_model | A cap is time-based; the pause/resume policy is `fallback.allCappedBehaviour`. |
| `harness` | retry → change_worker | The turn never happened (#124), so retrying the *harness* is legitimate; then a profile that fits. |
| `unknown` | gather_evidence | An `unknown` is not a diagnosis. It carries concrete evidence requests; run those. |

A classification with `needsEvidence: true` takes the evidence path regardless of category —
that flag is #52 saying the classification is not actionable on its own.

Stall events from #52 (`repeated_failure`, `repeated_approach`, `no_progress`) advance the
ladder by **one** rung: a stall says the current rung is not working, not that every
remaining rung is hopeless. `scope_drift` does not advance it — it is a signal about *where*
the worker is writing, not about the approach.

## 4. No blind retry of side effects

A step declares whether it has side effects. The flag is never inferred: guessing whether
`npm run deploy` writes is exactly the judgement that must not be made on a hunch.

Before any decision is taken for a flagged step, `reconcileStep()` establishes what happened,
in this order:

1. **No side effect** → `none`; nothing to reconcile.
2. **A completed-action receipt** for the step's `actionId` (`src/storage/action-log.ts`,
   #42) → `already_applied`. A receipt is a *fact*: the action completed, in this session or
   in the one this conversation was forked from. No probe overrules it. This issue does not
   re-derive "refuse a replay"; it reads the log that already refuses one.
3. **The declared reconciliation probe**, a read-only observation named with the step. A
   probe that throws yields `unknown` — a failed observation is not evidence of absence.
4. **Neither** → `unknown`. There is no fallback that assumes the effect did not land.

Only `not_applied` (and `none`) permits a retry. `already_applied` means the work is done, so
retrying *is* the double effect; `partially_applied` and `unknown` mean nobody can say, and
"nobody can say" is never permission. Anything else yields
`recovery.unreconcilableSideEffect`, which the schema pins to a terminal value — there is no
configuration in which an unreconciled side effect can be retried, because a switch there
would be a supported way to cause a double effect.

If a caller ignores the decision and performs the action anyway, `guardAction` (#42) still
refuses it and records the refusal. The two mechanisms are layered, not alternatives.

## 5. Audit

Every decision — including the ones that refused to retry and the ones that stopped — appends
a row to `recovery_decision` (`0007-recovery.sql`), naming:

- the policy rule that produced it (`bound:max-attempts`, `side-effect:unknown`,
  `evidence:needs-evidence`, `ladder:<category>:<n>`, `ladder:<category>:exhausted`);
- the failure category and the #52 rule id it came from;
- `attemptsUsed` / `maxAttempts` at that moment;
- the side-effect status and the `actionId` it was established from, when there was one.

The table is append-only by SQL trigger: deleting a rung would unbound the ladder.

`usageFromLog()` reads per-response usage back out of it, which is what makes the caps
survive a resumed or forked session — a crashed session cannot forget that it already
retried.

## 6. No Jev required

Nothing here consults Jev. `chooseRecovery()` is pure: same inputs, same decision, no clock,
no store, no network. Jev may improve the *classification* upstream (#52), and that path has
its own deterministic fallback (`unknown`, which this module handles explicitly).
