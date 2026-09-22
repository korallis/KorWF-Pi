# The plan document

The planner role (a coding model, never Jev) emits a **plan document**: an architecture
summary, ordered phases, and tasks with acceptance criteria, ownership, dependencies,
risk class, and **verification checks**. This file documents that contract. The
authority is `src/workflow/plan-schema.ts`; the prompt text is generated from the same
constants, so the two cannot describe different shapes.

Issue #37 · PLAN §2.1, §2.2, §2.3, §3.C.

## 1. The rule this exists for

> For every task the planner must emit executable checks (test commands, assertions,
> lint/type checks, or an explicitly required human check). … A task with no checks is
> not `ready`. This is what gives the deterministic gate something to gate on.
> — PLAN §2.3

That rule is enforced **in code**, not in the prompt:

| Where | What it does |
|---|---|
| `taskReadiness(task)` | Returns `canBecomeReady: false` and `blocker: "no_checks"` for a task with `checks: []`. It takes only the task — there is no policy, flag or override parameter that can change the answer. |
| `validatePlanDocument` | Emits a `no_checks` **warning** (not an error) so the rest of the planner's work is not discarded. |
| `initialStatusFor` / `plan-store.ts` | Derives the persisted status and blocker from `taskReadiness`, so no caller can write a checkless task any other way. |
| `PRECONDITIONS.checks_registered` (#13) | The state machine's `ready` guard requires `Task.checks.length >= 1` on every entry edge. |

A checkless task is therefore stored, visible on the board, and permanently unrunnable
until checks are added — which is the point: it is a *known gap*, not a silent pass.
