# ADR 0001 — Reuse, extend, or replace: Pi's shipped example extensions

- **Status:** Accepted
- **Date:** 2026-09-21
- **Issue:** #8 · **Design authority:** PLAN §4 "Reuse of Pi's shipped examples", §3 A–J
- **Pi version examined:** 0.86.0 (`<pi-install>/examples/extensions/`, resolved per AGENTS.md §9)

## Context

PLAN §4 requires a Stage 1 decision, per shipped example, on whether KorWF reuses it,
extends it, or replaces it, before the source layout is finalised (ADR 0002). All 13
examples were read in full — including `subagent/agents.ts`, `agents/*.md`,
`prompts/*.md`, `plan-mode/utils.ts`, and `sandbox/package.json` — not just their
headers. Findings are cross-checked against `docs/pi-integration-map.md` (#7).

### Decision vocabulary

| Decision | Meaning for KorWF |
|---|---|
| **Reuse** | Copy the example (with attribution) into the module named, adapt names/config, keep its shape. Small examples only. |
| **Extend** | Adopt the example's *mechanism* (which Pi event/API it uses and how) as the baseline of a KorWF module, then add what PLAN requires. Code is rewritten around the mechanism; fragments may be copied with attribution. |
| **Replace** | Do not adopt. KorWF's own module covers the need in a way that the example's design contradicts. Specific fragments may still be salvaged; these are named. |

Nothing is imported by symlink or as a runtime dependency: the examples are not a
published package and are not versioned independently of Pi.

### Licence

Pi's install tree carries no `LICENSE` file, but `<pi-install>/package.json` declares
`"license": "MIT"` (author Mario Zechner, repository
`github.com/earendil-works/pi`, directory `packages/coding-agent`), the shipped
`README.md` states MIT, and the npm registry entry for
`@earendil-works/pi-coding-agent@0.86.0` reports MIT. All 13 examples fall under that
licence. MIT-licensed material is compatible with this project's MIT licence
(`LICENSE`). The `sandbox/` example additionally depends on
`@anthropic-ai/sandbox-runtime@0.0.26`, which is **Apache-2.0** (repository
`anthropic-experimental/sandbox-runtime`); that dependency is *not* adopted (see row 3).

**Attribution rule.** Any file that copies or adapts example code must start with a
comment `Adapted from pi <version> examples/extensions/<path> — MIT, © Mario Zechner /
earendil-works`, and the repository must carry a `THIRD_PARTY_NOTICES.md` reproducing
the upstream MIT notice once the first such file lands (Stage 2; tracked as a
follow-up issue from #8).

## Cross-cutting findings (apply to every row)

These gaps recur in every example and are not repeated in the table:

1. **Nothing is namespaced.** Tools are `todo`, `subagent`, `questionnaire`; commands
   are `/plan`, `/handoff`. PLAN §J requires the `korwf` prefix on every command,
   tool, and storage path.
2. **Nothing is durable.** State lives in closures (`git-checkpoint`), in tool-result
   `details` (`todo`), or in the session file. PLAN §5 requires SQLite records with
   revision semantics.
3. **Interactive-only assumptions.** Most examples call `ctx.ui.select/confirm/custom`
   and either block (good: `permission-gate`) or degrade silently when `ctx.hasUI` is
   false. PLAN §2.6 unattended operation needs an explicit auto/queue/stop class per
   decision, never an implicit prompt.
4. **Provider and model names are hardcoded** in `custom-compaction.ts`
   (`google/gemini-2.5-flash`) and in every `subagent/agents/*.md`
   (`claude-haiku-4-5`, `claude-sonnet-4-5`). PLAN §J forbids this in shipped code;
   all model choices go through `models/` and the allowlist.
5. **No audit trail.** Approvals, blocks, and restores are not recorded anywhere.
   PLAN §I requires decisions explained from recorded inputs.

## Decision table

Scope areas are PLAN §3 letters (A intake, B context, C planning, D models,
E execution/orchestration, F verification, G recovery, H memory/handoff,
I observability, J packaging). "Home" is the module in ADR 0002 that owns the result.

| # | Example | What it does (as read) | Scope | Decision | Rationale · what is missing vs PLAN | Home | Licence |
|---|---|---|---|---|---|---|---|
| 1 | `subagent/` (index.ts 1038 l., agents.ts, 4 agent defs, 3 prompt templates) | `subagent` tool spawning `pi --mode json -p --no-session [--model] [--thinking] [--tools] [--append-system-prompt <tmpfile>] "Task: …"` per invocation; parses the JSON event stream (`message_end`, `tool_result_end`) for streaming updates and usage; single / parallel (max 8, 4 concurrent) / chain (`{previous}`) modes; abort → SIGTERM then SIGKILL after 5 s; agent discovery from `~/.pi/agent/agents/*.md` and `.pi/agents/*.md` with frontmatter (`name, description, tools, model`); confirms project agents in untrusted repos; rich `renderCall/renderResult`. | E, D, I | **Extend** | The subprocess-in-JSON-mode mechanism is the strongest candidate for the worker interface and is the baseline that ADR 0004 (#16) must compare against SDK and RPC. What PLAN §3.E requires and the example lacks: **worker contract** (no budget, elapsed-time, token, or spend limit; no termination criteria; no declared artifacts); **recursion control** (the child inherits every user-level extension including `subagent` itself — nothing prevents a worker spawning workers; PLAN requires explicit opt-in); **process-tree kill** (`proc.kill` signals only the direct child, not its bash descendants); **no cwd/worktree contract** (`cwd` is a free string; PLAN needs one worktree per writing worker and one integration owner); **no pause/resume/restart**, no partial-completion record; **no durable record** (`--no-session` discards the transcript; usage totals exist only in tool details); crash detection is exit code only; agent files hardcode provider models (finding 4) and the shipped `worker` agent has *all* tools, contrary to bounded roles. **Copied with attribution:** `subagent/agents.ts` (frontmatter role loader) → `src/workers/roles.ts`; `mapWithConcurrencyLimit` and the JSON-line stream parser from `subagent/index.ts` → `src/workers/spawn.ts`. The four `agents/*.md` are rewritten (no model names, bounded tools) as `resources/roles/*.md`; the three `prompts/*.md` are replaced by `/korwf plan\|run`. | `workers/` (spawn, stream parser, concurrency, role loader); role definitions in `resources/roles/` | MIT |
| 2 | `plan-mode/` (index.ts, utils.ts, README) | Toggleable read-only mode: `tool_call` gate blocks `edit`/`write` and any `bash` command failing `isSafeCommand` (allowlist of read-only commands + `DESTRUCTIVE_PATTERNS`), injects a planning system prompt via `before_agent_start`, extracts numbered plan steps from assistant text, tracks `[DONE:n]` markers, status-bar widget, `/plan` command, `--plan` flag, Ctrl+Alt+P toggle. | E, C, F | **Extend** | The gate structure is exactly PLAN §4 "tool-call hooks as policy gates (not sandboxing)". Reuse the `isSafeCommand` classifier as *one* input to the execution policy for read-only roles (scout, planner, reviewer, verifier). Missing: it is a **global session toggle**, not a per-worker/per-role policy; it only inspects tools it knows by name, so any custom tool that mutates bypasses it (PLAN §7: "all mutation routes tested"); a text classifier for shell is inherently bypassable (subshells, interpreters, `-exec`) so it must be recorded as a *policy* gate with a documented residual risk (threat model, #17), not as enforcement; **no audit** of blocks; plan extraction from free text and `[DONE:n]` markers are replaced by the durable plan/task store (PLAN §C, §5). **Copied with attribution:** `plan-mode/utils.ts` (`isSafeCommand`, `DESTRUCTIVE_PATTERNS`, `SAFE_COMMANDS`) → `src/security/bash-classifier.ts`; `plan-mode/index.ts` is not copied. | `security/execution-policy` (classifier + gate); `extension/ui` (status widget pattern) | MIT |
| 3 | `sandbox/` (index.ts, package.json) | Replaces the built-in `bash` tool with `createBashTool` wrapped in `@anthropic-ai/sandbox-runtime` (bubblewrap on Linux, seatbelt on macOS); merges config from `~/.pi/agent/extensions/sandbox.json` and `.pi/sandbox.json` (project config only when trusted); `/sandbox` command shows status. | E, J | **Replace** (not bundled) | PLAN §3.E: "Worktrees are change isolation, not security isolation. Restricted execution uses a *separately defined* sandbox." KorWF does not ship a sandbox. Reasons: pulls an Apache-2.0 experimental dependency at `0.0.x` with platform-specific system requirements (`bwrap`) into a package that must load on Linux and macOS with no extra setup (PLAN §J); replacing the built-in `bash` tool is a session-wide side effect a workflow package must not impose; and sandbox setup is an open approval item (TODO §0). What KorWF does instead: the execution policy records whether a sandbox is present (via `pi.getTools()`/tool provenance) and the threat model states the residual risk without one; documentation recommends this example as a *companion* the user installs at user level. **Salvaged:** the two-layer config merge with `ctx.isProjectTrusted()` gating project config, adopted in `config/`. Revisit if PLAN §11 approves a sandbox dependency. | `security/` (presence detection, policy); `config/` (merge pattern) | MIT (example); Apache-2.0 (runtime dep, not adopted) |
| 4 | `todo.ts` | `todo` tool with add/update/delete/list; state lives in each tool result's `details` and is rebuilt by walking the session branch so it is fork/branch-safe; custom rendering. | C | **Replace** | PLAN §C and §5 require plans, phases, tasks with dependencies, ownership, blockers, evidence, approval invalidation, and cross-worker visibility — a durable SQLite store, not per-session, per-branch tool state. Also the tool is model-driven (the model decides to add todos), whereas KorWF tasks are created by the planner phase and gated. **Salvaged:** the *branch-safety idea* — every KorWF tool result that mutates state carries the record id and revision in `details`, so a `/fork` or tree navigation lands on a consistent view; and the `renderCall/renderResult` board layout for `/korwf tasks`. | `workflow/` + `storage/` (records); `extension/ui` (board rendering) | MIT |
| 5 | `git-checkpoint.ts` | On `turn_start` runs `git stash create` and maps the current entry id → stash ref (in memory); on `session_before_fork` offers `git stash apply` of that ref; `agent_settled` marks end of turn. | G, E | **Extend** | PLAN §G: "Checkpoints and approval policy for rollback; preserve uncommitted user work." Same mechanism, but: refs are held in a closure and lost on restart/reload (must be `Checkpoint` records keyed by attempt/task, PLAN §5); `git stash create` excludes untracked files, so a rollback can drop new files — KorWF must include untracked (`git stash create` + `git add -A` on a temporary index, or a commit on a detached ref) and must never touch the user's stash list; checkpoints must be taken per **worktree** (worker) not only in the main tree; restore needs an approval class and a dirty-tree check (row 7) — `stash apply` onto a modified tree can conflict; every checkpoint/restore is audited. | `git/checkpoints`; policy in `workflow/recovery` | MIT |
| 6 | `handoff.ts` | `/handoff <goal>`: serialises the branch (`convertToLlm` + `serializeConversation`), asks the current model (`ctx.modelRegistry.complete`) for a focused prompt using a fixed template, shows it in `ctx.ui.editor`, then `ctx.newSession({ parentSession })` with the edited prompt. | H, D | **Extend** | PLAN §H handoff packets serve three consumers — workers, mid-task model fallback (§D), and resumed sessions — and must be structured: durable decisions, open questions, unresolved commitments (deterministic pins), provenance and source revision. The example produces free text, requires interactive mode, keeps no record, and always spends a model call. KorWF keeps the mechanism (serialise branch → model-written summary → user review when a UI exists → `newSession` with parent link) but: the packet is a typed record stored in SQLite and rendered to text; a **deterministic fallback** builds the packet from records alone when no model call is allowed; Jev assists selection/consistency only when configured; `ctx.newSession` is used for session handoffs, while worker handoffs go through the worker contract (row 1). | `memory/handoff`; command in `extension/` | MIT |
| 7 | `dirty-repo-guard.ts` | On `session_before_switch` / `session_before_fork` runs `git status --porcelain`; if dirty, `ctx.ui.select` continue/cancel; not a repo → allow. | G, E | **Reuse** (adapt) | Directly serves PLAN §G "preserve uncommitted user work" and §E "never uncontrolled integration into the user's tree". Adapt: also invoked before `/korwf run` creates worktrees and before integration into the user's tree; when `ctx.hasUI` is false, **block** instead of allowing (the example's non-UI path is unspecified); result is recorded. **Copied with attribution:** `dirty-repo-guard.ts` (whole file, 56 lines) → `src/git/status.ts` (`hasUncommittedChanges`) and `src/workflow/approvals/dirty-tree.ts` (hook). Licence confirmed MIT (see Licence section). | `git/status`; hooks in `workflow/approvals` | MIT |
| 8 | `permission-gate.ts` | `tool_call` gate on `bash`: regex list (`rm -rf`, `sudo`, `chmod/chown 777`) → `ctx.ui.select` Yes/No; blocks by default when no UI; returns `{ block, reason }`. | E, F (security) | **Extend** | The canonical gate shape (also the worked example in `docs/pi-integration-map.md` §5.1) and the correct non-UI default. Missing vs PLAN §2.6/§7: approval **classes** (auto / queue / stop) driven by mode and config rather than a fixed regex list; coverage of *all* mutation routes (write/edit/custom tools/`pi.exec` in KorWF's own code), not only `bash`; per-worker policy (the gate must know which worker/role issued the call — see ADR 0004); audit record of every prompt, decision, and block; `terminate` semantics for calls that must stop the agent; the guarantee that no code path or Jev result can *weaken* the policy (PLAN §H last bullet). | `security/execution-policy` + `workflow/approvals` | MIT |
| 9 | `protected-paths.ts` | `tool_call` gate on `write`/`edit`: blocks if `path` starts with any of a fixed list (`.env`, `secrets/`, …), notifies. | J, security | **Extend** | Right hook, wrong scope for PLAN §7/§J. Missing: only `write`/`edit` are checked — `bash` redirection, `sed -i`, and custom tools bypass it (PLAN §7 names this explicitly), so the same path list must feed the bash classifier (row 2) and the data-boundary check; no path normalisation (relative vs absolute, `..`, symlinks, worktree roots); list must come from config **privacy lists**, with a shipped safe default; the same lists must also gate `read` and *what leaves the machine* (excerpts sent to Jev/model providers), which the example does not attempt; blocks audited. | `security/data-boundaries` | MIT |
| 10 | `custom-compaction.ts` | `session_before_compact` handler: builds a prompt from all messages, calls `ctx.modelRegistry.complete` on a hardcoded `google/gemini-2.5-flash`, returns `{ compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore } }`; on any error/empty summary returns `undefined` so Pi's default compaction runs. | H | **Extend** | The event contract and the "return undefined to fall back to default compaction" safety are exactly what PLAN §H needs to "integrate with Pi compaction without deleting original evidence". Missing: hardcoded provider/model (finding 4 — must use the session model or a `models/` choice within the allowlist); it discards *all* turns, whereas KorWF keeps Pi's structured summary format and prepends the durable memory packet (pins for required instructions and unresolved commitments, provenance, supersession); no Jev consistency pass; no record of what was compacted (needed for `/korwf why` and replay). The `session_compact` / `session_compact_failed` follow-ups are also handled for observability. | `memory/compaction` | MIT |
| 11 | `git-merge-and-resolve.ts` | On every `agent_end`: if a `MERGE_HEAD` exists re-report conflicts; else fetch upstream and `git merge --no-ff` it; on conflict, parse `git diff --diff-filter=U` conflict blocks (file, line range, ours/theirs) and `pi.sendUserMessage(..., { deliverAs: "followUp" })` so the agent resolves them. | E, F | **Replace** | Its policy is the opposite of PLAN §E: integration happens automatically after *every* turn, directly in the working tree, with no owner, no gate, and no approval. KorWF integration is an explicit step performed by one integration owner in a worktree, followed by integrated checks (PLAN §F) before anything reaches the user's tree. **Salvaged:** the conflict-block parser and the follow-up-message delivery pattern, used by the integrator role to hand a structured conflict report to a worker. | `git/conflicts` (parser); `workflow/integration` (policy) | MIT |
| 12 | `questionnaire.ts` | `questionnaire` tool: model supplies `[{question, options[]}]`; `ctx.ui.custom` renders a multi-step TUI (arrow keys, Enter, Esc); returns answers as text; without UI returns a "requires interactive mode" error. | A, E (approvals) | **Reuse** (adapt) | Fits PLAN §A intake (scope, exclusions, acceptance criteria, autonomy level, budgets) and §2.6 approval queues. Adapt: driven by the **workflow** (KorWF decides the questions), not offered to the model as a free tool; answers are recorded on the intake/approval record; the non-UI path returns a structured "answers needed" result so unattended runs queue or stop per approval class instead of failing; namespaced. **Copied with attribution:** `questionnaire.ts` (the `ctx.ui.custom` component, `renderCall`/`renderResult`) → `src/extension/ui/questionnaire.ts`; the tool registration is not copied. Licence confirmed MIT. | `extension/ui/questionnaire` | MIT |
| 13 | `structured-output.ts` | Registers a tool with `terminate: true` so the agent can end the run on a tool call returning a typed payload, without a trailing model turn. | E, F | **Reuse** (pattern; schema replaced) | Precisely how a worker satisfies its contract's **termination criteria** and returns artifacts/claims (PLAN §E) without an extra paid turn; also how an evaluation run returns machine-readable results (§I). The demo schema is replaced by a per-role `korwf_report` schema (status, claims, evidence references, files changed, open questions) validated in code — Jev later flags unsupported claims against the same record (PLAN §F). **Copied with attribution:** `structured-output.ts` (`registerTool` with `terminate: true` and its `renderResult`) → `src/workers/contracts/report-tool.ts`, with the schema replaced. Licence confirmed MIT. | `workers/contracts` (tool registered in the worker's extension set) | MIT |

**Totals:** Reuse 3 (rows 7, 12, 13) · Extend 7 (rows 1, 2, 5, 6, 8, 9, 10) · Replace 3 (rows 3, 4, 11).

## Consequences

- **Layout.** Five of the thirteen examples (5, 7, 11, plus worktree handling implied
  by 1 and 3) are git operations that PLAN §4's layout has no home for; ADR 0002 adds
  `src/git/`. Reused TUI components (12, boards from 4, widget from 2) get
  `src/extension/ui/`. Role definitions and prompt fragments (from 1) become shipped,
  versioned assets in `resources/`.
- **Worker interface.** Row 1 fixes the baseline for ADR 0004 (#16): the comparison
  matrix must show how each option (subagent-style subprocess, SDK, RPC) meets the
  gaps listed there, in particular recursion control and process-tree kill.
- **Threat model.** Rows 2, 3, 8, 9 each name a residual risk (text classifiers are
  bypassable; no bundled sandbox; gates cover only known tools; path lists need
  normalisation). #17 must list these with mitigations.
- **Attribution.** The first Stage 2 PR that copies example code must add
  `THIRD_PARTY_NOTICES.md` and the header comment described above.
- **No PLAN.md edit.** PLAN §4 already delegates the layout revision to this table;
  ADR 0002 records the revised layout and AGENTS.md §8 mirrors it.

## References

- PLAN.md §3 A–J, §4, §5, §7, §2.6
- `docs/pi-integration-map.md` (#7) — surfaces S4 (tool-call gates), S10 (reload),
  S11 (compaction); §5.1 worked gate example
- `<pi-install>/examples/extensions/*` at Pi 0.86.0; `<pi-install>/package.json`
  (licence); `<pi-install>/docs/extensions.md`, `docs/security.md`
