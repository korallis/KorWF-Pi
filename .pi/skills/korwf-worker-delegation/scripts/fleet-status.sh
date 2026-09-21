#!/usr/bin/env bash
# One-line status per live worker: agent state, commits on its branch, and whether its
# worktree has changed recently. Answers "is this fleet actually progressing?" without
# reading logs or guessing from an empty Agents panel.
#
# Usage: fleet-status.sh [repo-root]
set -uo pipefail
ROOT=${1:-$(git rev-parse --show-toplevel 2>/dev/null || echo .)}

agents=$(herdr agent list 2>/dev/null | jq -r '.result.agents[]|select(.name)|"\(.name) \(.agent_status)"')
[ -z "$agents" ] && { echo "no named agents"; exit 0; }

printf '%-14s %-9s %-8s %-7s %s\n' AGENT STATE COMMITS DIRTY LAST-WRITE
while read -r name state; do
  wt=$(git -C "$ROOT" worktree list --porcelain 2>/dev/null \
       | awk -v n="${name#issue-}" '/^worktree /{p=$2} /^branch /{if (index($0, "issue-" n "-")) print p}' | head -1)
  if [ -n "$wt" ] && [ -d "$wt" ]; then
    commits=$(git -C "$wt" rev-list --count origin/main..HEAD 2>/dev/null || echo "?")
    dirty=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    last=$(find "$wt" -type f -newermt '-3 minutes' \
           -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null | wc -l | tr -d ' ')
    note=$([ "$last" -gt 0 ] && echo "${last} file(s) <3min" || echo "idle >3min")
  else
    commits="-"; dirty="-"; note="no worktree"
  fi
  printf '%-14s %-9s %-8s %-7s %s\n' "$name" "$state" "$commits" "$dirty" "$note"
done <<< "$agents"
