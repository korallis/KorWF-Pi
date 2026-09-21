# Bootstrap orchestrator (development tooling, PLAN §11)

Builds KorWF-Pi from its own issue tracker using the responsibility split in PLAN §1,
so the product is dogfooded from the first commit:

| Responsibility | Owner in this script |
|---|---|
| Which issues are ready, ordering, concurrency, attempt limits, budgets, locks | code (`readyIssues`, config) |
| Task profile (domain, depth, context size, "is the issue sufficient?") | **Jev** (`profileAndSelect`) |
| Model ranking against model cards, within the allowlist | **Jev**, enforced by code |
| Static fallback when Jev is unavailable or finds none adequate | code (`staticFallbackOrder`) |
| Cap detection, cooldown, mid-task handoff with intact worktree | code |
| Writing the code / docs / tests | Pi worker (`pi -p --mode json` on `mac-mini/<model>`) |
| Deterministic checks (branch pushed, PR exists with `Closes #n`, verification commands, `npm test`) | code |
| Evidence-gap review: does the report + checks support each acceptance criterion? overclaiming? | **Jev** (`evidenceGap`) — can only *fail* an attempt, never waive a check |
| Merge review: mergeable, checks green, no secrets/home paths, not risk:high | code (`--merge N`) |
| Merge review: complete for the issue, honest PR description, in scope, no PLAN rule violation, reviewer quality | **Jev** (`--merge N`) — any low score blocks and adds `needs-human` |
| Merge | code, only when every hard and Jev check passes (`--merge N`); never in the dispatch loop |

Every Jev call is appended to `.orchestrate/decisions.jsonl` with the full raw distributions.
Worker attempts, models used, fallback reasons, checks, and gap results are in `.orchestrate/state.json`.
Both are git-ignored.

## Run

```sh
set -a; . ~/Projects/.env; set +a        # JEV_API_KEY (never forwarded to workers)
node scripts/orchestrate/run.mjs --dry-run          # show Jev's selection for ready issues, no workers
node scripts/orchestrate/run.mjs --once --issue 7   # one attempt on one issue
node scripts/orchestrate/run.mjs --max 10           # loop until nothing is ready or 10 worker runs
node scripts/orchestrate/run.mjs --review 7         # re-run the evidence gate on the last attempt (no new worker)
node scripts/orchestrate/run.mjs --merge 7          # merge review: hard checks + Jev (complete, honest, in-scope, rule violation, quality); squash-merge if all pass
```

Workers run in `../korwf-worktrees/issue-<n>` on branch `issue-<n>-<slug>`, open a PR, and
never merge. Issues that fail the gate three times, or that Jev judges under-specified,
get `needs-human`.

This script is replaced by the product itself from Stage 5 onward.
