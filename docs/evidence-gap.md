# Evidence-gap evaluators — condition 2 of the task gate

**Issue #47.** Design authority: `PLAN.md` §2.4 (2), §3.F, §6.
Code: `src/decisions/questions/verify.ts`, `src/verification/evaluate.ts`.
Config: [`docs/config-reference.md` §10b](config-reference.md#10b-verification).
The gate that consumes this: [`docs/gates.md`](gates.md) §5, `src/verification/task-gate.ts` (#46).

> **PLAN §2.4 (2)** Jev finds no evidence gap — completion claim is supported by the
> presented evidence; every acceptance criterion maps to a check or evidence item; tests
> exercise the requirement rather than something unrelated.

## 1. Three bounded questions, never one

`.pi/skills/jev-orchestration/SKILL.md` §2 records the lesson this module is shaped by:
a single existential *"does this evidence support completion?"* **deflates as the scope
is itemised**, independent of real completeness. The same task scored high with two
criteria and low with eight, for reasons that had nothing to do with the work.

So there is no whole-task question anywhere. Each question is asked about exactly one
acceptance criterion, or one `(test, criterion)` pair, and the conjunction is taken in
code by `evaluateEvidenceGap`.

| Question | Type | Asked per | Answers |
|---|---|---|---|
| `verify.claim_supported@1` | choice | criterion | `supported` / `unsupported` / `unknown` |
| `verify.evidence_gap@1` | noul | criterion | probability there is a gap |
| `verify.test_exercises@1` | score | (test, criterion) | level 0–3 |

Adding a criterion therefore cannot change another criterion's answer. The list of
criteria without supporting evidence — what the issue's scope asks for — is assembled in
code as `EvidenceGapEvaluation.gapCriterionIds`.

## 2. `verify.test_exercises@1` is the semantic counterpart of `isVerifyingCheck`

#44's `isVerifyingCheck` rejects a command that **cannot fail**: `true`, `exit 0`,
`echo ok`, `cd x && true`. That is a structural fact about a command line.

It cannot see a test that runs real code, asserts real things, passes honestly, and says
nothing whatsoever about the criterion it is linked to. That is
`test/scenarios/03-wrong-test.md`: the criterion is "empty `items` ⇒ 400", the added test
asserts that a *valid* order returns 201, and every check is green.

`verify.test_exercises@1` asks the counterfactual directly — *if the criterion were not
implemented at all, would this test fail?* — and level 0 is exactly "no". The level floor
per risk class is applied in code (`EvaluatorThresholds.testExercisesMinLevel`); Jev
supplies the level, never the verdict.

## 3. Abstention is a gap. Always.

Every one of these lands on a gap naming the criterion, and none of them can produce a
pass:

| Situation | Recorded as | Reason code |
|---|---|---|
| `unknown` claim verdict | Jev answer | `claim_unknown` |
| `unsupported` claim verdict | Jev answer | `claim_unsupported` |
| noul inside the abstain band `[0.35, 0.65]` | fallback, distribution preserved | `jev_abstained` |
| `no gap` that misses the risk class's `gapCeiling` | abstention | `jev_abstained` |
| `supported` below the risk class's `claimConfidence` | abstention | `jev_abstained` |
| transport error, cancellation, malformed answer | fallback | mapping-rule reasons |
| no acceptance criteria at all | — | `verify.evidence_gap:no_criteria` |

The last row matters: a conjunction over zero parts is **false** here, as it is for
`allTrue` (docs/questions.md §4). "Nothing to check" is not "nothing wrong".

## 4. With no Jev key: the mapping rule

The deterministic fallback is meaningful, not a shrug. Every acceptance criterion must
have:

1. at least one **linked** check (`CheckDefinition.coversCriteria`) whose state is
   `pass` — `flaky`, `missing`, `unavailable`, `timeout` and `fail` are all explicit
   non-successes (#51) and none of them satisfies it; and
2. at least one **passing evidence item** attributed to it (`Evidence.requirementId`).

A check definition is a promise; an evidence row is an observation. Both are required.

The semantic dimensions then report `not_evaluated` with a reason (`jev_disabled`), never
a synthesised verdict — `EvidenceGapEvaluation.degraded` is `true` and the phase report
discloses it.

**The documented limitation.** The mapping rule cannot see that a passing test observes
the wrong thing; scenario 3 variant B says so explicitly. What covers it is the
independent model review (#48) required by policy for change class `test_change`, whose
verdict is `Evidence`, not a `Decision`. Without such a policy the product records a
false negative *and discloses it* — it never pretends the semantic check happened.

## 5. What this module cannot do

- **It cannot waive a deterministic check.** The gate computes conditions 1 and 3 from
  `Evidence`, `Approval` and `CheckDefinition` rows and reads no `Decision` at all. The
  only artefact this module produces is a `Decision`. A `no_gap` evaluation over a
  failing check still yields `check_fail`.
- **It cannot be steered by the worker's claim.** The claim is present in exactly one
  question state, as the text under judgement. The gate's own C0 treats a completion
  claim as the *existence* of an attempt, never as a truth value.
- **It cannot be loosened by config.** `thresholdsFor` takes the stricter of the shipped
  default and the override on every field.
- **It cannot recycle a stale answer.** All three questions are `revisionSensitive`, and
  the gate-facing `Decision` carries the gate's own `gateStateHash`, which covers the
  check states and the fresh evidence hashes. Fix a check and the hash changes, so a
  "no gap" cannot be carried across a fix.

## 6. Recording

`evaluateEvidenceGap` writes one `Decision` per question via `ask()` — on every path,
including disabled mode, with the raw distribution exactly as returned (docs/questions.md
§5). `buildGateDecision` / `recordGateDecision` then write the single `task_evidence_gap`
row that the task gate's condition 2 reads, in one of two branches:

- **`action: "no_gap"` / `"gap"`**, `override: null` — Jev answered.
- **`action: "deterministic_fallback"`**, `override: {actor: "policy", reason}` — Jev did
  not. The gate then requires `DET_COVERAGE` on top.

Absence of a row is neither branch: the gate refuses with `jev_decision_missing`.
Skipping is not a state.
