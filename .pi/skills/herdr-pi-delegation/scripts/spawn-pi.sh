#!/usr/bin/env bash
# Spawn a pi "sub-agent" in a Herdr pane using the mac-mini provider, so it shows
# up in Herdr's Agents panel with a meaningful name, model, and task.
#
# Usage:
#   spawn-pi.sh <name> <model-id> [thinking] [placement] [--task TEXT] [--ephemeral] [-- <extra pi args>]
#
#   name       unique live agent name: [a-z][a-z0-9_-]{0,31}   (shown in the Agents panel)
#   model-id   mac-mini model id (see ~/.pi/agent/skills/mac-mini-models/SKILL.md)
#   thinking   off|minimal|low|medium|high|xhigh|max (default: medium)
#
# Placement (pick one; DEFAULT = a pane in the current tab).
# Herdr nests Spaces in the sidebar ONLY by git worktree: a Space groups under the
# repo's primary-checkout Space when it shares the repo_key. So to get a worker that
# appears indented under the project (the "sub" rows with tree glyphs), use --worktree
# or --open-worktree, NOT --new-workspace (which makes a parentless top-level Space).
#   --dir right|down          split the calling pane [default: auto right/down]
#   --pane ID                 use an existing idle shell pane (no split)
#   --new-tab LABEL           new tab in the current workspace, agent in its root pane
#   --worktree BRANCH         NEW git worktree + Space -> nests under the repo parent
#   --open-worktree PATH      Space for an EXISTING worktree -> nests under the repo parent
#   --new-workspace LABEL     standalone top-level Space (unrelated repo / long-lived only)
#   --path PATH               checkout path for --worktree (default: herdr's worktrees dir)
#   --base REF                base ref for a new --worktree branch
#
# Other:
#   --task TEXT      pane title + $task token; also folded into the display label
#   --ephemeral      pass --no-session to pi (default keeps a pi session so Herdr
#                    can restore the worker after a server restart)
#   --focus          focus the new pane (default: --no-focus, keep Lee's focus)
#
# Prints JSON on success: {name, pane_id, workspace_id, tab_id, status, model, thinking, argv}
# Exit 1 with a message on stderr on failure. Never falls back to another provider.
set -euo pipefail

die() { printf 'spawn-pi: %s\n' "$*" >&2; exit 1; }

[ "${HERDR_ENV:-}" = 1 ] || die "not inside a Herdr pane (HERDR_ENV != 1)"
command -v herdr >/dev/null || die "herdr not in PATH"
command -v jq >/dev/null || die "jq required"

[ $# -ge 2 ] || die "usage: spawn-pi.sh <name> <model-id> [thinking] [placement] [--task TEXT] [-- pi args]"
name="$1"; model="$2"; shift 2
thinking="medium"
if [ $# -gt 0 ] && [[ "$1" != --* ]]; then thinking="$1"; shift; fi

mode="split"; dir=""; pane=""; label=""; branch=""; wt_path=""; base=""; task=""
focus="--no-focus"; ephemeral=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)           mode="split"; dir="${2:?}"; shift 2 ;;
    --pane)          mode="pane"; pane="${2:?}"; shift 2 ;;
    --new-tab)       mode="tab"; label="${2:?}"; shift 2 ;;
    --new-workspace) mode="workspace"; label="${2:?}"; shift 2 ;;
    --worktree)      mode="worktree"; branch="${2:?}"; shift 2 ;;
    --open-worktree) mode="open-worktree"; wt_path="${2:?}"; shift 2 ;;
    --path)          wt_path="${2:?}"; shift 2 ;;
    --base)          base="${2:?}"; shift 2 ;;
    --task)          task="${2:?}"; shift 2 ;;
    --ephemeral)     ephemeral=1; shift ;;
    --focus)         focus="--focus"; shift ;;
    --)              shift; break ;;
    *)               die "unexpected argument: $1" ;;
  esac
done
extra=("$@")
if [ "$ephemeral" = 1 ]; then extra+=(--no-session); fi

printf '%s' "$name" | grep -Eq '^[a-z][a-z0-9_-]{0,31}$' || die "invalid agent name: $name"
case "$thinking" in off|minimal|low|medium|high|xhigh|max) ;; *) die "invalid thinking level: $thinking" ;; esac
case "$dir" in ""|right|down) ;; *) die "invalid --dir: $dir" ;; esac

if herdr agent list | jq -e --arg n "$name" '.result.agents[] | select(.name == $n)' >/dev/null 2>&1; then
  die "agent name already live: $name (see: herdr agent list)"
