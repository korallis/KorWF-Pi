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

## 4. Default disposition table

Columns are modes (`WorkflowMode`): shadow / advisory / supervised / bounded_autonomous.
Bold rows are fixed. This table is generated from `APPROVAL_CLASS_TABLE`; the test
`AC1` in `test/workflow/approval-classes.test.mjs` fails if this section, the code and
`schema.json` disagree.

| Class | Tier | Risk | shadow | advisory | supervised | bounded_autonomous | Act | Why (ADR 0005 test) |
|---|---|---|---|---|---|---|---|---|
| `read_repository` | configurable | low | auto | auto | auto | auto | Read files, history or metadata inside the repository, minus privacy deny paths. | No mutation, no credential (deny paths exclude them), nothing leaves the machine. |
| `edit_worktree` | configurable | low | stop | stop | queue | auto | Create or modify a tracked or new file inside the task worktree and within the task's ownership. | Reversible via git; isolated in the task worktree; no consumer impact until merged and gated. |
| `delete_file` | configurable | low | stop | stop | queue | auto | Delete a git-tracked file inside the task worktree and ownership. Untracked, ignored or out-of-worktree deletion is destructive_cleanup. | Tracked content is recoverable from history; the task gate still has to pass on the result. |
| `write_outside_ownership` | configurable | medium | stop | stop | queue | queue | Create, modify or delete a file in the worktree outside the task's declared ownership paths/components. | Reversible, but may collide with another task's ownership (PLAN §3.E) and hides scope creep. |
| `modify_project_config` | configurable | medium | stop | stop | queue | queue | Edit build, test, lint, CI or packaging configuration of the target project (not KorWF policy — that is modify_policy). | Reversible, but can change what the deterministic checks measure; a human should see it before it is trusted. |
| `run_checks` | configurable | low | stop | stop | auto | auto | Execute a registered check definition of the task inside its worktree. | Bounded by the check definition and budgets; produces gate evidence; read-mostly. |
| `run_shell` | configurable | medium | stop | stop | queue | queue | Execute a shell command that is not a registered check and matches no other class. | Arbitrary code execution; reversibility unknown. Never pre-approved by default; the user opts in per project. |
| `run_migration` | configurable | medium | stop | stop | queue | queue | Run a schema or data migration against a local/ephemeral development database created by the task. | Reversible on a throwaway store; against any shared or persistent store it is deployment. |
| `install_dependencies` | configurable | medium | stop | stop | queue | queue | Install the project's already-declared dependencies (lockfile unchanged). | Network plus execution of install scripts, but nothing new enters the declared set. |
| `add_dependency` | configurable | medium | stop | stop | queue | queue | Add, remove or change the version of a declared dependency (manifest or lockfile diff). | Reversible, but consumers inherit supply-chain and licence consequences; a human should see it. |
| `network_access` | configurable | medium | stop | stop | queue | queue | Any outbound connection other than the configured Jev endpoint, model providers and the package registry used by install_dependencies. | Data may leave the machine (PLAN §7 data policy); destination is not pre-approved. |
| `local_commit` | configurable | low | stop | stop | queue | auto | Create a commit on the task branch in the task worktree. | Reversible, local, never leaves the machine. |
| `push_own_branch` | configurable | low | stop | stop | queue | auto | Fast-forward push of the workflow's own task branch to the workflow's configured remote (ADR 0005). | Reversible (branch can be deleted), no shared history rewritten, nothing consumers receive. Not the PLAN §7 remote push. |
| `spawn_worker` | configurable | low | stop | stop | queue | auto | Start a worker attempt for a ready task within the allowlist and budgets. | Spends budget; bounded by budgets.*.maxConcurrency and the caps; visible in the task board. |
| `model_fallback` | configurable | low | auto | auto | queue | auto | Switch a running or next attempt to another allowlisted model at equal or lower estimated cost. | Within the allowlist, recorded on the Attempt, visible; cost cannot rise. |
| `model_substitute_more_expensive` | configurable | medium | auto | auto | queue | queue | Switch to an allowlisted model whose estimated cost for the attempt exceeds the primary's. | Within the allowlist but spends more than the plan assumed; budgets still hard-stop. |
| `spend_over_estimate` | configurable | medium | auto | auto | queue | queue | Continue a phase whose projected spend exceeds the pre-run estimate by budgets' tolerance (never past a hard cap). | Money; a hard cap is still a hard stop regardless of this class (PLAN §2.6). |
| `complete_task` | configurable | low | stop | stop | queue | auto | Mark a task done after the task gate (docs/gates.md C1–C5) has passed. | The gate is the guard; this class decides only whether a human confirms the transition. |
| `scope_change` | never auto | medium | stop | stop | queue | queue | Change a task's goal, acceptance criteria or exclusions, or add/remove tasks in the running phase. | Reversible, but PLAN §3.C forbids silent scope expansion; invalidates approvals (plan_revision_changed). |
| `replan` | never auto | medium | stop | stop | queue | queue | Regenerate the phase plan or task decomposition after a failure or gap. | Reversible, but it is a product decision the user must see; never auto in any mode. |
| `destructive_cleanup` | **high-risk** | high | **stop** | **stop** | **stop** | **stop** | Delete or overwrite anything not recoverable from git: untracked/ignored files, directories outside the worktree, other worktrees, stores. | Irreversible. |
| `destructive_git` | **high-risk** | high | **stop** | **stop** | **stop** | **stop** | Rewrite or discard history that is shared or not owned by this workflow: force-push, branch -D of a non-task branch, reset --hard past pushed commits, reflog expiry, tag deletion. | Irreversible for other people; PLAN §7 'force-pushing or rewriting shared history'. |
| `remote_push` | **high-risk** | high | **stop** | **stop** | **stop** | **stop** | Push to a ref the workflow does not own (main/default branch, shared branches, another workflow's branch) or to a remote other than the configured one. | Consumers receive it; may be irreversible downstream. The agent's own task branch is push_own_branch. |
| `deployment` | **high-risk** | high | **stop** | **stop** | **stop** | **stop** | Any action that changes a running or shared environment: deploy, migrate a shared database, change infrastructure. | Consumer impact; often irreversible. |
| `publishing` | **high-risk** | high | **stop** | **stop** | **stop** | **stop** | Publish or release: create/push tags, publish to a registry, create a release, anything consumers receive. | Consumers receive it; registries do not un-publish. |
| `credential_access` | **high-risk** | high | **stop** | **stop** | **stop** | **stop** | Read, write, print or transmit a secret, key, token or credential store, or a privacy deny path. | Credential. |
| `modify_policy` | **high-risk** | high | **stop** | **stop** | **stop** | **stop** | Change KorWF config or policy: approval classes, allowlist, budgets, privacy lists, execution isolation, or this table. | Policy loosening; the system never weakens its own permission, allowlist or spending policy (AGENTS.md §4). |

Mode rationale: `shadow` observes only and `advisory` proposes only, so every mutation is
`stop` there and the only `auto` rows are non-mutating (read, model choice, spend bookkeeping).
`supervised` acts only on explicit approval, so mutations are `queue` and the user works the
queue. `bounded_autonomous` pre-approves reversible, local, credential-free acts and queues
anything that spends more than planned, reaches the network, changes dependencies or leaves
the task's ownership.

## 5. Notification payload

Every `approval_queued` and `phase_stopped` notification (config-reference §8) carries the
common fields below plus the class-specific fields from the table. Payloads are built from
records and `ActFacts` only; they pass the privacy filter (§6 of config-reference) and never
include file contents, secrets or raw model output.

Common fields: `event`, `class`, `tier`, `decision`, `mode`, `workflowId`, `phaseId`, `taskId`, `taskRevision`, `planRevision`, `attemptId`, `summary`, `determinedBy`, `jevEscalation`, `expiresAt`, `resume`, `createdAt`.

| Field | Content |
|---|---|
| `event` | `approval_queued` or `phase_stopped` (`NotificationEvent`). |
| `class`, `tier`, `decision`, `mode` | The classified act and the disposition that produced the notification. |
| `workflowId`, `phaseId`, `taskId`, `taskRevision`, `planRevision`, `attemptId` | Record ids the answer must be scoped to; a later revision invalidates it (records.md §6). |
| `summary` | One line, human-readable, from the deterministic classifier (never from the worker's prose). |
| `determinedBy` | The matching rule id of the classifier (§6), so the user can see *why* the class was chosen. |
| `jevEscalation` | `null`, or `{questionId, proposed, probability}` when Jev raised the decision. |
| `expiresAt` | When the queued item becomes plain `blocked` (`queueTimeoutMinutes`), or `null`. |
| `resume` | The command that answers it: `/korwf approve <id>`, `/korwf deny <id>`, or `/korwf resume <phase>`. |
| `createdAt` | ISO timestamp. |

Class-specific fields:

| Class | Fields |
|---|---|
| `read_repository` | `paths` |
| `edit_worktree` | `paths`, `bytesChanged` |
| `delete_file` | `paths` |
| `write_outside_ownership` | `paths`, `ownerTaskIds` |
| `modify_project_config` | `paths`, `checksAffected` |
| `run_checks` | `checkId`, `command` |
| `run_shell` | `command`, `cwd` |
| `run_migration` | `command`, `target` |
| `install_dependencies` | `command`, `packageManager` |
| `add_dependency` | `packages`, `manifestPaths` |
| `network_access` | `hosts`, `purpose` |
| `local_commit` | `branch`, `sha` |
| `push_own_branch` | `branch`, `remote`, `sha` |
| `spawn_worker` | `role`, `modelRef`, `estimatedCost` |
| `model_fallback` | `fromModelRef`, `toModelRef`, `reason` |
| `model_substitute_more_expensive` | `fromModelRef`, `toModelRef`, `estimatedCostDelta` |
| `spend_over_estimate` | `estimateUsd`, `projectedUsd`, `capUsd` |
| `complete_task` | `gateReceiptId` |
| `scope_change` | `planRevisionFrom`, `planRevisionTo`, `diffSummary` |
| `replan` | `reason`, `planRevisionFrom`, `proposedTaskCount` |
| `destructive_cleanup` | `paths` |
| `destructive_git` | `command`, `refs` |
| `remote_push` | `branch`, `remote`, `sha` |
| `deployment` | `target`, `command` |
| `publishing` | `artifact`, `target` |
| `credential_access` | `paths`, `secretKind` |
| `modify_policy` | `paths`, `keysChanged` |

## 6. How the class is determined in code

**Deterministic rules first. Jev may only escalate, never de-escalate.**

1. **Facts are computed, never claimed.** `classifyAct(facts: ActFacts)` takes only fields
   produced by code: `src/git/` (tracked/untracked, ref ownership, remote, diff paths),
   `src/security/` (deny paths, ownership boundaries, network allowlist, KorWF policy files),
   `src/models/` (estimated cost delta), the planner records (`planOp`, `taskOp`). A worker's
   description of its own action, tool-call arguments not yet executed, or a Jev answer are
   **never** inputs to classification.
2. **Most restrictive match wins.** Rules are ordered high-risk → never-auto → medium → low
   and the first match is the class. An act that is both "inside ownership" and "touches a
   deny path" is `credential_access`. Unmatched executions fall to `run_shell`; unmatched
   writes fall to `write_outside_ownership`. Nothing is `auto` by omission.
3. **Config gives the rule decision.** `resolveDisposition(class, mode, table)` reads the
   merged `approvals.classes` table. High-risk classes resolve to `stop` even if the table were
   somehow weakened (the schema `const` and V10 already reject such a config; this is defence
   in depth). Never-auto classes resolve to at least `queue`.
4. **Jev may raise, never lower.** A Jev question (e.g. "does this diff touch enforcement
   code?", "is this migration really against an ephemeral store?") may supply a
   `JevEscalation {questionId, proposed, probability}`. It is applied only when `proposed` is
   *more* restrictive than the rule decision, and then it is recorded in the disposition and in
   the notification's `jevEscalation`. A less restrictive proposal is discarded and recorded as
   ignored. With no Jev key, Jev unavailable, or Jev timed out, the rule decision stands
   unchanged — the workflow never waits on Jev to act less cautiously.
5. **`Task.riskClass` and the class are independent guards.** A change to `Task.riskClass`
   (records.md §5 open question for #15) does **not** bump the task revision and does **not**
   by itself invalidate approvals. It changes which gate predicate applies next time the gate
   runs (`riskClass = high ⇒ humanApproval`); an existing approval with `a.riskClass <
   T.riskClass` simply fails the "valid approval" predicate in gates.md §2, so re-approval is
   required by rule, not by revision. Raising `riskClass` never loosens anything; lowering it
   never resurrects a rejected approval because gates evaluate the current record.

Rule ids, as recorded in the notification's `determinedBy` field, are the class ids of the
first-matching branch in `classifyAct`, so the trace reads e.g. `determinedBy:
credential_access(touchesDenyPath)`.

### Validator rules added to config-reference §11

| Id | Rule | Why |
|---|---|---|
| V10 | `approvals.classes[c][m] = "stop"` for every high-risk class `c` and every mode `m`. Enforced in-schema (`HighRiskPolicy` `const`) **and** re-checked after layered merge by `validateApprovalClasses`. | PLAN §7: high-risk classes cannot be set to `auto` (or `queue`). The system never weakens its own permission policy. |
| V11 | `approvals.classes[c][m] ≠ "auto"` for `c ∈ {scope_change, replan}`. Enforced in-schema (`NoAutoPolicy` `enum`) and re-checked. | PLAN §3.C: no silent scope expansion. |
| V12 | Every class present in config has a decision for all four modes. | A partial row would otherwise silently take a default the user did not see. |

V4 (mutation classes never `auto` in `shadow`/`advisory`) is unchanged and applies to the
extended vocabulary; `MUTATION_CLASSES` in the code is its list.

## 7. Interaction with invalidation events

`expired`, `mode_changed`, `policy_version_changed` and `revoked` have phase effect
"by approval class" (state-machine.md §5). That resolves as: the affected task goes `blocked`;
the phase pauses (`paused_approval`) **iff** the action the invalidated approval permitted
resolves to `stop` in the *current* mode and policy; otherwise the phase continues with its
other ready tasks and the task is re-queued. `mode_changed` to a stricter mode therefore
usually pauses; to a looser mode never auto-approves anything — a fresh approval is required
in every case (records.md §6).

## 8. Open items for later issues

- #21 (config loader) wires `validateApprovalClasses` into the validator as V10–V12.
- #49 (unattended `run`) implements the queue, the `phase-pause` transition and the
  notification channels; this document fixes the payload contract it must honour.
- The Jev questions that may escalate (`touches_enforcement`, `migration_target_shared`,
  …) are versioned under `src/decisions/`; none may lower a disposition.
