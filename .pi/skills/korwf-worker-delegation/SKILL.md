---
name: korwf-worker-delegation
description: KorWF-Pi's own rules for delegating work to worker agents. ALWAYS load before spawning a worker, taking an issue, running scripts/orchestrate/run.mjs, creating or removing a worktree, or cleaning up branches in this repository. Covers one-issue-one-worktree, how a worker Space nests under the KorWF-Pi project in Herdr's sidebar, the repo's helper scripts (.pi/skills/korwf-worker-delegation/scripts/spawn-pi.sh, stop-pi.sh), the mac-mini model allowlist in scripts/orchestrate/config.json, worker prompting and result collection, and worktree/branch cleanup local and remote. Generic Herdr and pi mechanics (panes, tabs, agent lifecycle, CLI syntax, failure modes) live in the machine-wide `herdr-pi-delegation` skill — load that too when you need them.
---

# KorWF-Pi worker delegation

There are **no sub-agents**. A worker is a new pi session running in a Herdr pane,
started with `herdr agent start --kind pi`. This skill is the KorWF-Pi-specific layer.

**Authority split — read this first:**

| Topic | Authority |
|---|---|
| Herdr concepts, pane/tab/workspace CLI, agent lifecycle states, prompting and reading panes, model capability notes, failure modes | the machine-wide **`herdr-pi-delegation`** skill (`~/.pi/agent/skills/herdr-pi-delegation/SKILL.md`), which also holds the pinned herdr reference docs in its `references/` |
| Model IDs and thinking levels | `~/.pi/agent/skills/mac-mini-models/SKILL.md` |
| When to delegate, escalation, evidence gate, Jev usage | `.pi/skills/jev-orchestration/SKILL.md` |
| **This repo's** worktree/branch rules, helper scripts, worker prompt contract, cleanup | **this file** |

Do not duplicate the generic manual here. If a generic Herdr fact is wrong or missing,
fix it in the machine-wide skill, not in this one.

## 1. Non-negotiables (repo AGENTS.md §3, §4)

1. **One issue per branch, one worker per issue.** Branch `issue-<n>-<short-slug>`.
2. **Never commit to `main` directly**, and never let a worker do so.
3. **Use a worktree whenever another agent may be active.** Workers get their own
   checkout; they never share the primary one.
4. **Only `mac-mini` models**, chosen from `scripts/orchestrate/config.json`
   (`allowlist.models`). Never fall back to another provider if the proxy fails —
   report it instead.
5. **Never pass credentials to a worker.** `run.mjs` strips `JEV|TYPESAFE|API_KEY|
   SECRET|TOKEN` from the worker environment; manual spawns must not reintroduce them.
6. **Closing a tab or workspace kills every agent inside it.** Clean up only with
   `stop-pi.sh`. Never close a pane/tab/Space you did not create, never close Lee's,
   and never `herdr server stop`.
7. **Never split Lee's tab from code.** `herdr pane split --current` targets the pane
   the process was launched from — his. Anything long-lived (orchestrator, worker,
   surface, monitor) gets its own Space or tab. Enforced by
   `node scripts/orchestrate/check-layout.mjs`; run it after touching orchestration code.

## 1.1 `run.mjs` workers are NOT Herdr agents

The single most confusing thing about this repo, and the cause of a "nothing is
happening" incident: **`run.mjs` does not use `herdr agent start`.** Workers are headless
`pi -p --mode json` subprocesses, which is what lets the orchestrator stream events,
parse the final JSON report and enforce timeouts. Headless pi is not in a pane, so
**Herdr's Agents panel cannot show it**. An orchestrated run that is working perfectly
looks exactly like a crashed one.

Two different mechanisms, do not confuse them:

| | `run.mjs` worker | `spawn-pi.sh` worker (§2) |
|---|---|---|
| Started by | `spawn()` → `pi -p --mode json` | `herdr agent start --kind pi` |
| In the Agents panel? | **No** — only its worktree Space appears | Yes, by name |
| Visibility | `herdrSurface()` opens the worktree as a Space | the agent itself |
| Use when | the orchestrator drives the loop | you are delegating by hand |

Before reporting an orchestrated run as dead, check it the way it actually works:

```bash
pgrep -af 'run.mjs'; pgrep -af 'provider mac-mini'   # orchestrator, worker
tail -5 .orchestrate/orchestrator.log                # last dispatch/gate decision
ls -la --time-style=+%H:%M:%S ../korwf-worktrees/issue-<n>/src   # files changing = alive
```

An empty Agents panel is **not** evidence of a stalled orchestrator.

## 2. Placing a worker so it nests under KorWF-Pi

Herdr groups Spaces in the sidebar **by git worktree identity only** — never by cwd or
label. A Space indents under the `KorWF-Pi` parent row when it shares the repo's
`repo_key` and the primary checkout is present (details: `herdr-pi-delegation` §1.1).

```
spaces
 ● KorWF-Pi              <- primary checkout = parent
   ├ · issue-8           <- linked worktree Spaces = children
   └ · issue-12
```

Therefore, for issue work:

```bash
S=.pi/skills/korwf-worker-delegation/scripts

# new issue branch + worktree + nested Space
$S/spawn-pi.sh issue-14 gpt-5.6-sol high --worktree issue-14-model-cards --task "issue #14"

# existing worktree (this repo keeps them in ../korwf-worktrees/)
$S/spawn-pi.sh pr114-audit gpt-6-astra high --open-worktree ../korwf-worktrees/issue-8
```

