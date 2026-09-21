#!/usr/bin/env bash
# Stop a pi worker started by spawn-pi.sh and optionally close the layout it created.
#
# Usage: stop-pi.sh <name> [--close pane|tab|workspace] [--keep] [--force]
#   --close KIND   close the pane / tab / workspace hosting the agent after exit
#   --keep         only exit pi, leave the shell pane open (default)
#   --force        allow closing a tab/workspace that still holds OTHER agents
#
# Safety: closing a tab or workspace kills every agent inside it. This script
# refuses to do that when other live agents share the target, unless --force.
set -euo pipefail
die() { printf 'stop-pi: %s\n' "$*" >&2; exit 1; }
[ "${HERDR_ENV:-}" = 1 ] || die "not inside Herdr"
name="${1:-}"; [ -n "$name" ] || die "usage: stop-pi.sh <name> [--close pane|tab|workspace]"
shift
close=""; force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --close) close="${2:?}"; shift 2 ;;
    --keep) close=""; shift ;;
    --force) force=1; shift ;;
    *) die "unexpected argument: $1" ;;
  esac
done

info=$(herdr agent get "$name" 2>/dev/null) || die "no live agent named $name"
pane=$(printf '%s' "$info" | jq -r .result.agent.pane_id)
tab=$(printf '%s' "$info" | jq -r .result.agent.tab_id)
ws=$(printf '%s' "$info" | jq -r .result.agent.workspace_id)
[ "$pane" != "${HERDR_PANE_ID:-}" ] || die "refusing to stop the calling pane"

# Closing a tab/workspace kills every agent in it. Refuse to take bystanders
# with us, and never close the tab/workspace this session is running in.
if [ -n "$close" ] && [ "$close" != pane ] && [ "$force" = 0 ]; then
  if [ "$close" = tab ]; then field=tab_id; target="$tab"; self="${HERDR_TAB_ID:-}"
  else field=workspace_id; target="$ws"; self="${HERDR_WORKSPACE_ID:-}"; fi
  [ "$target" != "$self" ] || die "refusing to close the $close this session runs in ($target)"
  others=$(herdr agent list | jq -r --arg n "$name" --arg f "$field" --arg t "$target" \
    '[.result.agents[] | select(.[$f] == $t) | select((.name // "") != $n) | (.name // .pane_id)] | join(", ")')
  [ -z "$others" ] || die "refusing --close $close: $target still holds other agents ($others). Use --close pane, or --force."
fi

herdr agent send-keys "$name" ctrl+c ctrl+c >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  herdr agent get "$name" >/dev/null 2>&1 || break
  sleep 0.5
done
if herdr agent get "$name" >/dev/null 2>&1; then
  herdr agent send-keys "$name" ctrl+d >/dev/null 2>&1 || true
  sleep 1
fi

case "$close" in
  "") ;;
  pane) herdr pane close "$pane" >/dev/null ;;
  tab) herdr tab close "$tab" >/dev/null ;;
  workspace) herdr workspace close "$ws" >/dev/null ;;
  *) die "invalid --close: $close" ;;
esac
jq -nc --arg n "$name" --arg p "$pane" --arg c "$close" '{stopped:$n, pane_id:$p, closed:(if $c=="" then null else $c end)}'