fi

created_kind=""; created_id=""
case "$mode" in
  split)
    if [ -z "$dir" ]; then
      read -r w h < <(herdr pane layout --current | jq -r '.result.layout as $l | $l.panes[] | select(.pane_id == $l.focused_pane_id) | "\(.rect.width) \(.rect.height)"' | head -1)
      if [ "${w:-0}" -gt $(( ${h:-0} * 2 )) ]; then dir=right; else dir=down; fi
    fi
    resp=$(herdr pane split --current --direction "$dir" --cwd "$PWD" "$focus") || die "pane split failed"
    pane=$(printf '%s' "$resp" | jq -r '.result.pane.pane_id'); created_kind=pane; created_id="$pane" ;;
  pane)
    ;;
  tab)
    resp=$(herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$PWD" --label "$label" "$focus") || die "tab create failed"
    pane=$(printf '%s' "$resp" | jq -r '.result.root_pane.pane_id'); created_kind=tab; created_id=$(printf '%s' "$resp" | jq -r '.result.tab.tab_id') ;;
  workspace)
    resp=$(herdr workspace create --cwd "$PWD" --label "$label" "$focus") || die "workspace create failed"
    pane=$(printf '%s' "$resp" | jq -r '.result.root_pane.pane_id'); created_kind=workspace; created_id=$(printf '%s' "$resp" | jq -r '.result.workspace.workspace_id') ;;
  worktree)
    args=(--cwd "$PWD" --branch "$branch" --label "${label:-$branch}" "$focus")
    [ -n "$wt_path" ] && args+=(--path "$wt_path")
    [ -n "$base" ] && args+=(--base "$base")
    resp=$(herdr worktree create "${args[@]}") || die "worktree create failed"
    pane=$(printf '%s' "$resp" | jq -r '.result.root_pane.pane_id'); created_kind=workspace; created_id=$(printf '%s' "$resp" | jq -r '.result.workspace.workspace_id') ;;
  open-worktree)
    args=(--cwd "$PWD" --path "$wt_path" "$focus")
    [ -n "$label" ] && args+=(--label "$label")
    resp=$(herdr worktree open "${args[@]}") || die "worktree open failed"
    pane=$(printf '%s' "$resp" | jq -r '.result.root_pane.pane_id'); created_kind=workspace; created_id=$(printf '%s' "$resp" | jq -r '.result.workspace.workspace_id')
    grouped=$(herdr workspace get "$created_id" | jq -r '.result.workspace.worktree.repo_key // "null"')
    [ "$grouped" = null ] && printf 'spawn-pi: warning: Space %s has no worktree link; it will NOT nest under the repo\n' "$created_id" >&2 ;;
esac
[ -n "$pane" ] && [ "$pane" != null ] || die "could not resolve a target pane"

cleanup_created() {
  case "$created_kind" in
    pane) herdr pane close "$created_id" >/dev/null 2>&1 || true ;;
    tab) herdr tab close "$created_id" >/dev/null 2>&1 || true ;;
    workspace) herdr workspace close "$created_id" >/dev/null 2>&1 || true ;;
  esac
}

if ! start_json=$(herdr agent start "$name" --kind pi --pane "$pane" --timeout 60000 -- \
      --provider mac-mini --model "$model" --thinking "$thinking" "${extra[@]}" 2>&1); then
  printf '%s\n' "$start_json" >&2
  cleanup_created
  die "agent start failed for $name in $pane (created layout closed)"
fi

# Presentation for the Agents panel: display label, pane title, and $tokens.
display="$name · $model"
meta=(--source "pi:orchestrator" --agent pi --display-agent "$display"
      --token model="$model" --token thinking="$thinking" --token spawned_by="${HERDR_PANE_ID:-?}")
if [ -n "$task" ]; then meta+=(--title "$task" --token task="$task"); fi
herdr pane report-metadata "$pane" "${meta[@]}" >/dev/null 2>&1 || true

printf '%s' "$start_json" | jq -c --arg n "$name" --arg m "$model" --arg t "$thinking" --arg ck "$created_kind" --arg ci "$created_id" \
  '{name:$n, pane_id:.result.agent.pane_id, workspace_id:.result.agent.workspace_id, tab_id:.result.agent.tab_id,
    status:.result.agent.agent_status, model:$m, thinking:$t, created:{kind:$ck, id:$ci}, argv:.result.argv}'
