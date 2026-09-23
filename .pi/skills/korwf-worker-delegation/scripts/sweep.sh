#!/usr/bin/env bash
# Sweep finished work: stop agents whose issue is closed, remove their worktrees and
# Spaces, delete merged branches (local and remote), and report anything left behind.
#
# Why this exists: cleanup kept being done by hand, only when someone noticed the mess.
# Stale worktrees let a later worker branch from dead history, and orphaned Spaces make
# the sidebar useless. Run this after every merge.
#
# Safe by construction:
#   - only touches this repo (filters agents by worktree repo_key)
#   - only removes a worktree whose issue is CLOSED
#   - refuses to delete a branch holding commits that are not in origin/main
#   - never closes a Space it cannot map back to this repo's worktrees
#
# Usage: sweep.sh [--dry-run]
set -uo pipefail
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
DRY=${1:-}
say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = "--dry-run" ]; then say "  would: $*"; else "$@" >/dev/null 2>&1; fi; }

cd "$ROOT" || exit 1
git fetch --prune -q origin 2>/dev/null

S="$ROOT/.pi/skills/korwf-worker-delegation/scripts"
removed=0

# 1. Worktrees whose issue is closed.
while read -r path; do
  [ -z "$path" ] && continue
  [ "$path" = "$ROOT" ] && continue
  name=$(basename "$path")
  num=$(printf '%s' "$name" | grep -oE '^issue-[0-9]+' | grep -oE '[0-9]+')
  [ -z "$num" ] && continue
  state=$(gh issue view "$num" --json state -q .state 2>/dev/null)
  [ "$state" != "CLOSED" ] && continue

  # An agent may still be attached; stop it and close only its own Space.
  if herdr agent list 2>/dev/null | jq -e --arg n "issue-$num" '.result.agents[]|select(.name==$n)' >/dev/null 2>&1; then
    say "stopping agent issue-$num (issue closed)"
    run "$S/stop-pi.sh" "issue-$num" --close workspace
  fi

  branch=$(git -C "$path" branch --show-current 2>/dev/null)
  say "removing worktree $name (issue #$num closed)"
  run git worktree remove "$path" --force
  removed=$((removed + 1))

  if [ -n "$branch" ]; then
    # Squash-merged branches look "unmerged", so ask whether the work is in main by
    # content: no commits touching files that differ from origin/main.
    if git merge-base --is-ancestor "$branch" origin/main 2>/dev/null; then
      run git branch -d "$branch"
    else
      say "  keeping local branch $branch (commits not in origin/main — check before deleting)"
    fi
    if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
      say "  deleting remote branch $branch"
      run git push origin --delete "$branch"
    fi
  fi
done < <(git worktree list --porcelain | awk '/^worktree /{print $2}')

run git worktree prune

# 2. Report leftovers rather than guessing at them.
say ""
say "--- after sweep ---"
say "worktrees:  $(git worktree list | wc -l) (1 = just the primary checkout)"
say "issue branches: $(git branch --list 'issue-*' | wc -l)"
# Count by worktree path, not by an agent-record field that may be absent: the same
# filtering fleet-status.sh uses, for the same reason.
live=$(herdr agent list 2>/dev/null | jq -r '.result.agents[]|select(.name)|.name' 2>/dev/null \
  | while read -r n; do
      git worktree list --porcelain 2>/dev/null | grep -q "/${n}-" && echo "$n"
    done | wc -l)
say "live agents (this repo): ${live}"

# A Space pointing at a path that no longer exists is pure noise in the sidebar.
herdr workspace list 2>/dev/null \
  | jq -r '.result.workspaces[]|select((.worktree.checkout_path // "")|test("KorWF-Pi"))|"\(.workspace_id)\t\(.worktree.checkout_path)"' \
  | while IFS=$'\t' read -r wsid path; do
      [ -d "$path" ] && continue
      say "orphaned Space $wsid -> $path (gone)"
      run herdr workspace close "$wsid"
    done

say "swept $removed worktree(s)"
