# Worker roles, contracts and launch (issue #68)

Implements PLAN §3.E on the interface chosen in
[ADR 0004](adr/0004-worker-interface.md): a worker is a `pi --mode rpc`
subprocess with an explicit role, model, tool allowlist, cwd and resource
inheritance. This document is the operator-facing summary; the ADR remains the
design authority.

## The contract

`src/workers/contract.ts` — `WorkerContract` carries every field PLAN §3.E
requires: `task`, `tools`, `termination.artifacts`, `budget`, `model`,
`termination`. `validateContract(contract, policy)` runs **before** anything is
spawned and can only reject, never widen:

| Violation | Meaning |
|---|---|
| `model_not_in_allowlist` / `model_budget_unavailable` | decided by #60's own `enforcePolicy`, not a second copy of the rule |
| `tool_not_allowed_for_role` | tool outside the role's table |
| `spawn_tool_requested` | a tool that could start another agent |
| `mutation_tool_for_read_only_role` | write/edit/shell in a read-only role |
| `depth_exceeds_max` | above `workers.maxDepth` |
| `extension_inheritance_not_permitted` | `-e` path not explicitly permitted |
| `cwd_not_absolute`, `empty_task`, `invalid_budget` | structural |

`draftToContract` fills omissions with the *narrowest* configuration — the
role's own tool list, no inherited resources, depth 1, no durable session — so
forgetting a field can never widen what a worker may do.

## Roles and tools

`src/workers/roles.ts`. The contracts are shipped Markdown in
`resources/roles/`; the tool allowlists are a table in code, and each contract
restates its list under `## Tool allowlist (enforced by --tools)`.
`loadRoleDefinition` fails if the two disagree — otherwise a worker could be
told one thing and permitted another.

| Role | `--tools` | Notes |
|---|---|---|
| scout | `read, grep, find, ls` | read-only in the strong sense |
| planner | `read, grep, find, ls, write, edit` | writes the plan, runs nothing |
| reviewer | `read, grep, find, ls` | read-only |
| implementer | `read, grep, find, ls, write, edit, multiedit, bash` | |
| verifier | `read, grep, find, ls, bash` | runs checks, cannot edit the code it judges |
| integrator | `read, grep, find, ls, write, edit, multiedit, bash` | |

## Launch

`buildWorkerArgv` (ADR 0004 "Invocation shape"):

```
pi --mode rpc
   --no-session | --session-dir <dir>
   --no-extensions [-e <permitted role extension> …]
   --no-skills [--skill <path> …] --no-prompt-templates --no-context-files
   --provider <p> --model <m> [--thinking <level>]
   --tools <role list> --name korwf-<role>-<id>
```

The four isolation flags are unconditional. The task text is sent as the first
RPC `prompt`, never as argv, so it does not appear in `ps`.

## Recursion: three independent guards

1. **`--no-extensions`** — the orchestration extension, the only thing that can
   spawn workers, is never loaded in a worker.
2. **`KORWF_WORKER_DEPTH`** — `src/extension/index.ts` reads it at load;
   at or above `workers.maxDepth` (default **1**) the `run` subcommand is not
   registered at all. A malformed value reads as the ceiling, so corruption
   refuses rather than permits.
3. **The per-role `--tools` allowlist** — no role lists a spawn tool, and
   `roleTools()` throws if one is ever added.

Each is tested on its own in `test/workers/recursion.test.ts`, because the
property is that no single guard is load-bearing.

## Environment: a worker never receives credentials

`src/workers/env.ts` builds the environment rather than inheriting it.
Inheritance is an **allowlist** (`PATH`, `HOME`, `TMPDIR`, locale, …), and any
name matching `JEV`, `TYPESAFE`, `API_KEY`, `SECRET`, `TOKEN`, `PASSWORD`,
`CREDENTIAL`, … is dropped even if it appears in that list. Passing a
credential-shaped variable explicitly throws. Added: `KORWF_WORKER`,
`KORWF_WORKER_ID`, `KORWF_WORKER_ROLE`, `KORWF_WORKER_DEPTH`, and `PI_OFFLINE`
when the contract asks for it.

## Cancellation: the whole process tree

`WorkerHandle.cancel()` follows ADR 0004's ladder, and **snapshots descendants
before signalling**:

1. **cooperative** — RPC `abort` + `abort_bash`, wait `graceMs`;
2. **graceful** — SIGTERM to the process group and pid; Pi's own handler reaps
   its tracked detached children here;
3. **hard** — SIGKILL group and pid, then SIGKILL every pid from the
   pre-kill snapshot that is still alive.

Tier 3 exists because SIGKILL *orphans* Pi's detached commands: they are in
their own process group and reparent to PID 1, so after the kill nothing can
enumerate them. `test/workers/cancel.test.ts` spawns real detached grandchildren
and asserts a post-kill snapshot no longer contains them — the defect this
design prevents. Do not simplify tier 3 to `proc.kill("SIGKILL")`.

