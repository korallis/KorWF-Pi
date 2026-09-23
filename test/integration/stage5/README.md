# Stage 5 exit-criterion suite (issue #73)

> **Exit:** a task executes in isolation with a Jev-chosen model, survives a simulated cap
> with a visible fallback, and reports accurate state. — PLAN.md §8, Stage 5

Nothing here is mocked that can be real: git is a real repository (`test/helpers/git-repo.ts`),
the store is real SQLite (`src/storage/db.ts`), checks run real `node` commands, and
`e2e.test.ts` spawns a real subprocess (the `fake-pi.mjs` stand-in for `pi --mode rpc`
already used by `test/workers/*.test.ts` and `test/integration/workers/*.test.ts`). Only
the Jev transport (`MockJevTransport`) and the provider's 429 are faked — there is no key
and no network in this suite, per AGENTS.md. Every "time passes" is a `FakeClock` advance,
never a real sleep.

## Files

| File | Covers |
| --- | --- |
| `fixture.ts` | The scenario-4 fixture: a real repo, a real store, a two-task phase (`T1` depends nothing, `T2` depends on `T1`), and three fixture models (`M-primary`, `M-sub`, `M-weak`) on one fixture provider. |
| `gate.ts` | Drives the real task gate (`runCheck`, `evaluateMappingOnly`, `recordGateDecision`, `completeTask`) so a task fixture actually reaches `done` — no shortcut. |
| `scenario4.test.ts` | `test/scenarios/04-cap-mid-task.md` Variant A, steps A1–A6, in one continuous run: Jev-chosen primary dispatch, a simulated quota-exhausted cap mid-task, Jev-ranked substitute selection (excluding the capped primary before the question is asked), handoff packet + intact worktree, `/korwf status` showing the visible switch, completion on the substitute through the real gate, and the primary retried at the next task boundary once its estimated reset has passed. |
| `e2e.test.ts` | The isolation half of the exit criterion on its own: a real worker subprocess, in its own git worktree, running the model `selectModel` actually chose via Jev, supervised by the real `WorkerRun`, with its reported outcome/usage/route checked against what the run actually did. |

## Scenario 4 coverage map

| Outline step (`test/scenarios/04-cap-mid-task.md`) | Assertion | Test |
| --- | --- | --- |
| A1 | Jev-chosen primary dispatch, isolated worktree, no fallback | `scenario4.test.ts` "A1: T1 dispatched..." |
| A2 | Cap detected, route-keyed (not workflow-keyed), no leaked secret in `lastProbe.detail`, task stays `running` not `failed`, worktree intact | same test, Step A2 block |
| A3 | Capped primary excluded before the question; substitute ranked adequate | same test, Step A3 block |
| A4 | Handoff packet, intact worktree/branch, visible switch in `/korwf status` | same test, Step A4 block |
| A5 | Completion on the substitute through the real gate | same test, Step A5 block |
| A6 | Primary retried at the next task boundary once past its estimated reset | same test, Step A6 block |

Variant B (Jev disabled, static fallback order) and Variant A7 (all-candidates-capped
pause/auto-resume) are exercised unit-by-unit already, in `test/models/cap-pause.test.ts`
and `test/models/fallback-policies.test.ts` — this suite's job is the end-to-end run, not
duplicating that coverage.
