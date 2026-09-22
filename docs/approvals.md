# Human approval (issue #49)

How KorWF-Pi asks a person for permission, records the answer, and stops using
it again. The class vocabulary and the class × mode disposition table are
[`docs/approval-classes.md`](approval-classes.md) (#15); the gate that consumes
an approval is [`docs/gates.md`](gates.md) §2–§3 (#46). This document is only
the lifecycle in between.

Design authority: **PLAN §2.4 (3)**, **§2.6**, **§5 Approval**, **§7 Execution
policy**.

## 1. The one sentence that shapes everything

> An approval is a **record**. It is never inferred from text, from a Jev score,
> or from a worker's claim.

Three code consequences:

- `Approval` rows are written in exactly one place, `grantApproval` in
  `src/workflow/approvals.ts`, whose input is a persisted request row plus the
  identity of the actor. There is no parameter through which a sentence, a
  probability or an assertion could arrive.
- The task gate reads `store.approvals`. It never reads
  `store.approvalRequests`, so no amount of queued, escalated or notified
  request state moves a gate.
- `src/verification/checks.ts` cannot produce `Evidence` for a `human` check;
  it produces a `PendingApprovalRequest`. A human check is satisfied only once
  a real actor has granted an approval.

## 2. The two tables, and why they are two

| Table | What it is | Who writes it | Authorises anything? |
| --- | --- | --- | --- |
| `approval_request` (`0009-approval-requests.sql`) | A **question** nobody has answered yet | the engine, when it classifies an act | **No** |
| `approval` (`0001-initial.sql`) | An **authorisation** a real actor granted | `grantApproval`, from an answered request | Yes, while valid |

Keeping them separate is what stops a pending request from being read as
permission. A queued question and a granted approval are different rows in
different tables with different readers.

## 3. Lifecycle

```text
classify act (#15)
      │
      ├─ disposition auto ──────────────► proceed; no row is written
      │
      └─ disposition queue | stop
                 │
        requestApproval()  ──► approval_request(status = pending)
                 │
    ┌────────────┼───────────────┬────────────────────────┐
    │            │               │                        │
 granted       denied      invalidated              still pending
    │            │               │                        │
 Approval    (final)      (final; reason recorded)   (a run may end here)
    │
 consumeApproval() ──► Approval.invalidation = consumed
```

- **`requestApproval` never waits.** It writes a row and returns. Whether a
  human is *shown* the question is a separate step
  (`src/extension/ui/approval-prompt.ts`).
- **A request is single-use.** It leaves `pending` exactly once; the SQL trigger
  `approval_request_resolve_once` enforces it, so a retry, a resumed session or
  a concurrent writer cannot answer the same question twice.
- **The question is immutable.** `approval_request_question_immutable` refuses
  any edit to the class, act, scope, revisions, mode or policy version. Editing
  what was asked after the fact would let a grant authorise something nobody
  agreed to.
- **Nothing is deleted.** `approval_request_no_delete`: a request is history.
- **One pending question per act.** The partial unique index on
  `(workflowId, requestKey)` means a retry loop cannot ask the user the same
  thing a hundred times. `requestKey` covers class, scope, action, task
  revision, plan revision, policy version and mode.

## 4. Revision pinning and invalidation

Every request and every approval carries `(taskRevision, planRevision, mode,
policyVersion)`. Validity is checked in two places, deliberately:

- `approvalInvalidReason` (`src/storage/records.ts`, #12) decides whether a
  granted `Approval` is still usable. This is what the task gate calls.
- `requestStaleness` (`src/workflow/approvals.ts`) decides whether a *pending
  question* is still the question that was asked.

`grantApproval` runs `requestStaleness` **before** writing. A user who approves
a question whose task revision moved while the dialog was open gets a refusal
(`task_revision_changed`) and the request is recorded as `invalidated` — the
answer is never converted into a fresh grant. `invalidatePendingRequests` sweeps
the whole workflow on the same events, but the check at grant time is the one
that has to be right, because it is the only path that can act.

| Event | Effect on a pending request | Effect on a granted approval |
| --- | --- | --- |
| Task revision bumped | `invalidated: task_revision_changed` | invalid (#12) |
| Plan revision bumped | `invalidated: plan_revision_changed` | invalid |
| `Workflow.mode` changed | `invalidated: mode_changed` | invalid via `applyInvalidation` (#41) |
| `Workflow.policyVersion` changed | `invalidated: policy_version_changed` | invalid via `applyInvalidation` |
| Expiry passed | `request_expired` at grant time | invalid |
| Act completed | — | `consumed` |
| User withdrew it | — | `revoked` |

## 5. The seven classes that cannot be configured down

`destructive_cleanup`, `destructive_git`, `remote_push`, `deployment`,
`publishing`, `credential_access`, `modify_policy` are `stop` in **every** mode
and the tier is fixed in `src/workflow/approval-classes.ts`. Three independent
layers:

1. `schema.json` pins each mode to `const: "stop"`.
2. Validator rule **V10** re-checks after the layered merge, so a higher config
   layer cannot weaken a lower one through a merge path. A config that tries is
   **rejected**, never silently honoured.
3. `resolveDisposition` returns `stop` for a high-risk class regardless of the
   table it is handed, and a Jev signal proposing something *less* restrictive
   is discarded (PLAN §3.A: authorisation for an irreversible action is never
   inferred from a score).

Only an actor of kind `user` may grant a high-risk class. `grantApproval`
refuses a `policy` actor with `actor_not_user`, and the gate refuses such a row
independently (`approval_actor_not_user`, `docs/gates.md` B8).

## 6. Non-interactive runs

PLAN §2.6 requires an unattended `run` to queue an approval, continue other
ready tasks, and notify. So:

- `promptForApproval` checks `hasUI === false` **first** and returns
  `{ outcome: "queued", skippedReason: "no_ui" }` without calling `confirm` and
  without awaiting anything the UI owns. A non-TTY run therefore cannot block.
- A UI that stops answering is capped by `timeoutMs`; expiry leaves the request
  `pending` and grants nothing.
- A prompt that throws is a refusal, not consent.
- Only an exact `true` from `confirm` approves. `false`, `null`, `undefined`,
  a string, a truthy object and a number all deny.

`/korwf approvals [--workflow <id>] [--high-risk]` renders the queue, marking
each row `HIGH-RISK/STOP`, `STOP` or `QUEUED`, and flagging any request the
world has outrun as `STALE:<reason>`. The command is read-only.

## 7. What lives where

| File | Responsibility |
| --- | --- |
| `src/workflow/approval-classes.ts` (#15) | vocabulary, tiers, class × mode table, classifier |
| `src/workflow/approvals.ts` (#49) | request → grant → consume → invalidate |
| `src/storage/approval-requests.ts` (#49) | the queue table; single-use and immutability |
| `src/extension/ui/approval-prompt.ts` (#49) | the dialog; never blocks, never grants |
| `src/extension/commands/approvals.ts` (#49) | `/korwf approvals`, read-only |
| `src/verification/task-gate.ts` (#46) | condition 3 reads `Approval` rows |
| `src/workflow/invalidation.ts` (#41) | applies the enumerated invalidation events |
