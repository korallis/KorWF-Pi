# Unattended approval classes (auto / queue-and-continue / stop)

Design authority: PLAN §2.6 (unattended operation), §7 (execution policy), §3.A (never infer
authorization for irreversible actions from a Jev score). Issue #15. Data mirror:
[`src/workflow/approval-classes.ts`](../src/workflow/approval-classes.ts); config surface:
`approvals.classes` in [`src/config/schema.json`](../src/config/schema.json) and
[config-reference §5](config-reference.md#5-approvals). Builds on
[state-machine.md](state-machine.md) (task/phase states, invalidation events),
[gates.md](gates.md) (the gate only consumes a class; it never grants one) and
[records.md](records.md) (`Approval`, `Task.riskClass`).

When `run` operates with the user absent, every decision that would otherwise prompt is
classified **before** it happens. This document is the taxonomy, the default disposition per
mode, the notification payload per class, and the rule for how a class is determined in code.

## 1. Dispositions

| Decision | Meaning (PLAN §2.6) | Task effect | Phase effect |
|---|---|---|---|
| `auto` | Pre-approved for this mode. Act, record, continue. | none | none |
| `queue` | Queue and continue. The act does not happen; the task goes `blocked` with `blocker = approval_queued:<class>`; other ready tasks continue; an `approval_queued` notification is sent. | T* → blocked | none (unless no ready task remains, then the scheduler idles — it does not stop the phase) |
| `stop` | Stop the phase. The act does not happen; affected children are quiesced; the phase goes `paused` / `paused_approval` (state-machine.md `phase-pause`); a `phase_stopped` notification is sent; state is resumable (`phase-resume`). | T* → blocked | P* → paused |

Order: `auto < queue < stop`. "More restrictive" always means later in that order.
`queueTimeoutMinutes` can only turn a queued item into a plain `blocked` task; nothing is ever
auto-approved on timeout (config-reference §5).

A disposition is **not** an `Approval` record. `auto` means "no prompt"; the task gate
(gates.md C3) and phase gate (P4) still require a valid `Approval` with `actor.kind = user` for
any high-risk task, and a `policy` actor can never satisfy that.

## 2. How a class is judged (the ADR 0005 test)

A class describes **what the act does**, not which file, label, topic or directory it touches.
The test, from [ADR 0005](adr/0005-agent-autonomy-and-approval-scope.md):

> reversible **∧** touches no credential **∧** no consumer impact **∧** not a policy loosening
> ⇒ candidate for `auto`.

Failing exactly one of the four is what makes a class `queue`-by-default; failing it
*irreversibly* or in a way only the owner can resolve is what makes it high-risk (`stop`,
fixed). Consequences of applying the test rather than a proxy:

- Pushing the workflow's own task branch to the configured remote (`push_own_branch`) is
  reversible, credential-free, reaches no consumer and loosens nothing → configurable, `auto`
  in bounded-autonomous. The PLAN §7 "remote push" (`remote_push`) is a push to a ref the
  workflow does not own or to another remote — consumers receive it → `stop`, fixed.
- Deleting a git-tracked file inside the worktree (`delete_file`) is reversible → configurable.
  Deleting anything not recoverable from git (`destructive_cleanup`) is not → `stop`, fixed.
- Editing the target project's build/test config (`modify_project_config`) is reversible but
  changes what the checks measure → `queue`. Editing KorWF's own policy (`modify_policy`) is a
  policy loosening → `stop`, fixed, regardless of which file carries it.
- A `Task.riskClass = high` label does **not** make an edit `stop`; the label drives the gate's
  human-approval requirement (gates.md C3), while this table drives what the worker may do
  unattended. Both apply; neither substitutes for the other.

## 3. Tiers

| Tier | Config freedom | Why |
|---|---|---|
| **configurable** | any decision per mode, subject to V4 (no `auto` for a mutation class in `shadow`/`advisory`, which are non-mutating by definition) | The user pre-approves what they are comfortable with per mode. |
| **never auto** (`scope_change`, `replan`) | `queue` or `stop` only, schema `enum` + V11 | PLAN §3.C: replan without silent scope expansion. Reversible, so not pinned to `stop`. |
| **high-risk** (PLAN §7) | `stop` only, schema `const` + V10 | Destructive cleanup, deployment, credential access, publishing, force-push/rewriting shared history, changes to permission/allowlist/spending policy, pushes to refs the workflow does not own. Explicit approval regardless of mode. |
