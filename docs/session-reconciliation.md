# Session reconciliation (issue #42)

PLAN §5:

> Pi conversation branching does not undo Git changes or external effects.
> Fork/resume reconciles live repository state and never resurrects obsolete
> approvals or replays completed actions.

Pi sessions can be started, reloaded, replaced (`/new`, `/resume`), forked
(`/fork`, `/clone`) and navigated as a tree (`/tree`). All of those rewind or
re-point the **conversation**. None of them rewinds the repository, the SQLite
store, or anything the workflow already did to the outside world. This document
describes the seam that keeps those two facts from being confused.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/git/revision.ts` | Reads live `HEAD`, branch and working-tree state; relates a recorded revision to `HEAD` by ancestry. The only place that runs these git commands (ADR 0002). |
| `src/workflow/reconcile.ts` | Compares the persisted workflow to that live state, decides whether the `session_reconciled` invalidation applies, and guards completed actions against replay. |
| `src/storage/action-log.ts` | Append-only receipts for completed actions and for every refused replay (migration `0006-actions.sql`). |
| `src/extension/session-hooks.ts` | Registers `session_start` and `session_tree`, opens the store, surfaces the result. Decides nothing itself. |

## 1. Compare against the repository as it is now

`computeDrift(workflow, cwd)` reads git at reconcile time. It never consults a
cached field written when the session was saved — that cached value is exactly
what may have gone stale. The result is a `RevisionRelation`:

| Relation | Meaning |
| --- | --- |
| `same` | `HEAD` is the revision the plan was made against. |
| `advanced` | The recorded revision is an ancestor of `HEAD`: work landed on top. |
| `rewound` | `HEAD` is an ancestor of the recorded revision: the branch was reset backwards. |
| `diverged` | Neither is an ancestor of the other. |
| `unknown_revision` | The recorded revision is not in this repository at all. |
| `indeterminate` | Git could not answer. **Never** treated as `same`. |

A dirty working tree is reported separately, because "the tree has uncommitted
changes this session did not make" is a distinct hazard from "`HEAD` moved".

## 2. An invalidated approval stays invalidated

Two independent mechanisms, both required:

1. `Approval.invalidation` is on disk and the repository only ever lets it move
   `null → reason` (docs/records.md §4). The store is not part of the
   conversation, so forking back to a point *before* a revision bump still
   reads the invalidated row. `reconcileSession` reports those as
   `alreadyInvalidApprovals` and never rewrites them.
2. Approvals not yet marked are re-derived from the **current** plan and task
   revisions with the shared `approvalInvalidReason` helper, so an approval
   pinned to a superseded revision is found stale at reconcile time even if no
   one marked it when the revision moved.

When anything is stale, the enumerated `session_reconciled` event from
`transitions.ts` is applied through `applyInvalidation` — task `blocked`, phase
`paused`, stale evidence excluded from current gates but retained on disk — in
one transaction, audited like any other transition.

### When does reconciliation invalidate?

`shouldInvalidate(event, drift, hasStaleApproval)`:

- Any relation other than `same` → yes, for every event.
- No repository, or an indeterminate answer → yes.
- An approval already found stale → yes.
- A rewinding event (`reload`, `resume`, `fork`, `tree`) with a dirty tree → yes.
- `startup` / `new` at the exact recorded revision with a clean tree → no.

The last line is deliberate: invalidating every approval on every launch would
be a denial of service on the user's own authorisations, and nothing has
changed about what was approved.

## 3. A completed action is never replayed

Every effect that must happen at most once carries an `actionId` derived from
*what the effect is* — `actionIdFor({workflowId, kind, subjectId, discriminator})`
— not from when it was requested. A random id or a timestamp would defeat the
mechanism, because the replayed turn would mint a fresh one.

```text
guardAction(...)  →  { kind: "proceed" }            no receipt exists
                  →  { kind: "refused", notice }    a receipt exists
```

A refusal is recorded in `action_replay_attempt` so a no-op turn is never
silent, and the notice says what completed, in which session, at which revision.
`recordCompletedAction` throws rather than overwriting an existing receipt:
reaching it twice means the guard was skipped, and hiding that would hide a
double effect. Receipts can be neither updated nor deleted (SQL triggers), so
there is no path that "unlocks" a replay.

Actions whose effect left this repository (`externalEffect: true` — push,
publish, deploy) are refused with a distinct code and are listed by every
reconciliation, because rewinding the conversation cannot undo them.

## Surfacing

`statusLine(report)` is the one-line status; `describeReconciliation(report)`
adds one line per finding plus what the invalidation did. The session hook
stays **silent** when the repository matches the plan — a notice on every
session start trains the user to ignore it — and emits a single redacted
warning otherwise.

## Failure behaviour

- No `.korwf` store in the project → nothing to reconcile, no output.
- Store unopenable (invalid config, write lock held) → `degraded: true`, no
  claim that anything was checked, no approval treated as current on that basis.
- Read-only handle → the report is computed and shown, nothing is written
  (`dryRun`).
- Any thrown error inside the Pi handler → redacted notice via `guardHandler`;
  a reconciliation failure never takes the session down.
