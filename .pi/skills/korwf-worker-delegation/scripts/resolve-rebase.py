#!/usr/bin/env python3
"""Resolve the mechanical rebase conflicts this repo produces, for every block in a file.

The four kinds seen across M2-M5, all resolved the same two ways:

  barrel exports / imports / db wiring  -> keep BOTH sides (they are additive)
  TODO.md checklist ticks               -> union of ticks (both items really are done)

Written because a hand-rolled ``re.sub`` with the default count of 1 silently left the
*second* conflict block in ``src/workers/index.ts`` intact during #72's rebase: the rebase
"succeeded", tests passed, and only ``tsc`` caught it with "Merge conflict marker
encountered". Always resolve every block, then verify none remain.

Usage:  resolve-rebase.py            # every currently-conflicted file
        resolve-rebase.py FILE...    # specific files
"""
import re
import subprocess
import sys

BLOCK = re.compile(r"<<<<<<< [^\n]*\n(.*?)\n=======\n(.*?)\n>>>>>>> [^\n]*\n", re.S)


def union_of_ticks(ours: str, theirs: str) -> str:
    """Both branches ticked different items; a line ticked on either side is done."""
    o, t = ours.split("\n"), theirs.split("\n")
    if len(o) != len(t):
        # Shapes diverged — keeping both is wrong here, so refuse rather than guess.
        raise SystemExit("TODO.md conflict is not a simple tick difference; resolve by hand")
    return "\n".join(a if a.startswith("- [x]") else b for a, b in zip(o, t)) + "\n"


def resolve(path: str) -> int:
    with open(path) as fh:
        text = fh.read()

    def repl(m: "re.Match[str]") -> str:
        ours, theirs = m.group(1), m.group(2)
        if path.endswith("TODO.md"):
            return union_of_ticks(ours, theirs)
        return ours.rstrip("\n") + "\n" + theirs.strip("\n") + "\n"

    resolved, count = BLOCK.subn(repl, text)
    if count:
        with open(path, "w") as fh:
            fh.write(resolved)
    # The whole point: prove nothing was left behind.
    if "<<<<<<<" in resolved or ">>>>>>>" in resolved:
        raise SystemExit(f"{path}: markers remain after resolving {count} block(s) — resolve by hand")
    return count


def main() -> None:
    files = sys.argv[1:]
    if not files:
        out = subprocess.run(
            ["git", "diff", "--name-only", "--diff-filter=U"],
            capture_output=True, text=True, check=False,
        )
        files = out.stdout.split()
    if not files:
        print("no conflicted files")
        return
    for path in files:
        print(f"{path}: resolved {resolve(path)} block(s)")


if __name__ == "__main__":
    main()
