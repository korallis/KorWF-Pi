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
headers. Line numbers below refer to Pi 0.86.0 and exist so a reviewer can check every
statement against the source. Findings are cross-checked against
`docs/pi-integration-map.md` (#7).

### Decision vocabulary

| Decision | Meaning for KorWF |
|---|---|
| **Reuse** | Copy the example (with attribution) into the module named, adapt names/config, keep its shape. The exact files and line ranges are in the copy manifest below. |
| **Extend** | Adopt the example's *mechanism* (which Pi event/API it uses and how) as the baseline of a KorWF module, then add what PLAN requires. Code is rewritten around the mechanism; fragments may be copied with attribution and are listed in the copy manifest. |
| **Replace** | Do not adopt. KorWF's own module covers the need in a way that the example's design contradicts. Specific fragments may still be salvaged; these are named. |

Nothing is imported by symlink or as a runtime dependency: the examples are not a
published package and are not versioned independently of Pi. "Copy" means a file in
`src/` whose content derives from the example and carries the attribution header.

### Licence

Pi's install tree carries no `LICENSE` file (`find <pi-install> -maxdepth 2 -iname
'LICENSE*'` is empty). The licence is established from three sources that agree:

1. `<pi-install>/package.json` line 98: `"license": "MIT"`; line 97 `"author": "Mario
   Zechner"`; lines 99–102 repository `git+https://github.com/earendil-works/pi.git`,
   directory `packages/coding-agent`.
2. `<pi-install>/README.md` lines 705–707: heading `## License`, body `MIT`.
3. `npm view @earendil-works/pi-coding-agent@0.86.0 license` → `MIT`.

All 13 examples are part of that package and fall under that licence. MIT is compatible
with this project's MIT licence (`LICENSE`, © 2026 Lee Barry). The `sandbox/` example
additionally depends on `@anthropic-ai/sandbox-runtime@0.0.26`
(`sandbox/package.json`), which `npm view` reports as **Apache-2.0** (repository
`anthropic-experimental/sandbox-runtime`); that dependency is *not* adopted (row 3).

**Attribution rule.** Any file that copies or adapts example code must start with a
comment `Adapted from pi <version> examples/extensions/<path> — MIT, © Mario Zechner /
earendil-works`, and the repository must carry a `THIRD_PARTY_NOTICES.md` reproducing
the upstream MIT notice once the first such file lands (Stage 2; tracked in #113).

## Cross-cutting findings (apply to every row)

These gaps recur across the examples and are not repeated in the table:

1. **Nothing is namespaced.** Tools are `todo`, `subagent`, `questionnaire`,
   `structured_output`; commands are `/plan`, `/todos`, `/handoff`, `/sandbox`. PLAN §J
   requires the `korwf` prefix on every command, tool, and storage path.
2. **Nothing is durable.** State lives in closures (`git-checkpoint`, `plan-mode`), in
   tool-result `details` (`todo`), or nowhere. PLAN §5 requires SQLite records with
   revision semantics.
3. **Interactive-only assumptions.** Without a UI the examples either block
   (`permission-gate` line 20–23, `dirty-repo-guard` line 28–31 — the right default),
   skip silently (`git-checkpoint` line 33–36, `plan-mode` line 279), or return an error
   (`questionnaire` line 93–95 and `handoff` line 84–87 require `ctx.mode === "tui"`).
   PLAN §2.6 unattended operation needs an explicit auto/queue/stop class per decision.
4. **Provider and model names are hardcoded** in `custom-compaction.ts` line 28
   (`ctx.modelRegistry.find("google", "gemini-2.5-flash")`) and in every
   `subagent/agents/*.md` frontmatter (`model: claude-haiku-4-5` in `scout.md`,
   `model: claude-sonnet-4-5` in `planner.md`, `reviewer.md`, `worker.md`). PLAN §J
   forbids this in shipped code; all model choices go through `models/` and the allowlist.
5. **No audit trail.** Approvals, blocks, restores, merges, and compactions are not
   recorded anywhere. PLAN §I requires decisions explained from recorded inputs.

## Decision table

Scope areas are PLAN §3 letters (A intake, B context, C planning, D models,
E execution/orchestration, F verification, G recovery, H memory/handoff,
I observability, J packaging). "Home" is the module in ADR 0002 that owns the result.

| # | Example | What it does (as read, with line refs) | Scope | Decision | Rationale · what is missing vs PLAN | Home | Licence |
|---|---|---|---|---|---|---|---|
| 1 | `subagent/` (`index.ts` 1038 lines, `agents.ts` 157 lines, `agents/{scout,planner,reviewer,worker}.md`, `prompts/{scout-and-plan,implement,implement-and-review}.md`) | `subagent` tool that spawns one `pi --mode json -p --no-session` process per task (`index.ts` 300), adding `--model` (303), `--thinking` (305), `--tools` from the agent's frontmatter (307), and `--append-system-prompt <tmpfile>` (338, written to a `pi-subagent-` tmpdir, 240) with the task as the prompt (341). Parses the JSON event stream line by line (357), summing usage from `message_end` (362–375) and streaming `tool_result_end` (384) to `onUpdate`. Modes: single, parallel (max 8 tasks, 4 concurrent — 33–34, 605, 645 via `mapWithConcurrencyLimit`, 219), chain with `{previous}` substitution (450). Abort → `SIGTERM`, then `SIGKILL` after 5 s if not exited (413–416). Agents are discovered from `getAgentDir()/agents/*.md` and the nearest `.pi/agents/` walking up from cwd (`agents.ts` 117–133), with frontmatter `name, description, tools, model`; default scope is `user` (456; restated in the tool description at 478); project agents require `agentScope: "both"|"project"` and, when the project is untrusted and a UI exists, an explicit confirm (520–540). Custom `renderCall`/`renderResult` (723, 767). | E, D, I | **Extend** | The subprocess-in-JSON-mode mechanism is the strongest candidate for the worker interface and is the baseline ADR 0004 (#16) must compare against the SDK and RPC options. What PLAN §3.E requires and the example lacks: **worker contract** (no budget, elapsed-time, token, or spend limit; no termination criteria; no declared artifacts — the process runs until the model stops); **recursion control** (the child is launched without `--no-extensions`, so it loads whatever extensions the user has installed — including this tool if installed — and nothing prevents a worker spawning workers; PLAN requires explicit opt-in); **process-tree kill** (`proc.kill` signals only the direct child, not the bash descendants it may have started); **no cwd/worktree contract** (`cwd` is a free string param, 278/347/445–468; PLAN needs one worktree per writing worker and one integration owner); **no pause/resume/restart** and no partial-completion record; **no durable record** (`--no-session` discards the transcript; usage exists only in tool `details`); crash detection is exit code / stop reason only (183); agent files hardcode models (finding 4) and the shipped `worker.md` has no `tools:` line, i.e. all tools, contrary to bounded roles. **Copied with attribution** (see manifest): the frontmatter role loader from `agents.ts`; `mapWithConcurrencyLimit` and the JSON-line stream parser from `index.ts`. The four `agents/*.md` are rewritten (no model names, bounded tools) as `resources/roles/*.md`; the three `prompts/*.md` are replaced by `/korwf plan` and `/korwf run`. | `workers/` (spawn, stream parser, concurrency, role loader); role definitions in `resources/roles/` | MIT |
| 2 | `plan-mode/` (`index.ts` 390 lines, `utils.ts` 168 lines, `README.md`) | Toggleable read-only mode. On enable, `pi.setActiveTools` removes `edit`/`write` and adds read-only tools (`index.ts` 22–25, 90–113); a `tool_call` gate blocks any `bash` command failing `isSafeCommand` (164–174). `isSafeCommand` (`utils.ts` 97–101) requires the command to match one of `SAFE_PATTERNS` (an anchored allowlist of read-only commands, 44–95) **and** none of `DESTRUCTIVE_PATTERNS` (`rm`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `chown`, editors and more — 7–41). Injects a planning system prompt via `before_agent_start` (201), extracts numbered steps from assistant text and tracks `[DONE:n]` markers (`turn_end`/`agent_end`, 250–262; `utils.ts` 129–168), status via `ctx.ui.setStatus` and a widget via `setWidget` (63–82), `/plan` and `/todos` commands (141, 146), `--plan` flag (53), `Ctrl+Alt+P` shortcut (158). Plan state persists across `session_start` via a custom session entry (340). | E, C, F | **Extend** | The gate is exactly PLAN §4 "tool-call hooks as policy gates (not sandboxing)". KorWF reuses the `isSafeCommand` classifier as *one* input to the execution policy for read-only roles (scout, planner, reviewer, verifier). Missing: it is a **global session toggle**, not a per-worker/per-role policy; it only knows the built-in tools by name — `edit`/`write` are removed from the active set and only `bash` is classified, so any custom tool that mutates is untouched (PLAN §7: "all mutation routes tested"); a regex classifier for shell is inherently bypassable (subshells, interpreters, `find -exec`, redirection) so it must be recorded as a *policy* gate with a documented residual risk (threat model, #17), not as enforcement; **no audit** of blocks; plan extraction from free text and `[DONE:n]` markers are replaced by the durable plan/task store (PLAN §C, §5). **Copied with attribution** (see manifest): `utils.ts` `DESTRUCTIVE_PATTERNS`, `SAFE_PATTERNS`, `isSafeCommand`; `index.ts` is not copied. | `security/execution-policy` (classifier + gate); `extension/ui` (status/widget pattern) | MIT |
| 3 | `sandbox/` (`index.ts` 321 lines, `package.json`) | Replaces the built-in `bash` tool with `createBashTool` wrapped by `@anthropic-ai/sandbox-runtime` (bubblewrap on Linux, sandbox-exec on macOS; `index.ts` 1–10, 209–227). Config is `DEFAULT_CONFIG` ← `~/.pi/agent/extensions/sandbox.json` ← `<cwd>/.pi/sandbox.json`, project taking precedence (79–103, `deepMerge` 105–130); the project file is read **unconditionally** — there is no `ctx.isProjectTrusted()` check anywhere in the file. Events: `user_bash` (229), `session_start` (234), `session_shutdown` (287); `/sandbox` command shows status (297). Header notes the alternative of mutating `tool_call` input instead of replacing the tool (8–10). | E, J | **Replace** (not bundled) | PLAN §3.E: "Worktrees are change isolation, not security isolation. Restricted execution uses a *separately defined* sandbox." KorWF does not ship a sandbox: it would pull an Apache-2.0 experimental `0.0.x` dependency with OS-level prerequisites (`bwrap`) into a package that must load on Linux and macOS with no extra setup (PLAN §J); replacing the built-in `bash` tool is a session-wide side effect a workflow package must not impose; and sandbox setup is an open approval item (TODO §0). What KorWF does instead: the execution policy records whether a sandboxing tool override is present (`pi.getAllTools()` metadata, extensions.md "pi.getActiveTools() / pi.getAllTools()") and the threat model states the residual risk without one; docs recommend this example as a *companion* the user installs at user level. **Salvaged (pattern only, no code copy):** the defaults → global → project layered merge shape in `config/` — with the trust gate the example lacks: KorWF applies a project-level file only when `ctx.isProjectTrusted()` is true. Revisit if PLAN §11 approves a sandbox dependency. | `security/` (presence detection, policy); `config/` (merge pattern) | MIT (example); Apache-2.0 (runtime dep, not adopted) |
| 4 | `todo.ts` (297 lines) | `todo` tool with actions `list`, `add`, `toggle`, `clear` (32, 143–210); `/todos` command renders the list in a `ctx.ui.custom` overlay (284–292). State lives only in each tool result's `details` (`{action, todos, nextId}`) and is rebuilt by walking `ctx.sessionManager.getBranch()` (118–126), so a fork or tree navigation sees the todo state of that point in history (header 8–10). Custom `renderCall`/`renderResult` (221, 228). | C | **Replace** | PLAN §C and §5 require plans, phases, tasks with dependencies, ownership, blockers, evidence, approval invalidation, and cross-worker visibility — a durable SQLite store, not per-session, per-branch tool state. Also the tool is model-driven (the model decides to add todos), whereas KorWF tasks are created by the planner phase and gated. **Salvaged (idea only):** every KorWF tool result that mutates state carries the record id and revision in `details`, so a `/fork` or tree navigation lands on a consistent view; and the board layout of `renderResult` informs `/korwf tasks`. | `workflow/` + `storage/` (records); `extension/ui` (board rendering) | MIT |
| 5 | `git-checkpoint.ts` (53 lines) | On `tool_result` records the current leaf entry id (15–18); on `turn_start` runs `git stash create` and maps that entry id → stash ref in an in-memory `Map` (20–27); on `session_before_fork`, if a ref exists for the fork point and a UI exists, offers `git stash apply <ref>` (29–46; without a UI it does nothing, 33–36); on `agent_settled` clears the map (49–52). | G, E | **Extend** | PLAN §G: "Checkpoints and approval policy for rollback; preserve uncommitted user work." Same mechanism, but: refs live in a closure that is cleared after every agent run and lost on reload (must be `Checkpoint` records keyed by attempt/task, PLAN §5); `git stash create` excludes untracked files, so a rollback can drop newly created files — KorWF must include untracked (temporary index + `git add -A`, or a commit on a detached ref) and must never touch the user's stash list; checkpoints must be taken per **worktree** (worker), not only in the main tree; restore needs an approval class and a dirty-tree check (row 7) — `stash apply` onto a modified tree can conflict; every checkpoint/restore is audited. | `git/checkpoints`; policy in `workflow/recovery` | MIT |
| 6 | `handoff.ts` (190 lines) | `/handoff <goal>` command (81): requires `ctx.mode === "tui"` and a selected model (84–92); serialises the branch with `convertToLlm` + `serializeConversation` (110–111); inside a `ctx.ui.custom` `BorderedLoader` asks the *current* model (`ctx.modelRegistry.complete(ctx.model, …)`, 131–140) for a focused prompt using a fixed `SYSTEM_PROMPT` (20); shows it in `ctx.ui.editor` (167); then `ctx.newSession({ parentSession })` with the edited prompt (177–185). | H, D | **Extend** | PLAN §H handoff packets serve three consumers — workers, mid-task model fallback (§D), and resumed sessions — and must be structured: durable decisions, open questions, unresolved commitments (deterministic pins), provenance and source revision. The example produces free text, requires the TUI, keeps no record, and always spends a model call. KorWF keeps the mechanism (serialise branch → model-written summary → user review when a UI exists → `newSession` with parent link) but: the packet is a typed record stored in SQLite and rendered to text; a **deterministic fallback** builds the packet from records alone when no model call is allowed; Jev assists selection/consistency only when configured; `ctx.newSession` is used for session handoffs, while worker handoffs go through the worker contract (row 1). | `memory/handoff`; command in `extension/` | MIT |
| 7 | `dirty-repo-guard.ts` (56 lines) | On `session_before_switch` (48) and `session_before_fork` (53) runs `git status --porcelain` (16); exit code ≠ 0 (not a repo) → allow (18–21); clean → allow (23–26); dirty and no UI → `{ cancel: true }` (28–31); dirty with UI → `ctx.ui.select` "Yes, proceed anyway" / "No, let me commit first", cancelling unless the user proceeds (36–45). | G, E | **Reuse** (adapt) | Directly serves PLAN §G "preserve uncommitted user work" and §E "never uncontrolled integration into the user's tree", and its non-UI default (block) is already the one PLAN §2.6 wants. Adapt: also invoked before `/korwf run` creates worktrees and before integration into the user's tree; the prompt becomes an approval-class decision (auto/queue/stop by mode) instead of a fixed select; the result is recorded; message text and hook names are namespaced. **Copied with attribution** (see manifest): the whole file. | `git/status`; hooks in `workflow/approvals` | MIT — confirmed (Licence section) |
| 8 | `permission-gate.ts` (34 lines) | `tool_call` gate on `bash` (13–17): regex list `rm -rf`/`--recursive`, `sudo`, `chmod|chown … 777` (11); match with no UI → `{ block: true }` (20–23); with UI → `ctx.ui.select` Yes/No and block on No (25–29). | E, F (security) | **Extend** | The canonical gate shape (also the worked example in `docs/pi-integration-map.md` §5.1) and the correct non-UI default. Missing vs PLAN §2.6/§7: approval **classes** (auto / queue / stop) driven by mode and config rather than a fixed regex list; coverage of *all* mutation routes (`write`/`edit`/custom tools/`pi.exec` in KorWF's own code), not only `bash`; per-worker policy (the gate must know which worker/role issued the call — ADR 0004); audit record of every prompt, decision, and block; `terminate` semantics for calls that must stop the agent; the guarantee that no code path or Jev result can *weaken* the policy (PLAN §7 execution policy). | `security/execution-policy` + `workflow/approvals` | MIT |
| 9 | `protected-paths.ts` (30 lines) | `tool_call` gate that ignores every tool except `write`/`edit` (14–16); blocks when `event.input.path` *contains* (`String.prototype.includes`, 19) any of the fixed list `[".env", ".git/", "node_modules/"]` (11); notifies only when a UI exists (22–24); returns `{ block: true, reason }` (25). | J, security | **Extend** | Right hook, wrong scope for PLAN §7/§J. Missing: only `write`/`edit` are checked — `bash` redirection, `sed -i`, and custom tools bypass it (PLAN §7 names this explicitly), so the same path list must feed the bash classifier (row 2) and the data-boundary check; substring matching over-blocks (`my.env.example`, any path with `.git/` in a parent) and under-blocks (no normalisation of relative vs absolute, `..`, symlinks, worktree roots); the list must come from config **privacy lists** with a shipped safe default; the same lists must also gate `read` and *what leaves the machine* (excerpts sent to Jev/model providers), which the example does not attempt; blocks audited. | `security/data-boundaries` | MIT |
| 10 | `custom-compaction.ts` (117 lines) | `session_before_compact` handler (21): takes `messagesToSummarize`, `turnPrefixMessages`, `tokensBefore`, `firstKeptEntryId`, `previousSummary` from `event.preparation` (25); looks up a hardcoded `google/gemini-2.5-flash` and returns `undefined` if absent (28–32); serialises the messages, prepends the previous summary, and asks the model for a free-text summary under a fixed rubric (43–88); empty summary or any thrown error → `undefined` so Pi's default compaction runs (95–98, 110–115); otherwise returns `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage } }` (102–109), so the recent messages Pi selected are kept. | H | **Extend** | The event contract and the "return `undefined` to fall back to default compaction" safety are exactly what PLAN §H needs to "integrate with Pi compaction without deleting original evidence". Missing: hardcoded provider/model (finding 4 — must use the session model or a `models/` choice within the allowlist); its summary is unstructured free text, whereas KorWF keeps Pi's structured summary format (S11) and prepends the durable memory packet (pins for required instructions and unresolved commitments, provenance, supersession); no Jev consistency pass; no record of what was compacted (needed for `/korwf why` and replay). The `session_compact` / `session_compact_failed` follow-ups are also handled for observability. | `memory/compaction` | MIT |
| 11 | `git-merge-and-resolve.ts` (115 lines) | On every `agent_end` (74): if `MERGE_HEAD` exists, re-report the unfinished merge (81–82); otherwise, only when the working tree is clean (84–85) and an upstream is configured (87–93), `git fetch <remote>` (99) then `git merge --no-ff @{u}` (105); on conflict, lists unmerged files via `git diff --name-only --diff-filter=U` and scans each file for `<<<<<<<`/`=======`/`>>>>>>>` markers to build `{file, startLine, separatorLine, endLine}` blocks (27–54); formats ours/theirs ranges (56–71) and delivers them with `pi.sendUserMessage(…, { deliverAs: "followUp" })` so the agent resolves them (113). | E, F | **Replace** | Its policy is the opposite of PLAN §E: integration happens automatically after *every* agent run, directly in the working tree, with no owner, no gate, and no approval. KorWF integration is an explicit step performed by one integration owner in a worktree, followed by integrated checks (PLAN §F) before anything reaches the user's tree. **Salvaged (pattern; rewritten in `git/`):** the conflict-block scanner and the follow-up-message delivery, used by the integrator role to hand a structured conflict report to a worker. | `git/conflicts` (parser); `workflow/integration` (policy) | MIT |
| 12 | `questionnaire.ts` (448 lines) | `questionnaire` tool (85): the model supplies `questions[{id, label?, prompt, options[{value, label, description?}], allowOther?}]` (52–72); requires `ctx.mode === "tui"`, else returns an error result (93–95); `ctx.ui.custom` renders a single-question list or a tab-based multi-question TUI with up/down/enter/esc, tab/shift-tab/left/right between questions, and a free-text "Type something" option (110–394); returns the answers as text lines plus `details: {questions, answers, cancelled}` (396–414); custom `renderCall`/`renderResult` (417, 429). | A, E (approvals) | **Reuse** (adapt) | Fits PLAN §A intake (scope, exclusions, acceptance criteria, autonomy level, budgets) and §2.6 approval queues. Adapt: driven by the **workflow** (KorWF decides the questions), not offered to the model as a free tool; answers are recorded on the intake/approval record; the non-TUI path returns a structured "answers needed" result so unattended runs queue or stop per approval class instead of failing; namespaced. **Copied with attribution** (see manifest): the schema types and the `ctx.ui.custom` component; the `pi.registerTool` block is not copied. | `extension/ui/questionnaire` | MIT — confirmed (Licence section) |
| 13 | `structured-output.ts` (65 lines) | `defineTool` (18) named `structured_output` with `promptSnippet`/`promptGuidelines` telling the model to call it last (23–27), a typed `{headline, summary, actionItems[]}` schema (28–32), and `terminate: true` in its result (42) so the agent run ends on the tool call without a trailing model turn; `renderResult` prints the payload (46–60). | E, F | **Reuse** (pattern; schema replaced) | Precisely how a worker satisfies its contract's **termination criteria** and returns artifacts/claims (PLAN §E) without an extra paid turn; also how an evaluation run returns machine-readable results (§I). The demo schema is replaced by a per-role `korwf_report` schema (status, claims, evidence references, files changed, open questions) validated in code — Jev later flags unsupported claims against the same record (PLAN §F). **Copied with attribution** (see manifest): the whole file, with `name`, `parameters`, `details`, and `renderResult` replaced. | `workers/contracts` (tool registered in the worker's extension set) | MIT — confirmed (Licence section) |

**Totals:** Reuse 3 (rows 7, 12, 13) · Extend 7 (rows 1, 2, 5, 6, 8, 9, 10) · Replace 3 (rows 3, 4, 11) · Ignore 0.

## Copy manifest

Every file that will be copied or adapted from an example, the target it lands in, and
its licence. Reviewers of Stage 2 PRs check the attribution header against this table.
Rows 3, 4, and 11 salvage *patterns* only and copy no code.

| Row | Decision | Source (`<pi-install>/examples/extensions/…`) | Lines | Target in `src/` | Licence |
|---|---|---|---|---|---|
| 7 | Reuse | `dirty-repo-guard.ts` | 1–56 (whole file) | `git/status.ts` (`hasUncommittedChanges`, lines 14–26) and `workflow/approvals/dirty-tree.ts` (hook, lines 28–56) | MIT |
| 12 | Reuse | `questionnaire.ts` | 1–82 (imports, types, schema, `errorResult`) and 110–394 (`ctx.ui.custom` component) | `extension/ui/questionnaire.ts` | MIT |
| 13 | Reuse | `structured-output.ts` | 1–65 (whole file; schema and names replaced) | `workers/contracts/report-tool.ts` | MIT |
| 1 | Extend (fragment) | `subagent/agents.ts` | 1–157 (frontmatter role loader; `parseToolList`, `loadAgentsFromDir`, `findNearestProjectAgentsDir`, `discoverAgents`) | `workers/roles.ts` | MIT |
| 1 | Extend (fragment) | `subagent/index.ts` | 219–237 (`mapWithConcurrencyLimit`) and 342–425 (spawn + JSON-line parse + abort inside `runSingleAgent`) | `workers/spawn.ts` | MIT |
| 2 | Extend (fragment) | `plan-mode/utils.ts` | 1–101 (`DESTRUCTIVE_PATTERNS`, `SAFE_PATTERNS`, `isSafeCommand`) | `security/bash-classifier.ts` | MIT |

Everything else in the examples is either replaced by KorWF code or rewritten from the
mechanism described in the table without copying.

## Consequences

- **Layout.** Rows 5, 7, and 11 are git operations, and rows 1 and 3 imply worktree
  handling; PLAN §4's layout has no home for git, so ADR 0002 adds `src/git/`. Reused
  TUI components (row 12, the board pattern from row 4, the widget pattern from row 2)
  get `src/extension/ui/`. Role definitions (row 1) become shipped, versioned assets in
  `resources/`.
- **Worker interface.** Row 1 fixes the baseline for ADR 0004 (#16): the comparison
  matrix must show how each option (subagent-style subprocess, SDK, RPC) meets the
  gaps listed there, in particular recursion control and process-tree kill.
- **Threat model.** Rows 2, 3, 8, 9 each name a residual risk (regex classifiers are
  bypassable; no bundled sandbox; gates cover only known tools; path matching needs
  normalisation). #17 must list these with mitigations.
- **Attribution.** The first Stage 2 PR that copies code from the manifest must add
  `THIRD_PARTY_NOTICES.md` and the header comment described above (#113).
- **No PLAN.md edit.** PLAN §4 already delegates the layout revision to this table;
  ADR 0002 records the revised layout and AGENTS.md §8 mirrors it.

## References

- PLAN.md §3 A–J, §4, §5, §7, §2.6
- `docs/pi-integration-map.md` (#7) — surfaces S4 (tool-call gates), S10 (reload),
  S11 (compaction); §5.1 worked gate example
- `<pi-install>/examples/extensions/*` at Pi 0.86.0; `<pi-install>/package.json`
  (licence); `<pi-install>/README.md` "License"; `<pi-install>/docs/extensions.md`,
  `docs/security.md`
