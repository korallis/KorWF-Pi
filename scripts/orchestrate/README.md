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

> **`run.mjs` is batch mode, and it is NOT the default way to build this repo.**
> Its workers are headless subprocesses: invisible in Herdr's Agents panel, impossible to
> steer, and unable to ask a question — so a worker that hits an ambiguity silently
> guesses. Use it only for a long unattended queue, and say that is what you are doing.
>
> **Normally you orchestrate yourself**, spawning real pi agents:
> **[`.pi/skills/jev-orchestration/ORCHESTRATOR-PLAYBOOK.md`](../../.pi/skills/jev-orchestration/ORCHESTRATOR-PLAYBOOK.md)**.
> Issue #14 failed six batch attempts and was then completed by one real agent.

```sh
set -a; . ~/Projects/.env; set +a        # JEV_API_KEY (never forwarded to workers)

# Jev decisions, for either mode
node scripts/orchestrate/ask-jev.mjs pick-issue     # which issue to take next
node scripts/orchestrate/ask-jev.mjs select-model 14  # which model + thinking level

# Review and merge, used by BOTH modes
node scripts/orchestrate/run.mjs --review 7         # re-run the evidence gate on the last attempt (no new worker)
node scripts/orchestrate/run.mjs --merge 7          # merge review: hard checks + Jev (complete, honest, in-scope, rule violation, quality); squash-merge if all pass

# Batch mode (unattended only — headless workers, invisible in the Agents panel)
node scripts/orchestrate/run.mjs --dry-run          # show Jev's selection for ready issues, no workers
node scripts/orchestrate/run.mjs --once --issue 7   # one attempt on one issue
node scripts/orchestrate/run.mjs --max 10           # loop until nothing is ready or 10 worker runs
```

Workers run in `../korwf-worktrees/issue-<n>` on branch `issue-<n>-<slug>`, open a PR, and
never merge. Issues that fail the gate three times, or that Jev judges under-specified,
get `needs-human`.

## Where the workers are (they are not Herdr agents)

Workers are **headless** `pi -p --mode json` subprocesses spawned by `run.mjs`, not
`herdr agent start` sessions. Headless pi is not in a pane, so **Herdr's Agents panel
cannot see a worker** — a healthy run and a dead orchestrator look identical there. This
is deliberate: headless mode is what lets the orchestrator stream structured events,
parse the final JSON report, and enforce `workers.timeoutMinutes`.

To make a run visible, `herdrSurface()` opens each worker's **worktree as a Herdr Space**,
which nests under KorWF-Pi in the sidebar and shows that worker's live git activity.

```sh
node scripts/orchestrate/check-layout.mjs   # CI guard: no code may split the user's tab
```

It must never use `pane split --current` (that splits *your* pane, once per dispatch —
this actually happened), and it closes only Spaces it created, never a tab (closing a tab
kills every agent inside it). See `docs/adr/0004-worker-interface.md` §"Worker visibility".

To check a run is alive without the Agents panel:

```sh
pgrep -af 'run.mjs'                                   # orchestrator
pgrep -af 'provider mac-mini'                         # the worker itself
tail -f .orchestrate/orchestrator.log                 # dispatch/gate decisions
git -C ../korwf-worktrees/issue-<n> status -s         # files changing = real progress
```

This script is replaced by the product itself from Stage 5 onward.
