# ADR 0004 — Worker interface: Pi subprocess over RPC

- **Status:** Accepted (Stage 1, issue #16). Revisit only if Pi's RPC protocol changes shape.
- **Date:** 2026-09-21
- **Issue:** #16 · **Design authority:** PLAN §3.E "Execution and multi-agent orchestration",
  §4 "Reuse of Pi's shipped examples"; baseline fixed by ADR 0001 row 1 (`subagent/`).
- **Pi version examined:** 0.86.0 (`docs/rpc.md`, `docs/sdk.md`, `docs/json.md`,
  `docs/extensions.md`, `docs/environment-variables.md`, `examples/extensions/subagent/index.ts`,
  and the bundled binary's bash-tool and signal-handler code, resolved per AGENTS.md §9).
- **Prototype:** `scripts/probe/worker-spawn.ts` (no model call, no API key; exits 0 with
  11 checks passing — output in the PR for #16).

## Context

A KorWF worker is a bounded, role-scoped Pi run (scout, planner, implementer, verifier,
reviewer, integrator) that the orchestration extension starts, watches, and may cancel.
PLAN §3.E lists what the interface must support; ADR 0001 row 1 lists what the shipped
`subagent/` example lacks (contract, recursion control, process-tree kill, cwd/worktree
contract, pause/resume/restart, durable record, crash detection beyond exit code).

Three candidate interfaces:

- **A — extend `subagent/`:** one `pi --mode json -p --no-session … <prompt>` process per
  task; read-only JSON event stream on stdout; `--append-system-prompt` via temp file;
  cancel = `proc.kill`.
- **B — in-process SDK:** `createAgentSession({ sessionManager, model, customTools,
  resourceLoader, … })` from `@earendil-works/pi-coding-agent` inside the orchestrator's
  own Pi process; `session.prompt()` / `subscribe()` / `abort()`.
- **C — Pi subprocess over RPC:** one `pi --mode rpc …` process per worker; bidirectional
  JSONL over stdin/stdout (`prompt`, `steer`, `follow_up`, `abort`, `abort_bash`, `bash`,
  `get_state`, `get_session_stats`, `set_model`, `switch_session`, `extension_ui_response`).

## Comparison matrix (PLAN §3.E requirements)

Legend: ✅ supported by the mechanism · 🟡 possible with KorWF work on top · ❌ contradicts
or cannot be done without changing Pi.

| # | §3.E requirement | A · `subagent/` (json mode) | B · SDK in-process | C · RPC subprocess |
|---|---|---|---|---|
| 1 | Bounded roles; explicit worker contract (task, tools, artifacts, budget, model, termination) | 🟡 `--tools`, `--model`, `--thinking`, system prompt via temp file; no budget or termination hooks — the run ends when the model stops | 🟡 same knobs as constructor args; budgets enforced from `subscribe()` events | 🟡 same CLI knobs plus runtime `set_model`, `set_thinking_level`, `get_session_stats` for token/cost budgets; termination = `abort` then exit |
| 2 | Single / sequential / parallel / dependency-aware workflows | ✅ N processes (example caps 4 concurrent) | 🟡 N sessions in one event loop; one runaway tool blocks the orchestrator's TUI | ✅ N processes, scheduler in `workflow/` |
| 3 | Separate worktrees for writing workers; one integration owner | ✅ `cwd` per process | 🟡 `cwd` per session but `createAgentSessionServices({cwd})` rebinds cwd-bound services; not designed for many concurrent cwds | ✅ `cwd` per process; worker cannot escape its worktree by changing orchestrator state |
| 4 | Concurrency, recursion-depth, elapsed-time, token, spend limits | 🟡 usage summed from `message_end`; no runtime query; recursion unguarded (child loads all extensions) | 🟡 usage from events; recursion trivial to cause (same process, same extensions) | ✅ `get_session_stats` (tokens, cost, context %) on demand; `message_update.usage` streamed; recursion guard below |
| 5 | **Propagate cancellation and terminate child process trees** | 🟡 `SIGTERM` then `SIGKILL` on the direct child only; Pi reaps its own bash children on SIGTERM (verified) but not on SIGKILL | 🟡 `session.abort()` is cooperative; a hung tool leaves nothing to kill except the orchestrator itself (= Pi's own TUI) | ✅ three tiers verified by the probe: `abort`/`abort_bash` (cooperative) → `SIGTERM` process group (Pi's handler runs `killTrackedDetachedChildren`) → `SIGKILL` + supervisor reaps a pre-snapshotted descendant list |
| 6 | **Workers do not inherit orchestration extensions unless explicitly allowed** | ❌ example launches without `--no-extensions`; child loads every user/project extension including the spawner | ❌ shares the orchestrator's extension runtime by construction; a custom `ResourceLoader` can strip extensions but tools registered in-process remain reachable | ✅ `--no-extensions` + explicit `-e <role extension>`; verified that discovered extensions are dropped and only explicit ones load |
| 7 | Pause, resume, cancel, restart recovery, partial completion | ❌ `-p --no-session`: transcript discarded; no steer/follow-up; restart = start over | 🟡 in-memory or file session; `steer`/`followUp`; restart recovery only if orchestrator process survives | ✅ durable session file (`--session-dir`), `steer`, `follow_up`, `switch_session`/`--session` for resume after either side restarts; partial state via `get_state` |
| 8 | Progress capture (streamed events) | ✅ full event stream | ✅ `subscribe()` | ✅ same event stream (`agent_start/end`, `tool_execution_*`, `message_update`, `bash_execution_update`, `queue_update`) |
| 9 | Crash detection | 🟡 exit code / stream EOF | ❌ a crash in worker code is a crash of the orchestrator (uncaught exception exits Pi) | ✅ exit code + signal + stream EOF, isolated from the orchestrator; Pi writes a crash report on uncaught exceptions |
| 10 | Approvals / questions from the worker reach the orchestrator | ❌ print mode has no UI channel (`ctx.hasUI === false`) | ✅ same process | ✅ `extension_ui_request` → orchestrator answers with `extension_ui_response` (or times out) |
| 11 | Cross-platform | ✅ Node `spawn`; Windows kill is `taskkill` | ✅ | ✅ same as A; Pi's bash tool uses `windowsHide` and PowerShell variants; LF-only JSONL framing is platform-neutral |
| 12 | Resource inheritance control (skills, prompt templates, context files, model scope) | 🟡 flags exist (`--no-skills`, `--no-prompt-templates`, `--no-context-files`, `--models`) but the example passes none | 🟡 `ResourceLoader` overrides; more code, same effect | ✅ same flags, applied by `workers/spawn.ts` from the role contract |
| 13 | Per-worker model / tools / cwd selection | ✅ | ✅ | ✅ plus runtime `set_model` for fallback (§3.D) without restart |
| 14 | Restricted execution via a separate sandbox (§3.E last bullet) | 🟡 wrap the command line | ❌ cannot sandbox part of one process | ✅ the worker command line is the sandbox boundary (`bwrap`, container, `sandbox` example) |

**Tally:** A has three ❌ (recursion, resume, UI channel), B has three ❌ (recursion,
crash isolation, sandboxing) and blocks the orchestrator's own UI thread, C has none.

## Decision

**KorWF workers are Pi subprocesses driven over RPC (`pi --mode rpc`).** `src/workers/`
owns spawn, protocol framing, cancellation, and crash detection; roles come from
`resources/roles/*.md` (ADR 0001 manifest). The shipped `subagent/` example remains the
*baseline* whose stream-parser and concurrency fragments are copied with attribution, but
its `--mode json -p` invocation is replaced by RPC.

Why not B despite its convenience: PLAN §3.E's "terminate child process trees", "workers
do not inherit orchestration extensions", and "restricted execution uses a separately
defined sandbox" all assume a process boundary; and a worker exception must never take
down the user's session.

### Invocation shape

```
pi --mode rpc
   --no-session | --session-dir <korwf-store>/workers/<worker-id>   (durable when resumable)
   --no-extensions [-e <role-extension>.ts …]
   --no-skills [--skill <path> …] --no-prompt-templates --no-context-files
   --provider <p> --model <m> [--thinking <level>] --models <allowlist>
   --tools <role tool list>   [--append-system-prompt <role prompt file>]
   --name korwf-<role>-<n>
```

Env added to the worker: `KORWF_WORKER=1`, `KORWF_WORKER_ID`, `KORWF_WORKER_DEPTH`,
`KORWF_WORKER_ROLE`, `PI_OFFLINE=1` when the role needs no network beyond the model
endpoint. Nothing provider-specific is hardcoded; provider/model/allowlist come from the
config layer (§3.D). The task itself goes as the first `prompt` command, not as argv, so
it never appears in `ps` output.

### How recursive spawning is prevented

Three independent guards; all must hold (no single point of failure):

1. **Extension isolation (primary).** Workers are launched with `--no-extensions`, so the
   `korwf` orchestration extension — the only thing that can spawn workers — is never
   loaded in a worker. Verified in this issue: with `--no-extensions` a project extension
   under `.pi/extensions/` is not loaded, and only paths passed with `-e` are. Role
   extensions passed with `-e` are shipped by KorWF and contain no spawn tool. (One
   inline extension registered by the local Pi build, `llama`, survives `--no-extensions`
   because it is compiled into the binary, not discovered from disk; it registers a
   command, not a tool, and is out of KorWF's control — noted, not a risk to recursion.)
2. **Depth marker in the environment.** `KORWF_WORKER_DEPTH=<n>` is set on every worker.
   The orchestration extension reads it at load time; if it is set and ≥ the configured
   `workers.maxDepth` (default **1**: workers may not spawn workers), the extension
   registers **no** spawn tool or command and logs why. Depth > 1 is an explicit config
   opt-in per PLAN §3.E ("unless explicitly allowed"), never a default.
3. **Tool allowlist per role.** `--tools` contains only the role's tools; no role lists a
   spawn tool. Even a worker that somehow loaded the extension would have the tool
   filtered from its active set.

Pi already forwards `AI_AGENT=pi` and `PI_CODING_AGENT=true` to children (verified); KorWF
adds its own markers rather than overloading these.

### Cancellation and process-tree termination (verified behaviour)

Findings from Pi 0.86.0's bash tool (`createLocalShellOperations`) and mode entry points:

- Pi spawns each shell command with `detached: true` (own process group), tracks the pid
  (`trackDetachedChildPid`), and on abort/timeout runs `killProcessTree(pid)`.
- Pi's `SIGTERM`/`SIGHUP` handlers in rpc, json and tui modes call
  `killTrackedDetachedChildren()` before exiting 143/129. **So SIGTERM to the worker
  reaps its running commands** (probe check 4).
- **SIGKILL to the worker orphans them**: the detached command is in its own process
  group, reparented to PID 1, and keeps running (probe check 5 shows the `sleep` alive
  after the kill). A negative-pid kill of the worker's group does not reach it either.

Therefore `workers/` implements escalation with a descendant snapshot:

| Tier | Action | When |
|---|---|---|
| 1 cooperative | RPC `abort` (agent turn) / `abort_bash` (RPC-initiated command); wait for `agent_end` / response `cancelled: true` | normal cancel, budget exceeded, user Esc |
| 2 graceful | snapshot descendants (`ps -eo pid,ppid` walk; Windows `Win32_Process`), `SIGTERM` to the worker's process group and pid; wait `graceMs` (default 3 s) | tier 1 not acknowledged within its deadline, or shutdown |
| 3 hard | `SIGKILL` group + pid; then `SIGKILL` every pid from the snapshot that is still alive; verify none remain (Windows: `taskkill /PID <pid> /T /F`) | tier 2 timed out |

Worker pids and their snapshots are persisted in the KorWF store (§5) so that an
orchestrator restart can reap workers it no longer holds handles to (§3.E "restart
recovery").

### Resource and progress capture

- Progress: the RPC event stream is forwarded to `workflow/` as-is; `tool_execution_*` and
  `bash_execution_update` drive the board; `message_update.usage` and
  `get_session_stats` feed accounting (§3.G) and token/spend limits.
- Crash detection: `exit` with non-zero code or a signal, or stdout EOF while a command
  is outstanding, marks the worker `crashed`; pending waiters resolve with a synthetic
  `worker_exit` message (as the probe does) so nothing hangs.
- Approvals: `extension_ui_request` from role extensions is routed to the orchestrator's
  approval policy (§3.F/§3.I); unanswered requests time out on the worker side, which is
  the correct unattended default.

## Consequences

- `src/workers/` needs: an LF-only JSONL framer (Node `readline` is explicitly
  non-compliant per `rpc.md`), a request/response correlator keyed on `id`, the
  three-tier canceller with descendant snapshot, and a Windows path for tree
  enumeration and kill.
- One OS process per worker: startup cost ≈ Pi cold start; acceptable for bounded roles,
  and the reason for `--no-skills --no-prompt-templates --no-context-files` by default.
- Workers cannot call back into orchestrator tools directly; anything they need
  (approvals, handoff packets) goes through the RPC channel or the store. This is the
  boundary PLAN wants.
- The `subagent/` copy manifest in ADR 0001 stands (role loader, `mapWithConcurrencyLimit`,
  JSON-line parser); the parser is generalised to the RPC framing above.
- Hard kill leaves nothing behind only because of the snapshot. Do not "simplify" tier 3
  to a plain `proc.kill("SIGKILL")`.

## Follow-ups

- #17 threat model: add "worker SIGKILL orphans detached commands" and "compiled-in
  extensions bypass `--no-extensions`" as residual risks with the mitigations above.
- Stage 2 `workers/` implementation issue: Windows tree enumeration/kill and a test that
  fails if `KORWF_WORKER_DEPTH` handling is removed from the extension.
