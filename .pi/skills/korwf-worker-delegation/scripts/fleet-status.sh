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
  # Match on the worktree PATH, not the branch line: a worker mid-rebase is in detached
  # HEAD and prints no `branch` line at all, which previously reported "no worktree" and
  # hid a stuck rebase (#37 sat detached at step 41/46 for half an hour).
  wt=$(git -C "$ROOT" worktree list --porcelain 2>/dev/null \
       | awk -v n="${name#issue-}" '/^worktree /{ if (index($2, "/issue-" n "-")) print $2 }' | head -1)
  if [ -n "$wt" ] && [ -d "$wt" ]; then
    # Surface a stalled rebase explicitly; it needs `rebase --continue`, not patience.
    if [ -d "$ROOT/.git/worktrees/$(basename "$wt")/rebase-merge" ] || [ -d "$wt/.git/rebase-merge" ]; then
      done_n=$(wc -l < "$ROOT/.git/worktrees/$(basename "$wt")/rebase-merge/done" 2>/dev/null || echo '?')
      printf '%-14s %-9s %-8s %-7s %s\n' "$name" "$state" "REBASE" "$done_n" "STALLED mid-rebase — run: git -C $wt -c core.editor=true rebase --continue"
      continue
    fi
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