`herdr workspace create --cwd <path>` does **not** nest — it leaves a stray top-level
Space with `worktree: null`. Verify after creating one:

```bash
herdr workspace get <id> | jq -c '.result.workspace.worktree'   # must not be null
```

A short helper that works on the current checkout needs no Space at all — a pane split
is enough (`$S/spawn-pi.sh <name> <model>` with no placement flag). **Do not create a
Space merely to make an agent visible**; the Agents panel already lists every agent.

## 3. The worker prompt contract

A worker starts with no memory of this conversation. Its prompt must be self-contained
and must reproduce what AGENTS.md demands of it:

- the issue number and the instruction to read the issue, `AGENTS.md` and `PLAN.md`;
- the branch it owns and the fact that it must not touch `main`;
- the acceptance criteria and the **Verification** commands it must run and paste;
- the PR template (AGENTS.md §6) and `Closes #<n>`;
- "comment `Starting — <plan>` on the issue before you begin".

Collect results via a file, not the pane — pane text scrolls off:

```bash
herdr agent prompt issue-14 "$(cat <<'EOF'
<task>
When finished, write your complete result as Markdown to /tmp/issue-14-result.md
and reply only with that path.
EOF
)" --wait --timeout 900000
herdr agent read issue-14 --source recent-unwrapped --lines 200
```

Ask for the result file in the *closing* instruction of a long task, not as the opening
move. `run.mjs` workers instead run headless (`pi -p --mode json`) and are surfaced in
the Agents panel by a reporting pane — see `herdrSurface()` there.

## 4. Verify what a worker claims

From `jev-orchestration` §4, learned here: a worker once pasted a verification
transcript that could not have produced its output, and the gate passed it.

- **Re-run pasted verification commands literally** for anything merge-critical.
- Confirm a failure by a second method before reporting it.
- Prefer an **independent audit by a different model family** than the one that wrote
  the work.
- Deterministic checks are never waivable — not by Jev, not by a worker's claim.

## 5. Cleanup — worktrees and branches, local *and* remote

Clean up **as soon as the issue is finished**, not "later". A stale worktree lets a worker
branch from dead history.

`gh pr merge --delete-branch` deletes only the **remote** branch. Finish the job:

```bash
$S/stop-pi.sh issue-14 --close workspace     # stops pi, closes only that worker's Space
git worktree remove ../korwf-worktrees/issue-14
git branch -d issue-14-model-cards           # -d, never -D: refuses unmerged commits
git fetch --prune
```

`cleanupWorktree()` in `scripts/orchestrate/run.mjs` does all of this, and
`sweepWorktrees()` runs it per session for closed issues. Both **refuse to remove a
branch holding unmerged commits** — do not override that by hand.

`herdr worktree remove --workspace <id>` removes the checkout and Space but never the
branch; `stop-pi.sh` refuses to close a tab/Space holding other live agents without
`--force`.

### 5.1 Local `main` tracks the remote

Before creating any worktree, and after finishing:

```bash
git -C <repo-root> fetch --prune -q origin
git -C <repo-root> merge --ff-only origin/main
```

`syncMain()` in `run.mjs` does this automatically each scheduling pass. It skips a dirty
or non-`main` checkout rather than forcing anything. Branch workers from current `main`
only. If a push is rejected as non-fast-forward, **rebase** — workers never `--force`.

## 5.2 Autonomy: act, don't ask

Per AGENTS.md §4 as narrowed by ADR 0005, and `jev-orchestration` §1.1:

**reversible + no credential + no consumer impact + not a policy loosening ⇒ act.**

Pushing your own branch, opening a PR, rebasing onto `main`, creating and removing your
own worktree, and merging a green PR that Jev has cleared are all ordinary work — do them.
Escalate only what the owner alone can resolve: spend, credentials, releases, force-pushing
shared history, granting permissions, changes to enforcement code, or a product decision
PLAN.md does not settle. Do not gate on a label as a proxy for risk; judge the actual act.

## 6. Choosing the model

Rank against `cards` in `scripts/orchestrate/config.json`; `profileAndSelect()` in
`run.mjs` asks Jev to do this. Static fallback order is `staticFallbackOrder` in the
same file (used when Jev is unavailable — the system must work with no Jev key).

Do not blindly inherit `$PI_MODEL`. For an independent review, pick a *different*
family from the one that produced the work. Only GPT models on `mac-mini` accept image
input, so delegate screenshots to one of those.

## 7. Helper scripts (in this repo, so workers in fresh clones can run them)

`scripts/spawn-pi.sh`, `scripts/stop-pi.sh` and `scripts/refresh-references.sh` are kept
here deliberately: an agent working in a fresh clone or worktree has this repo but not
necessarily the machine-wide skill. They are kept in sync with the machine-wide copies;
if you change one, change both.

```bash
diff -r .pi/skills/korwf-worker-delegation/scripts \
        ~/.pi/agent/skills/herdr-pi-delegation/scripts && echo in-sync
```

`refresh-references.sh` refreshes the pinned herdr docs in the **machine-wide** skill's
`references/` directory; those documents are not committed to this repo.
