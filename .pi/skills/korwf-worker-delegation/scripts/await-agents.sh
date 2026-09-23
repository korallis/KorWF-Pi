#!/usr/bin/env bash
# Block until every named agent has finished, then print a one-line verdict per agent.
#
# Why this exists. The orchestrator kept dispatching work, running a single `sleep`, and
# then returning to the user — so every wait became a stop, and the fleet sat idle until
# someone prodded it. This blocks for the whole run instead, and nudges an agent that has
# settled without producing anything rather than waiting out the clock on a dead turn.
#
# Usage: await-agents.sh <name>... [--timeout-min N] [--nudge-file PATH]
#   --timeout-min   give up after N minutes (default 60)
#   --nudge-file    prompt to re-send to an agent that settles with no new commits
#
# Exit 0 when every agent finished, 1 on timeout. Prints:
#   issue-73  done     commits=8  pr=#184
set -uo pipefail
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
S="$ROOT/.pi/skills/korwf-worker-delegation/scripts"

names=(); timeout_min=60; nudge=""
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout-min) timeout_min=$2; shift 2 ;;
    --nudge-file)  nudge=$2; shift 2 ;;
    *)             names+=("$1"); shift ;;
  esac
done
[ ${#names[@]} -eq 0 ] && { echo "usage: await-agents.sh <name>... [--timeout-min N] [--nudge-file PATH]"; exit 2; }

deadline=$(( $(date +%s) + timeout_min * 60 ))
declare -A settled=() nudged=() lastcommits=()

worktree_of() {
  git -C "$ROOT" worktree list --porcelain 2>/dev/null \
    | awk -v n="${1#issue-}" '/^worktree /{ if (index($2, "/issue-" n "-")) print $2 }' | head -1
}
commits_of() {
  local wt; wt=$(worktree_of "$1"); [ -z "$wt" ] && { echo 0; return; }
  git -C "$wt" rev-list --count origin/main..HEAD 2>/dev/null || echo 0
}
state_of() {
  herdr agent list 2>/dev/null | jq -r --arg n "$1" \
    '.result.agents[]|select(.name==$n)|.agent_status' 2>/dev/null
}

while :; do
  all_done=true
  for n in "${names[@]}"; do
    [ "${settled[$n]:-}" = yes ] && continue
    st=$(state_of "$n"); c=$(commits_of "$n")

    # Gone from the panel entirely: treat as finished, the caller will inspect the branch.
    if [ -z "$st" ]; then settled[$n]=yes; echo "$(date +%H:%M:%S) $n vanished (commits=$c)"; continue; fi

    if [ "$st" = "done" ] || [ "$st" = "idle" ]; then
      # A settled agent that produced nothing new has usually ended a turn mid-thought
      # (the output-token ceiling) rather than finished. Nudge once, then believe it.
      if [ -n "$nudge" ] && [ "${nudged[$n]:-}" != yes ] && [ "$c" = "${lastcommits[$n]:-0}" ] && [ "$c" != "0" ]; then
        : # settled with commits and no growth: likely genuinely done
      fi
      if [ -n "$nudge" ] && [ "${nudged[$n]:-}" != yes ] && [ "$c" = "0" ]; then
        echo "$(date +%H:%M:%S) $n settled with 0 commits — nudging once"
        "$S/dispatch-worker.sh" "$n" "$nudge" >/dev/null 2>&1
        nudged[$n]=yes; all_done=false; continue
      fi
      settled[$n]=yes
      echo "$(date +%H:%M:%S) $n $st commits=$c"
      continue
    fi

    if [ "$st" = "blocked" ]; then
      # Blocked means it is asking something; that needs a human decision, not a timer.
      settled[$n]=yes
      echo "$(date +%H:%M:%S) $n BLOCKED — needs a decision (herdr agent read $n --source visible)"
      continue
    fi

    lastcommits[$n]=$c
    all_done=false
  done

  $all_done && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "timeout after ${timeout_min}m; still running:"
    for n in "${names[@]}"; do [ "${settled[$n]:-}" = yes ] || echo "  $n $(state_of "$n") commits=$(commits_of "$n")"; done
    exit 1
  fi
  sleep 60
done

echo "--- all agents settled ---"
for n in "${names[@]}"; do
  pr=$(gh pr list --head "$(basename "$(worktree_of "$n")" 2>/dev/null)" --json number -q '.[0].number' 2>/dev/null)
  printf '%-14s commits=%-4s pr=%s\n' "$n" "$(commits_of "$n")" "${pr:+#$pr}"
done
