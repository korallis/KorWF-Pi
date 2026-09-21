#!/usr/bin/env bash
# Refresh the pinned Herdr docs in ../references for the installed herdr version.
set -euo pipefail
dir="$(cd "$(dirname "$0")/../references" && pwd)"
ver="$(herdr --version | awk '{print $2}')"
tag="v$ver"
base="https://raw.githubusercontent.com/herdrdev/herdr/$tag/docs/next/website/src/content/docs"
{
  echo "# Herdr CLI reference"; echo
  echo "Upstream skill text from \`herdr --skill\` (herdr $ver, $(date +%F))."; echo
  herdr --skill | awk 'f>=2{print} /^---$/{f++}'
} > "$dir/herdr-cli.md"
for p in agent-automation agents cli-reference concepts; do
  curl -fsSL "$base/$p.mdx" -o "$dir/$p.md" || { echo "fetch failed: $p ($tag)" >&2; exit 1; }
done
echo "references refreshed for herdr $ver -> $dir"
