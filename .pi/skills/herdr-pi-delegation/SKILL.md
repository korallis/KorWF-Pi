---
name: herdr-pi-delegation
description: ALWAYS load at the start of every pi session (HERDR_ENV=1 is set). Pi always runs inside Herdr, a terminal multiplexer for coding agents. There are NO sub-agents here; delegation means starting a new pi session in a Herdr pane with the chosen mac-mini model (e.g. gpt-6-astra, kimi-k3) so it appears as a named agent in Herdr's Agents panel, prompting it, and reading its result back. Use for any delegation, parallel work, second opinion, worker, reviewer, background command, per-issue worktree, reading an image/screenshot when the current model has no vision, or when Jev/the orchestrator picks a model for a task. Covers Herdr concepts, agent lifecycle states, sidebar nesting of worker Spaces under the project (git-worktree grouping), Agents-panel labelling, model selection, and cleanup rules.
---

# Herdr + pi delegation

Pi is always launched inside Herdr on this machine. Herdr is a tmux-like server that
owns real terminal processes, detects coding agents inside panes, and shows every
agent's state in its **Agents panel** (sidebar). **A "sub-agent" is a new pi session in
a Herdr pane, started with `herdr agent start --kind pi`.** Nothing else spawns agents.

Verified 2026-09-21 against herdr 0.8.2 / pi 0.86 (docs: herdr.dev/llms.txt, pinned
`v0.8.2` sources). Reference copies live in [references/](references/).

## 0. Rules learned the hard way — read before touching layout

Each line below is a mistake that has actually been made here. Do not repeat them.

1. **`workspace create --cwd <path-inside-repo>` does NOT nest the Space under the
   project.** It sets `worktree: null` and leaves a stray top-level Space. For work on
   this repo use `herdr worktree open --path <existing>` or `herdr worktree create
   --branch <b>`. Always verify: `herdr workspace get <id> | jq -c
   '.result.workspace.worktree'` must not be `null`. (§1.1)
2. **Closing a tab or workspace kills every agent inside it.** A tidy-up
   `herdr tab close` once killed a running worker mid-task. Only ever close via
   `stop-pi.sh`, and only the pane/Space that spawn-pi.sh reported creating.
3. **Do not create a Space just so an agent is "visible".** The Agents panel lists
   every agent in every pane already. Spaces are for isolated *checkouts*, not for
   visibility.
4. **Do not invent CLI flag combinations.** `herdr pane move` accepts `--tab <id>
   --split right|down`, `--new-tab`, or `--new-workspace` — there is no
   `--workspace ID --target-pane ID` form. Run `herdr <group> <cmd> --help` before
   using any combination you have not used before in this session.
5. **Do not restructure Lee's pane or tab.** Default to a pane split of the calling
   pane, or a worktree Space. Never rearrange his layout to suit a worker.
6. **If the current model cannot read an image, delegate instead of guessing.** Only
   GPT models on `mac-mini` advertise image input. (§5)
7. **Verify a claim before reporting it.** An ad-hoc `diff`/`grep` check can be wrong
   (e.g. comparing fenced blocks with mismatched fence markers reported a false
   difference). Re-check by a second method before telling Lee something failed.

## 0.1 Preconditions (once per session, silently)

```bash
test "${HERDR_ENV:-}" = 1 && printf 'pane=%s tab=%s ws=%s\n' "$HERDR_PANE_ID" "$HERDR_TAB_ID" "$HERDR_WORKSPACE_ID"
```

- Not `1` → say you are not inside Herdr; delegate with
  `pi --provider mac-mini --model <id> --no-session -p "..."` instead. Never control a
  Herdr session from outside it.
- Model policy: `~/.pi/agent/skills/mac-mini-models/SKILL.md`. **Only `mac-mini`**,
  always `--provider mac-mini --model <id>`. Read it before picking a model/thinking.
- Syntax authority is the binary: `herdr agent`, `herdr pane`, `herdr workspace`,
  `herdr tab`, `herdr worktree` (group name alone prints usage). Never run bare
  `herdr` (it launches the TUI; nested launches are blocked anyway).
- Hard rules: never `herdr server stop`; never kill the Herdr process; never close
  panes/tabs/workspaces you did not create; never close the calling pane.

## 1. Herdr concept model (what the Agents panel shows)

| Herdr object | ID form | Meaning |
|---|---|---|
| Session | name | server namespace; you are in `default` |
| Workspace ("Space") | `w1` | project-level container; one per repo/task/worktree; sidebar rolls agent state up to it |
| Tab | `w1:t1` | a layout inside a workspace (`agents`, `tests`, `logs`…) |
| Pane | `w1:p3` | a real terminal; split `right`/`down`; survives detach |
| Agent | name or pane id | the recognised process in a pane; **this is what the Agents panel lists** |

