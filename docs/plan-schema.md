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

## 2. Document shape

```jsonc
{
  "schemaVersion": 1,
  "architectureSummary": "prose",
  "openQuestions": ["anything the planner could not settle"],
  "phases": [
    {
      "id": "p1",                 // planner-local, unique in the document
      "order": 0,                 // dense 0..n-1 across the document
      "goal": "...",
      "acceptanceCriteria": [{ "id": "pac1", "text": "..." }],
      "integrationBranch": "..."  // optional; defaults to korwf/phase-<order>
    }
  ],
  "tasks": [
    {
      "id": "t1",
      "phaseId": "p1",
      "goal": "...",
      "acceptanceCriteria": [{ "id": "ac1", "text": "..." }],
      "checks": [
        {
          "id": "c1",
          "kind": "command | assertion | lint | typecheck | human",
          "command": "npm test -- example",   // for kind=human, the instruction
          "cwd": ".",                         // repository-relative
          "expectedExitCode": 0,
          "coversCriteria": ["ac1"],           // ids on *this* task
          "required": true,
          "rationale": "optional"
        }
      ],
      "ownership": { "paths": ["src/example.ts"], "components": ["example"] },
      "dependencies": [],                      // planner-local task ids
      "riskClass": "low | medium | high",
      "expectedArtifacts": [
        { "path": "src/example.ts", "estimate": { "unit": "lines", "value": 120 } }
      ]
    }
  ]
}
```

Ids in the document are **planner-local**. `plan-store.ts` maps them to opaque record
ids; the planner never sees or supplies a record id.

## 3. Validation rules

Every finding carries a dotted/indexed `path` (`tasks[2].checks[0].command`), a stable
`rule` id, and a severity. **Errors** reject the document; **warnings** do not.

| Rule | Severity | What it catches |
|---|---|---|
| `type`, `required`, `enum`, `range` | error | Structural shape: wrong type, missing field, unknown enum member, empty string, negative order, unsupported `schemaVersion`. |
| `duplicate_id` | error | Two phases, tasks, criteria or checks with the same id. |
| `unknown_reference` | error | A task naming a phase that is not in the document; `coversCriteria` naming a criterion that is not on the same task; a dependency on a task that is not in the document. |
| `self_dependency` | error | A task listing its own id in `dependencies`. |
| `dependency_cycle` | error | A cycle in the task graph, or a dependency pointing into a **later** phase (which can never become ready, since phases run in order). |
| `phase_order` | error | `order` values that are not a dense `0..n-1` sequence. |
| `check_shape` | error | An executable check (`command`/`lint`/`typecheck`) whose `command` is prose rather than a command line. |
| `path_shape` | error | An absolute path or `..` traversal in `ownership.paths`, `cwd` or an artifact path. |
| `no_checks` | **warning** | A task with `checks: []`. Persisted `proposed` + blocker `no_checks`. |
| `criterion_coverage` | warning | An acceptance criterion no check covers. |
| `ownership_conflict` | warning | Two tasks in one phase owning the same path; they cannot run in parallel. |

Validation collects **every** finding rather than stopping at the first, so one retry
can fix everything at once.

### Why `check_shape` is an error

The most common way a model satisfies PLAN §2.3 in appearance only is to emit
`{"kind": "command", "command": "run the tests and confirm they pass"}`. The
deterministic gate cannot run that, so it would pass the plan and then block forever at
execution. The check is rejected at planning time instead.

## 4. Generation, parsing and retry

`generatePlan` (`src/workflow/planner.ts`) runs prompt → parse → retry, bounded by
`maxAttempts` (default 3):

1. `buildPlannerPrompt` embeds the intake, every retrieved excerpt **with its full
   provenance** (revision, path, range, retrieval method, content hash — PLAN §3.B),
   the schema, and the rules above.
2. The caller's `PlannerModel` returns either a parsed object (the structured-output
   tool-call path from the reuse table, `docs/pi-integration-map.md` row 13) or text.
   `parsePlanOutput` accepts both: bare JSON, a fenced ```json block, or a balanced
   `{...}` span inside prose. Brace scanning is string-aware, so a brace inside a check
   command does not truncate the document.
3. On rejection, `buildRetryPrompt` quotes the **actual** path-qualified findings, so
   attempt N+1 is not a blind re-roll. A failed run returns errors and no plan: there is
   no code path that returns a partially valid document.

With **no model at all**, `deterministicPlanSkeleton` returns a valid single-phase plan
whose one task carries an explicitly required `human` check and states plainly that
nothing was analysed. Every Jev- or model-assisted decision in this project has a
deterministic fallback (AGENTS.md §4); this is planning's.

## 5. Output-budget sizing (#124)

Generated tasks are sized against the *worker* model's per-turn **output** ceiling
(`maxTokens`), not its context window, using `sizePlan`/`sizeTaskOutput` from
`src/workflow/output-budget.ts`. `sizePlanTasks(plan, limits, thinking)` returns a
verdict per task; `tasksNeedingDecomposition` lists the ones whose declared artifacts
cannot be produced in one turn as planned, together with concrete write-then-edit step
plans. An unreported `maxTokens` is treated as the conservative floor — unreported is
not unlimited. See [output-budget.md](output-budget.md).

Pass that list to `persistPlan` as `outputBudgetBlocked` and those tasks are persisted
`proposed` with the blocker `output_budget`: a worker dispatched on one would be cut off
before its tool call was emitted and would write nothing, so it must be split first.
`no_checks` takes precedence — a task with neither checks nor a feasible size needs
checks before anything else.

## 6. Persistence and revisions

`plan-store.ts` writes the document into `Phase` and `Task` records
([records.md](records.md)) inside **one** `store.write()` transaction: a rejected row
rolls the whole plan back, so nothing partial ever lands.

- `persistPlan` — first plan. Sets `Workflow.planRevision` to 1 and moves the workflow
  from `planning` to `ready`. Refuses if a plan already exists.
- `revisePlan` — revision N+1. Refuses if there is no plan.
- `persistOrRevisePlan` — picks the right one.

Across revisions:

| Situation | Effect |
|---|---|
| Task recognised as the same work | Keeps its record id (docs/records.md §5.1). Matched by exact goal, else by an *unambiguous* ownership-path overlap; an ambiguous match is treated as new work rather than inventing continuity. |
| Its `goal`/`acceptanceCriteria`/`checks` changed | `Task.revision` bumps by exactly one; the store enforces this. Listed in `revisedTasks`. |
| Only `ownership`/`dependencies`/`riskClass` changed | No revision bump (docs/records.md §5.1). |
| Task dropped from the new revision | `status: cancelled`, `blocker: superseded`. Never deleted — its attempts, evidence and audit trail stay readable for `/korwf why` and replay. |
| Any approval on a changed or dropped task | Invalidated `task_revision_changed`. |
| Any other still-valid approval in the workflow | Invalidated `plan_revision_changed` (it was pinned to the old `planRevision`). |

Invalidations are written in the same transaction as the change that caused them, only
ever `null → reason`, and are never cleared (docs/records.md §6). A first plan
invalidates nothing: there was no approved plan to invalidate.

## 7. Related

- [records.md](records.md) — `Phase`, `Task`, `CheckDefinition`, revision rules.
- [state-machine.md](state-machine.md) — the `ready` guard `checks_registered`.
- [output-budget.md](output-budget.md) — why tasks are sized against `maxTokens`.
- [gates.md](gates.md) — what the deterministic gate does with these checks.
