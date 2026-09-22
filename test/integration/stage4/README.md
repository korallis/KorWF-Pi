# Stage 4 exit-criterion suite (issue #55)

> **Exit:** unsupported completion is rejected; failures produce bounded recovery or a
> clear stop. — PLAN.md §8, Stage 4

Everything under test here is already on `main`. This suite's job is not to re-test it
unit by unit; it is to **attack** it. Each test tries to get a task to `done` without
having earned it, or tries to turn a failure into an unbounded loop, and asserts that the
attempt is refused with a machine-readable reason.

## How it is wired

Nothing is mocked that can be real:

| Layer | What the suite uses |
| --- | --- |
| Git | a real repository in a temp dir (`test/helpers/git-repo.ts`); `Evidence.revision` is a real `git rev-parse HEAD` |
| Checks | `runCheck` / `runCheckWithRerunPolicy` executing real `node` commands (#45, #51) |
| Store | a real SQLite store under the same temp dir (#23) |
| Gate | `completeTask` / `runTaskGate` (#46) — there is no test-only route to `done` |
| C2 | `evaluateEvidenceGap` / `evaluateMappingOnly` + `recordGateDecision` (#47) |
| Jev | `MockJevTransport` and the disabled path only. **No key, no network, no model call.** |

`fixture.ts` deliberately exposes no shortcut: no `forceDone`, no synthetic "all checks
passed", and no way to hand the gate a revision that did not come from the repository.

## Scenario 3 coverage map

`test/scenarios/03-wrong-test.md` is the Stage 1 outline this suite executes. Every
assertion in the parts of it that belong to Stage 4:

| Outline step | Assertion | Test |
| --- | --- | --- |
| A1 | claim is an `Attempt` artefact, never a truth value on `Task` | `false-claim` "the claim's text is never read…" |
| A1 | `Evidence.revision == SHA1`, `reviewer.kind == deterministic`, provenance names the test file | `false-claim` "checks that really ran…" |
| A1 | C1 holds (both checks `pass`) so the refusal is C2's | `unrelated-test` "the evaluator returns action=gap…" |
| A2 | `Decision.action == 'gap'`, `rawDistribution` preserved, criterion named | `unrelated-test` "the evaluator returns action=gap naming ac1…" |
| A2 | gap `Decision` refuses C2 at the gate (`jev_gap`) | `unrelated-test` "the gap Decision refuses C2 at the gate…" |
| A2 | `verifying|review → needs_changes`, `blocker == null`, `revision` unchanged | `unrelated-test` "the task moves review → needs_changes…" |
| A2 | nothing set `done`; no gate receipt exists | same test (`gateReceipts.latestForSubject` is `undefined`) |
| A3 | classification recorded, bounded by `recovery.maxAttemptsPerTask` | `recovery-paths` "the same check fails every time…" |
| A3 | no `needs_changes → running` shortcut (a `ready` state in between) | asserted by the edge table; `recovery-paths` "a hard stop leaves the task where it was" |
| A4 | the honest patch completes: real passing checks + recorded C2 ⇒ `done` | `false-claim` "checks that really ran, a recorded C2 decision…" |
| B1 | `DET_COVERAGE` is satisfied by the wrong patch — **the documented limitation** | `unrelated-test` "B1 the structural fallback is satisfied…" |
| B1 | the fallback is never presented as Jev's judgement (`jevModelVersion` null, `usage.requests` 0, `override.reason`) | same test |
| B2 | with `modelReview: true` the gate refuses `review_missing` while C1 and C2 hold | `unrelated-test` "B2 with a review policy in force…" |
| B4 | the product must not pretend the semantic check happened: no `no_gap` Decision exists for the task | `unrelated-test` B1 (`forged` is empty) |

The Jev-enabled medium-risk clause (`no_exercising_test`) is covered by
`unrelated-test` "a medium-risk task is a gap on the test-exercises answer alone".

## Scope items → files

| Scope item (issue #55) | File |
| --- | --- |
| False claim: worker summary says done, no evidence → rejected | `false-claim.test.ts` |
| Unrelated passing test (Scenario 3) → needs_changes with criterion named | `unrelated-test.test.ts` |
| A check that flakes at the same revision; evidence from an older revision; missing evidence | `flaky-and-stale.test.ts` |
| An approval reused, or pinned to a superseded revision | `approval-reuse.test.ts` |
| Persistent failure → bounded stop; budget exhausted mid-recovery → resumable hard stop; cancellation during recovery → no orphans, task `cancelled`, worktree intact | `recovery-paths.test.ts` |

## Attacks that succeeded, and what was fixed

Two attacks got through. Both are fixed in this PR, with a unit test in the owning
module's own suite so a regression fails there, not only here.

1. **A flake read back as a pass** (`src/verification/flaky.ts`).
   `runCheckWithRerunPolicy` reconciled two disagreeing runs at one revision to `flaky`,
   but the evidence drafts it returned were only the individual runs. The caller stored
   them honestly and the gate — which takes the *latest* fresh row for a check
   (docs/gates.md §2) — read the passing rerun and called the check `pass`. A check that
   fails then passes at the same commit therefore satisfied C1.
   **Fix:** the reconciled `{kind:"flaky"}` row is now appended **last** among the
   drafts, with a caveat naming the disagreement. Regression test:
   `test/unit/verification/check-states.test.ts` "the reconciled flaky row is the LAST
   draft…".

2. **An approval could be re-pinned or deleted with raw SQL**
   (`src/storage/migrations/0011-approval-immutability.sql`).
   `ApprovalRepository` refuses every patch but `invalidation`, and
   `approvalInvalidReason` refuses an approval pinned to a superseded revision — both in
   this process. The `approval` table itself had no triggers, so
   `UPDATE approval SET payload = …` re-pinned a granted approval to the task's new
   revision, swapped its actor, or widened its `permittedAction`, and
   `DELETE FROM approval` erased the record that permission was ever given. The sibling
   `approval_request` table (migration 0009) had exactly these triggers already.
   **Fix:** migration 0011 adds them — scope/revision/risk immutable, payload immutable
   field by field, invalidation final, no delete. Regression test:
   `test/unit/storage/approval-immutability.test.ts`.

## Running it

```
npm test -- stage4
```

Each file cleans up its own temp repository and store in `afterEach`, and asserts only
about its own fixture's paths — never about the contents of a shared directory, which
would flake under vitest's parallel file execution.