Agent lifecycle states (semantic, drive waits/notifications/rollups):

| State | Meaning |
|---|---|
| `working` | agent is running a turn |
| `blocked` | approval/question UI detected — needs a decision |
| `done` | finished, **not yet viewed** in the UI (CLI reads don't clear it) |
| `idle` | ready for input and has been seen |
| `unknown` | present but unclassified; not proof of success |

For pi the state authority is the installed pi integration
(`~/.pi/agent/extensions/herdr-agent-state.ts`, lifecycle hooks; `herdr integration
status` must say `pi: current`). Screen detection is skipped for pi
(`screen_detection_skipped: true`).

### 1.1 Sidebar nesting — how workers appear "under" the project

The sidebar shows Spaces, then Agents (labelled `grouped` when
`ui.agent_panel_sort = "spaces"`, the default). Worker Spaces indent under their
project parent with tree glyphs:

```
spaces
 ● KorWF-Pi              <- primary checkout (is_linked_worktree: false) = parent
   ├ · issue-8            <- linked worktree Spaces, same repo_key = children
   └ · issue-12
agents                grouped
 ● KorWF-Pi
     pi
 ● issue-8
     pr114-audit
```

From `workspace_list_entries_inner` (v0.8.2), Spaces group **only** when all hold:

1. they share a `worktree.repo_key` (e.g. `<repo-root>/.git`);
2. the group has ≥ 2 member Spaces;
3. at least one member is the **primary** checkout (`is_linked_worktree: false`) — that
   one becomes the parent. Linked worktrees alone never form a parentless group.

**Therefore: `workspace create --cwd <path>` does NOT nest.** It yields
`worktree: null` and a stray top-level Space, even when the path is inside the repo.
Use `herdr worktree create` (new branch) or `herdr worktree open --path <existing>`
— both set the `worktree` link, so the Space indents automatically. Verify with:

```bash
herdr workspace get <id> | jq -c '.result.workspace.worktree'   # must not be null
```

Child labels come from the branch (`grouped_child_display_label` strips `worktree/`)
unless the Space has a custom name. Parent rows roll up the **worst** child state
(blocked > done-unseen > working > idle) and can be collapsed.

**Agents panel row** (default `ui.sidebar.agents.rows = [["state_icon","workspace","tab"],["agent"]]`).
The `agent` token resolves, in order: `display_agent` metadata → the **agent name** you
gave `agent start` → the kind label ("Pi"). So unnamed manual launches show as "Pi";
named workers show their name. Extra `$tokens` (e.g. `$model`, `$task`) can be added to
rows in `~/.config/herdr/config.toml` if Lee wants them visible.

## 2. Vocabulary mapping

| Orchestration term | Herdr reality |
|---|---|
| sub-agent / worker / reviewer | pi in a Herdr pane via `herdr agent start <name> --kind pi` |
| "Jev picked GPT Astra" | `-- --provider mac-mini --model gpt-6-astra --thinking <lvl>` |
| "use K3" | `-- --provider mac-mini --model kimi-k3` (or `kimi-k3-256k`) |
| worker name in the Agents panel | the `<name>` argument (`[a-z][a-z0-9_-]{0,31}`, unique among live agents) |
| worker task label | `herdr pane report-metadata <pane> --title "<task>" --display-agent "<name · model>"` |
| send task | `herdr agent prompt <name> "<text>" --wait --timeout <ms>` |
| collect result | `herdr agent read <name> --source recent-unwrapped --lines N`, or a result file |
| worker finished | `agent_status` `done`/`idle`; `blocked` = it is asking something |
| per-issue branch / isolated checkout | `herdr worktree create --branch issue-<n>-<slug>` → new workspace |
| background command (tests, server) | `herdr pane split` + `herdr pane run` — **not** an agent |

## 3. Standard recipe — use the helper

```bash
S=.pi/skills/herdr-pi-delegation/scripts
$S/spawn-pi.sh <name> <model-id> [thinking] [placement] [--task TEXT] [--ephemeral] [-- pi args]
```

**Placement decides whether the worker nests under the project in the sidebar.**
See §1.1 — nesting is by *git worktree*, never by cwd or label.

| Flag | Result | Use when |
|---|---|---|
| `--worktree BRANCH [--base REF]` | new worktree + Space, **nested under the repo** | worker owns an issue branch (repo AGENTS.md rule) |
| `--open-worktree PATH` | Space for an existing worktree, **nested** | worktree already exists (e.g. `../korwf-worktrees/issue-8`) |
| *(default)* / `--dir right\|down` | pane in the current tab | short helper on the current checkout |
| `--new-tab LABEL` | new tab in current workspace | grouping several helpers off Lee's tab |
| `--new-workspace LABEL` | **top-level, un-nested** Space | genuinely unrelated repo / long-lived only |
| `--pane ID` | reuse an existing idle shell pane | pane already exists |

All of these appear in the Agents panel regardless of placement — a separate Space is
not needed for visibility, only for an isolated checkout.

Examples:

```bash
$S/spawn-pi.sh astra-review gpt-6-astra high --task "review PR #12"               # pane here
$S/spawn-pi.sh issue-14 gpt-5.6-sol high --worktree issue-14-model-cards --task "issue #14"
$S/spawn-pi.sh pr114-audit gpt-6-astra high --open-worktree ../korwf-worktrees/issue-8
```

Output JSON: `{name, pane_id, workspace_id, tab_id, status, model, thinking, created:{kind,id}, argv}`.
`argv` proves the mac-mini flags reached pi. The helper also sets Agents-panel
presentation (`display_agent = "<name> · <model>"`, `title = task`, tokens `model`,
`thinking`, `task`, `spawned_by`).

Then:

```bash
herdr agent prompt astra-review "$(cat <<'EOF'
<self-contained task: goal, files, constraints, exactly what to return>
EOF
)" --wait --timeout 600000
herdr agent read astra-review --source recent-unwrapped --lines 200
$S/stop-pi.sh astra-review --close pane      # or --close tab | --close workspace | omit to keep
```

`--ephemeral` adds `--no-session`; omit it so Herdr can **restore** the worker's pi
session after a server restart (`session.resume_agents_on_restore = true`).

### Manual equivalent (when the helper does not fit)

```bash
NEW=$(herdr pane split --current --direction right --cwd "$PWD" --no-focus | jq -r .result.pane.pane_id)
herdr agent start reviewer --kind pi --pane "$NEW" --timeout 60000 -- --provider mac-mini --model gpt-6-astra --thinking high
herdr pane report-metadata "$NEW" --source pi:orchestrator --agent pi --display-agent "reviewer · gpt-6-astra" --title "review #12" --token model=gpt-6-astra
```

Creation responses carry the IDs to use next: `workspace create` → `.result.workspace`,
`.result.tab`, `.result.root_pane`; `tab create` → `.result.tab`, `.result.root_pane`;
`pane split` → `.result.pane`; `worktree create` → same as workspace plus
`.result.workspace.worktree.checkout_path`. **Always parse IDs from JSON**; never guess.

`agent start` needs a pane sitting at an interactive shell prompt; it never creates
layout. It returns once pi is `idle`/`interactive_ready` (default 30 s; `--timeout`
3001–300000 ms). `agent_not_ready` means it went `blocked` during startup.

## 4. Prompting, waiting, reading

- `agent prompt --wait` returns at the first settled `idle`/`done`/`blocked`. Add
  `--until blocked` only for "wait until it asks me something". Check
  `.result.agent.agent_status`.
- `agent_prompt_stalled`: no lifecycle change within 5 s → `agent get`/`read` it.
- `agent_blocked` on prompt: pi is showing an approval/question. Inspect with
  `herdr agent read <name> --source visible`. Answer with `herdr agent send-keys <name> enter|esc|y|ctrl+c`
  only if trivially safe; otherwise escalate to Lee.
- Reading: `--source recent-unwrapped` for transcripts; `visible` for the current
  screen; `--format ansi` only when colours are evidence. Output is plain text, not
  JSON. If the answer scrolled out of reach, prompt: *"Write your complete answer as
  Markdown to /tmp/<name>-result.md and reply only with the path"* and read the file.
  Do not ask for a file in the first prompt.
- `done` stays lit in the sidebar until Lee views it or you `herdr agent focus <name>`.
  Don't focus unless Lee wants context switched.
- Multiple workers: `herdr agent wait <name> --timeout MS` each, or poll
  `herdr agent list | jq -c '.result.agents[] | {name, agent_status, workspace_id}'`.
- Notify Lee on long completions: `herdr notification show "<title>" --body "<text>" --sound done`.

## 5. Choosing model and thinking

Read the `mac-mini-models` skill table. Rough guide: `gpt-6-astra` (deep
review/planning; no `off`), `gpt-5.5`/`gpt-5.6-*` (general coding), `kimi-k3` /
`kimi-k3-256k` (long context, bulk edits), `claude-sonnet-5` (fast triage),
`claude-opus-5`/`claude-fable-5-1` (careful review), `zai-glm-5.3`, `grok-4.5`.
Pick per task; do not blindly inherit `$PI_MODEL`. Name workers after role+model
where helpful (`astra-review`, `k3-tests`) — the name is what Lee sees in the panel.

**Capability-driven delegation.** If the current session cannot do something another
mac-mini model can, spawn a worker rather than guessing or refusing:

| Need | Action |
|---|---|
| read an image / screenshot / diagram | only **GPT** models advertise image input — spawn `gpt-5.5`/`gpt-6-astra` and ask it to `read` the file and transcribe it literally |
| very large file or transcript | `kimi-k3-256k` |
| independent second opinion | a *different* family from the one that produced the work |

For screenshots, ask for an exhaustive literal transcription (text, indentation,
glyphs, colours, sections) and explicitly say "do not guess at meaning beyond what is
visible" — then interpret it yourself.

## 6. Layout hygiene

- **Worker on an issue branch → a worktree Space** so it nests under the project
  (§1.1). Short helper on the current checkout → just a pane. Don't create top-level
  Spaces for work that belongs to this repo.
- Always `--no-focus`; never restructure the pane/tab Lee is working in beyond an
  agreed split.
- **Never close a tab or workspace to clean up a worker** — closing a tab kills every
  agent in it (this has happened: closing a tab killed a running worker). Use
  `stop-pi.sh <name> --close pane|workspace`, which resolves that agent's own
  pane/Space. If a worker must be relocated, `herdr pane move <pane> --new-workspace
  --label <name> --no-focus` keeps the process alive (the pane id changes — read it
  from `.result.move_result.pane.pane_id`, then re-apply `report-metadata`).
- `herdr pane move` syntax is one of: `--tab <id> --split right|down`, `--new-tab`, or
  `--new-workspace`. There is no `--workspace ID --target-pane ID` form.
- Different repo/branch or long-lived worker → worktree Space so the sidebar
  rollup is per project. `herdr worktree create` checks out under
  `~/.herdr/worktrees/<repo>/<branch>` unless `--path`; `herdr worktree remove
  --workspace ID` deletes the checkout (`--force` if dirty). Never deletes the branch.
- Cleanup: `stop-pi.sh <name> [--close pane|tab|workspace]`. Only close what you
  created (`created.kind/id` from spawn output). Leave the pane open when Lee may want
  to inspect the worker, and say so.

## 7. Ordinary commands (tests, builds, servers)

Not agents — don't `agent start` them:

```bash
NEW=$(herdr pane split --current --direction down --cwd "$PWD" --no-focus | jq -r .result.pane.pane_id)
herdr pane run "$NEW" "npm test"
herdr pane wait-output "$NEW" --regex 'passed|failed|exit' --timeout 300000
herdr pane read "$NEW" --source recent-unwrapped --lines 150
herdr pane close "$NEW"
```

Use `bash` directly for short commands; use a pane when output is long, long-running,
interactive, or Lee should see it live.

## 8. Reporting back to Lee

State worker name, model, thinking, pane/workspace id, and whether it is still open.
Summarise the result and quote key lines. Tell Lee the Agents panel entry name so he
can click straight to it.

## 9. Failure modes

| Symptom | Action |
|---|---|
| `agent_not_ready` on start | pane not at a shell prompt or pi blocked at startup; `pane read` it |
| `agent_prompt_stalled` | `agent get`/`read`; may be `blocked` or an input focus issue |
| `agent_blocked` on prompt | resolve/escalate the dialog first (§4) |
| `agent_not_idle` on a big `--lines` read | wait for idle, or use `--source visible` |
| proxy/model error inside the worker | report it; **never** restart with a non-mac-mini provider |
| name collision | `herdr agent list`; choose another name or `agent rename` |
| worker shows as "Pi" not its name | it was started without `agent start`; `herdr agent rename <pane> <name>` |
| worker Space sits at top level instead of nested | it was made with `workspace create`; recreate with `worktree open/create` (§1.1) — `pane move` cannot add a worktree link |
| a worker vanished during cleanup | a tab/workspace close killed it; only use `stop-pi.sh` (§0 rule 2) |
| `usage: herdr pane move ...` printed | invented flag combination; read `--help` (§0 rule 4) |
| current model cannot read an image | delegate to a GPT worker (§5) |
| integration missing (`herdr integration status`) | tell Lee to run `herdr integration install pi`; states will fall back to `unknown` |
| helper closed layout on failed start | intended; re-run after fixing the cause |

References: [references/herdr-cli.md](references/herdr-cli.md) (upstream `herdr --skill`),
[references/agent-automation.md](references/agent-automation.md),
[references/agents.md](references/agents.md), [references/cli-reference.md](references/cli-reference.md).
Refresh after `herdr update`: `scripts/refresh-references.sh`.