## Visibility

A headless RPC worker is in no terminal pane, so the host's agent panel cannot
see it. `src/workers/surface.ts` opens the worker's **own worktree** as a Space
(grouping is by git worktree identity, so it nests under the project). It has
no code path that can split a pane, closes only a Space it opened, never a tab,
and is best-effort: if the host is absent, the worker still runs.

## Runtime control: progress, artifacts, usage and limits (issue #71)

`src/workers/lifecycle.ts` supervises a launched worker. It adds nothing to the
launch path — the contract, the argv and the cancellation ladder above are
unchanged — and owns four concerns.

### Progress comes from the RPC event stream, and only from there

ADR 0004 already decided the channel: `tool_execution_*` and
`bash_execution_update` drive the board, `message_update.usage` and
`get_session_stats` feed accounting. `src/workers/progress.ts` classifies those
already-decoded messages into a `ProgressEvent` timeline. There is no second
channel, no log scraping and no polling of the worker's filesystem.

The timeline is **bounded** (`maxEvents`, default 500) and counts what it
dropped. Event details never copy tool output or message content: a board line
says `bash output`, not the output.

`WorkerHandle.subscribe()` was added so a supervisor can attach without
displacing the spawn-time `onMessage` hook. A subscriber that throws is
isolated — progress capture must never be able to kill the RPC reader and hang
the worker.

### Artifacts

`termination.artifacts` are captured into the issue-#23 `ArtifactStore` under
the attempt id, hashed and manifested there. A declared artifact the worker
never produced is reported `missing: true` with no ref — it is never invented,
and its absence is evidence the verification gate can act on. A declared path
that resolves outside the worker's worktree is refused rather than captured.

### Usage is attributed per ROUTE, and unknown cost stays unknown

A route is one rate-limited path to a model (ADR 0011): a Pi provider key plus
a model id under it. A user with two subscriptions to one vendor has two
providers exposing the same model id and two independent quotas, so usage keyed
on the model id mixes two accounts and both reports are wrong. Every charge a
worker makes is labelled `route:<routeId>` on its ledger rows, on the
reservation *and* on the settlement, so a per-route total can be read from
settlements alone. `src/telemetry/usage.ts` does the grouping.

Cost the registry does not state is `unknown`, never `0` (#56, #30). Pi reports
`costUsd: 0` for a subscription-backed route it cannot price, so `usageFromRpc`
treats a zero or absent charge with no price metadata as `costBasis:
"unknown"`, `spendUsd: null`. Unpriced requests are counted separately and are
never presented as `$0.00`.

### Limits: global in the ledger, per-worker in a pure predicate

| Limit | Where enforced | Why there |
| --- | --- | --- |
| spend, tokens, requests, concurrency per workflow/phase/task | `Ledger.reserve()` (#30) | The cap check and the reservation insert share one `BEGIN IMMEDIATE` transaction, so two workers cannot both pass the same remaining budget. Any in-process counter would let both through. |
| wall clock, output tokens, total tokens, spend per worker | `src/workers/limits.ts` | Pure predicates over observed usage; no timers or signals, so the policy is testable without a process. |

`WorkerRun.start()` reserves before the supervision begins, and a
`BudgetExceededError` propagates out of it unchanged — a refused worker records
no progress. `WorkerRun.finish()` settles the reservation exactly once with the
actual usage.

An unpriced route does **not** breach the per-worker spend ceiling: `null` is
neither zero (a silent under-report) nor infinity (which would kill every
unpriced worker). Its token and elapsed limits still apply, because those do
not depend on a price.

A wall-clock timer wakes at the deadline and **re-arms** if it finds no breach.
A single-shot timer can observe `elapsed === limit`, which is not yet over the
limit, and a worker that emits nothing would then never be checked again.

### Pause, resume, cancel

`pause()` sends SIGSTOP to the worker's process **group** first, then its pid,
so a shell command the worker spawned stops too — pausing only the direct child
leaves a build running and still spending. The elapsed clock stops with it: a
paused worker must not burn the wall-clock limit it cannot work against, or
`pause` is just a slow `cancel`. Where POSIX job control does not apply, the
RPC `abort_bash` is the cooperative fallback.

`cancel()` sends SIGCONT to a paused worker **before** entering the ladder: a
stopped process never receives SIGTERM, so without this every cancellation of a
paused worker would silently escalate to SIGKILL.

`/korwf pause|resume|cancel [<workerId>|--all] [--reason <text>]` address live
runs through `WorkerRegistry`. The registry holds handles only — global
concurrency is a budget cap in the ledger, never a count of this map. Recursion
guard 2 withholds all four worker-surface commands inside a worker, not just
`run`: a worker that can pause or cancel workers is a worker that supervises
them.

A cancellation that left survivors says so. `/korwf cancel` reports the tier
that ended each worker, how many descendants the sweep signalled and how many
survived, and prints a warning rather than a reassuring "cancelled".
