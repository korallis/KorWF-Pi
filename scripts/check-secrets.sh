#!/usr/bin/env bash
# Secret scan (issue #20 Scope).
#
# Greps tracked, staged and (optionally) working-tree files for patterns that
# look like committed credentials, and fails with a non-zero exit if any are
# found. Wired into CI so a PR containing a real or fake key never merges.
#
# Usage:
#   bash scripts/check-secrets.sh            # scan git-tracked files (HEAD)
#   bash scripts/check-secrets.sh --staged    # scan the git index (pre-commit use)
#   bash scripts/check-secrets.sh --range A..B  # scan files touched in a commit range
#
# Deliberately dependency-free (grep + git only) so it runs with no Jev key
# and no npm install, per AGENTS.md §4 "the system must work with no Jev key"
# and the M0 dependency ceiling for Stage 2.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Patterns are intentionally simple substrings/prefixes, not full secret
# formats — false positives are fine here, false negatives are not.
PATTERN='apikey_[A-Za-z0-9]|[^a-zA-Z0-9_-]sk-[A-Za-z0-9]{10,}|^sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|JEV_API_KEY='  # check-secrets:allow

MODE="tracked"
RANGE=""
for arg in "$@"; do
  case "$arg" in
    --staged) MODE="staged" ;;
    --range)  MODE="range" ;;
    --range=*) MODE="range"; RANGE="${arg#--range=}" ;;
    *) if [ "$MODE" = "range" ] && [ -z "$RANGE" ]; then RANGE="$arg"; fi ;;
  esac
done

list_files() {
  case "$MODE" in
    staged) git diff --cached --name-only --diff-filter=ACM ;;
    range)  git diff "$RANGE" --name-only --diff-filter=ACM ;;
    tracked) git ls-files ;;
  esac
}

# Never scan our own pattern definitions or intentionally-fake fixtures that
# document the pattern (this file itself, and any file that opts out via a
# trailing "# check-secrets:allow" marker on the matching line).
EXCLUDE_SELF="scripts/check-secrets.sh"

found=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ "$file" = "$EXCLUDE_SELF" ] && continue
  [ -f "$file" ] || continue
  # Skip binary files.
  if grep -Iq . "$file" 2>/dev/null; then
    matches=$(grep -nE "$PATTERN" "$file" 2>/dev/null | grep -v 'check-secrets:allow' || true)
    if [ -n "$matches" ]; then
      found=1
      echo "::error file=$file::possible committed secret" >&2
      echo "$file:" >&2
      echo "$matches" | sed 's/^/  /' >&2
    fi
  fi
done < <(list_files)

if [ "$found" -ne 0 ]; then
  echo "check-secrets: possible secret(s) found above — remove before committing." >&2
  exit 1
fi

echo "check-secrets: clean."
exit 0
