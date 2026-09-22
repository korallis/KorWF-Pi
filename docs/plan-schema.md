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
