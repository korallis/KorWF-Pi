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
