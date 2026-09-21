---
name: jev-orchestration
description: How this repository is built — autonomously, by agents, using Jev (TypeSafe System One) for every judgment call. ALWAYS load before running, changing, or reasoning about scripts/orchestrate/*, before escalating anything to the repo owner, before adding or removing a `needs-human` label, before deciding whether work is "done", and before interpreting a Jev probability. Covers the escalation policy (what genuinely needs a human vs what the orchestrator must solve itself), the evidence gate and its known scoring artefacts, delegation to worker agents, worktree/branch cleanup, and milestone ordering.
---

# Jev-driven orchestration

**If you are running the build, read [ORCHESTRATOR-PLAYBOOK.md](ORCHESTRATOR-PLAYBOOK.md)
now.** *You* are the orchestrator — a pi session that picks work, asks Jev, spawns real
Herdr agents, supervises them, reviews and merges. `run.mjs` is a tool you may call for
the mechanical parts; starting it is not the same as orchestrating, and its headless
workers are invisible in the Agents panel. This file is the policy; the playbook is the
loop.

This repository is built by agents from its issue tracker. The orchestrator
(`scripts/orchestrate/run.mjs`, or you in agentic mode) selects work, dispatches workers,
reviews their output and merges. **Jev decides; code enforces.** Anything requiring judgment — is this
complete, is this honest, is this in scope, does this need a human, which approach will
work — is asked of Jev rather than hardcoded or guessed.

Jev is TypeSafe's System One model. It answers typed questions over application state
and returns calibrated probabilities (`noul`), labelled options (`choice`) and graded
scores (`score`). See `scripts/orchestrate/jev.mjs` and the `typesafe-ai` skill.

## 0. Use Jev for problem-solving, not just scoring

The common failure is using Jev only to grade finished work, then falling back on
hardcoded heuristics for everything else. Use it to **decide what to do**:

| Question | Tool |
|---|---|
| Does this blocker genuinely need the owner? | `triage.mjs`, `escalateOrPark()` |
| Which criterion is actually unmet? | `why-incomplete.mjs` |
| Is a milestone ordering constraint real? | `milestone-order.mjs` |
| Which model should take this issue? | `ask-jev.mjs select-model <n>` (agentic) / `profileAndSelect()` (batch) |
| Which issue should I take next? | `ask-jev.mjs pick-issue` |
| Any other judgment call | `ask-jev.mjs ask <n> "<question>"` |
| Is the gate threshold right? | `probe-overclaim.mjs` |

`ask-jev.mjs` imports run.mjs's batteries, so an agentic orchestrator and the batch loop
make the *same* decision from the same evidence, and both log to
`.orchestrate/decisions.jsonl`. All of them degrade deterministically with no Jev key.

When unsure how to proceed, **write a small probe that asks Jev**, log the raw decision
to `.orchestrate/`, and act on it — do not invent a threshold by hand.

## 1. Escalation policy — the most important rule

`needs-human` means **only the repo owner can resolve this**:

- authorising spend or live-API budgets;
- providing or rotating credentials;
- publishing, releasing, or tagging;
- irreversible or destructive actions;
- granting permissions;
- a product decision `PLAN.md` does not already settle.

It does **not** mean "the orchestrator gave up". These are the orchestrator's own
problems and must be solved agentically:

- the attempt budget ran out;
- the evidence gate failed;
- the issue was under-specified;
- a worker wrote a bad PR body or a fabricated verification transcript;
- a check was flaky.

Those get `orchestrator-stuck`, which `run.mjs --retry-stuck` re-admits with a fresh
attempt budget. `escalateOrPark()` asks Jev which case applies, and if Jev is unavailable
it **fails closed** to `needs-human`.

Before escalating anything, ask: *could a capable agent resolve this by reading PLAN.md,
the issue, and the code?* If yes, it is not a human escalation.

### 1.1 Do not gate on a proxy for risk — gate on the act

This is the mistake to avoid, and it has been made twice here (see ADR 0005):

- AGENTS.md §4 once listed "remote pushes" as always needing approval. An agent then
  stopped to ask permission to push a *documentation rename*. Jev: `push_is_human_only`
  **0.16**, `s4_rule_overbroad` **0.70**.
- `mergeReview()` once hard-blocked every issue labelled `risk:high` — 34 of 97 open
  issues, most of them specification documents. Jev: `risk_high_blanket_wrong` **0.89**,
  `judge_risk_from_diff` **0.91**, `docs_only_safe` **0.88**.

A label marks **subject matter**; it does not make the act dangerous. Judge the actual
change. `mergeReview()` now asks Jev `touches_enforcement` — does *this diff* alter code
that enforces security, permissions, the allowlist, spending, credentials or approval
gating? — and hard-blocks on that instead (`security_code_still_gated` **0.88**).

**The test for autonomy:** reversible + no credential + no consumer impact + not a
loosening of policy ⇒ **act**. Otherwise escalate. When genuinely unclear, ask Jev and
log the probe; do not default to escalation *or* to action.

### 1.1a Never escalate because a probability is ambiguous

The owner escalation budget is for questions **only the owner can action**. Waking him
because an aggregate landed near a threshold spends that budget on nothing and trains him
to ignore the signal (Jev: ambiguity-driven escalation degrades the signal, **0.76**).

Made concrete twice in one session. `mergeReview()` blocked on `touches_enforcement >= 0.5`
alone, and escalated:

| PR | touches | reality | owner could action? |
|---|---|---|---|
| #127 (#125) | **0.50** — exactly the threshold | added per-route quota tracking; the only allowlist/credential matches in added lines were two doc comments | no |
| #128 (#15) | 0.65 | added an approval-class taxonomy | no |

"Touches enforcement" answers *is this enforcement code?* — which is **not** the question
that determines authority. The question is *does this **weaken** a control?*

**The rule now, and why it is not a weakening:**

| touches | weakens | tests | outcome |
|---|---|---|---|
| ≥ 0.5 | ≥ 0.5 | any | **escalate** — owner only, never loops |
| ≥ 0.5 | < 0.5 | pass | **merge**, with an audit note on the PR and attempt |
| ≥ 0.5 | < 0.5 | absent or failing | **block** — add tests; `testsExit === null` is not evidence |
| < 0.5 | — | — | normal path |

The evidence requirement is not optional politeness. Jev: a single `weakens_policy`
question **can miss** a subtle weakening — a bug in enforcement code, or a behaviour change
dressed as a refactor — at **0.95**; and such a diff **should** carry independent
verification before an autonomous merge at **0.88**. Enforcement-adjacent code therefore
merges only against a passing test run at that revision. Asking Jev twice is not a
substitute for executing the tests.

PLAN §3.H still holds absolutely: the system never weakens its own permission, allowlist or
spending policy. Narrowing *when we ask the owner* does not narrow *what is forbidden*.

### 1.2 `needs-human` labels are re-validated, not trusted forever

Some labels were applied by the discredited "I gave up" policy and are self-perpetuating:
a labelled issue is never worked, so the label is never revisited. `revalidateNeedsHuman()`
runs once per session and asks Jev, per issue, whether the owner is genuinely required;
it removes the label only on a confident judgment (p ≤ 0.25), never touches `type:approval`
issues, and fails closed when Jev is unavailable. Jev: `stale_labels_must_be_revalidated`
**0.86**, `revalidation_is_self_weakening` **0.13** — correcting a mislabel is not weakening
the policy. A *correctly* applied `needs-human` remains an absolute, non-waivable block.

Triage existing labels with:

```bash
node scripts/orchestrate/triage.mjs            # read-only
node scripts/orchestrate/triage.mjs --apply 8  # act on specific issues
```

## 2. Reading Jev probabilities — known artefacts

**Existential questions inflate with scope size.** A single question of the form "does
this deliver *everything*?" is an existential over the whole scope, so its probability
falls as the scope is itemised more finely — independent of real completeness. Measured
here: the `overclaims` score correlated **r=0.91** with the *number of claims* and only
**r=0.21** with prose length. A scoped re-ask separated it cleanly:
`material_dishonesty` 0.12 vs `unverifiable_but_plausible` 0.93.

**Therefore: decompose.** Ask one bounded question per acceptance criterion and take the
conjunction in code. `mergeReview()` does this (`complete_c0..n` → `complete_min`); the
single `complete` question previously blocked PR #114 at 0.62 while every decomposed
criterion scored 0.83–0.93 and `blocker` came back `nothing_missing`.

A low aggregate score is a prompt to **ask a sharper question**, not proof of a defect.

**`quality` is still an aggregate, and it shows.** `mergeReview()` decomposes `complete`
per criterion but asks `quality` once over the whole diff, so it inherits exactly the
artefact above. Observed twice on documentation-heavy PRs:

| PR | complete_min | in_scope | touches_enforcement | quality | outcome |
|---|---|---|---|---|---|
| #118 (#19) | 0.80 | 0.55 | 0.06 | 1.05 | merged |
| #126 (#17) | 0.78 | 0.87 | 0.04 | **0.71 / 0.73** | merged after investigation |

On #126 every decomposed signal passed and only the single aggregate failed, reproducibly
(0.73, then 0.71 on re-ask). A bounded re-ask — *are these five ADRs within an issue
titled "Record architecture decisions and threat boundaries"?* — returned **0.93**.

**Procedure when only `quality` fails:** do not lower the threshold and do not loop a
worker. Verify each acceptance criterion directly, then ask one bounded question about the
specific doubt (scope creep? unrequested files? a criterion not really met?). Merge only if
the bounded question clears it, and record both scores on the PR for calibration. If this
recurs, decompose `quality` per deliverable the way `complete` already is.

## 3. The evidence gate

`evidenceGap()` gates on deterministic checks first. Overclaim is **corroborating, not
vetoing**: it can only block when some criterion is also weak.

```
pass = prExists && closesRef && scores.length > 0 && unmet.length === 0
       && (oc < overclaimBlock
           || (minP >= overclaimWaiveMinCriterion && oc < overclaimCeiling))
```

Thresholds live in `config.json` and are **calibrated from `.orchestrate/decisions.jsonl`,
never lowered ad hoc** to make something pass. Justification: every merged row had
`minP ≥ 0.75`; every genuine failure `minP ≤ 0.54`.

**Deterministic checks are never waivable** (AGENTS.md §4) — not by Jev, not by a
worker's claim, and not by an auto-merge loop (`deterministic_never_waived` **0.81**).

### 3.1 Auto-merge and the work-until-Jev-agrees loop

When the evidence gate passes, `mergeReview()` runs automatically and **merges without a
human step** if every hard check passes and Jev reports no blockers
(`automerge_when_clean` **0.83**).

When Jev does *not* agree, the PR is **not parked**. Its specific blockers become the next
attempt's feedback and a fresh worker iterates until Jev agrees
(`loop_on_jev_disagreement` **0.87**). The loop is bounded by
`workers.maxAttemptsPerIssue`, after which the issue parks as `orchestrator-stuck`
(`loop_needs_bound` **0.86**). Two blockers never loop, because no amount of reworking
changes who may decide: a `needs-human` label, and a diff Jev judges to change enforcement
code. Those escalate immediately.

## 3.2 A probe can only judge what you send it

Jev answers from the state in the request and nothing else. Ask it about code you did not
include and it answers from *absence of evidence* — which looks identical to a confident
rejection. Measured on #23:

| Question | issue body only | with `--diff` |
|---|---|---|
| "are audit values sha256 hashes, not raw contents?" (true) | **0.15** | **0.98** |
| "is append-only enforced twice?" (true) | 0.23 | **0.95** |
| *control:* "does this PR add a Python interpreter?" (false) | 0.05 | — |

A true claim and an absurd one scored the same. This nearly rejected a correct 4,103-line
PR. `ask-jev.mjs ask` now takes `--diff <branch>` and **refuses** code-shaped questions
without it.

**Before believing any low probability, ask what the model could see.** If the answer is
"not the thing I asked about", the number means nothing — re-ask with the evidence attached
or verify it yourself in the source.

## 4. Verify worker claims independently

A worker once pasted a "verification transcript" that could not have produced its output
(English prose presented as a command; `diff <(fenced tree…)` where `fenced` is not a
command, comparing two empty strings and exiting 0 for the wrong reason). The gate passed
it. An **independent audit by a different model** caught it.

- Ask workers to write long results to `/tmp/<name>-result.md`; pane text scrolls off.
- For anything merge-critical, **re-run the pasted commands literally** and compare.
- Confirm a failure by a second method before reporting it — one `awk` fence-check here
  produced a false "DIFFERS".
- Do not dismiss a gate failure without an independent check. Jev was right about #8 and
  the assistant's spot-check was wrong.

## 4.1 "Nothing is happening" is a claim to verify, not a state to report

`run.mjs` workers are headless `pi -p --mode json` subprocesses, **not** Herdr agents, so
they never appear in the Agents panel (`korwf-worker-delegation` §1.1). A perfectly
healthy run therefore looks identical to a dead one in the sidebar. Establish liveness
from the things that actually move before concluding anything:

```bash
pgrep -af 'run.mjs'                                   # orchestrator alive?
pgrep -af 'provider mac-mini'                         # a worker actually running?
tail -5 .orchestrate/orchestrator.log                 # last decision + timestamp
ls -la --time-style=+%H:%M:%S ../korwf-worktrees/issue-<n>/src   # mtimes = real work
ps -o etime= -p <worker-pid>                          # vs workers.timeoutMinutes (45)
```

A long gap in the log is normal: one worker attempt on a spec issue runs for tens of
minutes with no log line between "dispatching" and its gate result. Silence is not a
stall. Check mtimes in the worktree before touching a running worker, and never restart
an orchestrator to "fix" apparent inactivity without that evidence — it destroys the
attempt in flight.

If Lee cannot see progress, the defect is **observability**, not the orchestrator. Fix
the surface (a nested worktree Space), do not restart the run.

## 5. Delegation and cleanup

Workers are real pi sessions in Herdr panes — there are no sub-agents. See the
`korwf-worker-delegation` skill (`.pi/skills/`) for this repo's rules and the
`herdr-pi-delegation` skill for generic Herdr mechanics; use
`.pi/skills/korwf-worker-delegation/scripts/spawn-pi.sh` and `stop-pi.sh`.
Nest a worker under this repo with `--open-worktree <path>` (sidebar nesting is by git
worktree identity, never by cwd or label).

**Close agents and their Spaces when finished.** Never close a tab or workspace that
holds other live agents — it kills them all; `stop-pi.sh` refuses this without `--force`.

**Never split Lee's tab from code.** `herdr pane split --current` targets the pane the
process was launched from. `herdrSurface()` did this once per dispatch and shredded his
layout while the real work stayed invisible. Long-lived things get their own Space
(`herdr worktree open --path <dir>`, which nests under the project) or their own tab.
A rule written only in a skill governs *you*, not the automation you start — so this one
is enforced by `node scripts/orchestrate/check-layout.mjs`. Run it after changing
anything in `scripts/orchestrate/`, `src/workers/` or `src/extension/`.

**Clean up worktrees when done, local and remote.** `gh pr merge --delete-branch` deletes
only the *remote* branch. `cleanupWorktree()` also removes the worktree, the local branch
and stale tracking refs; `sweepWorktrees()` runs at the end of each session for
closed issues, and **refuses to remove a branch holding unmerged commits**. Remove a
worktree as soon as its issue is finished — do not leave it for a later session.

**Keep local `main` identical to the remote.** `syncMain()` runs at the top of every
scheduling pass and again at the end of the session: `git fetch --prune` then
`merge --ff-only origin/main`. It is deliberately refusing rather than clever — it skips
when the checkout is dirty or not on `main`, and never rewrites history. Workers must
branch from current `main`, never from stale local history. If a push is rejected as
non-fast-forward, **rebase** onto `origin/main`; never `--force` (only the orchestrator
force-pushes, with `--force-with-lease`, and only to rebase a PR branch it owns).

## 6. Milestone ordering

AGENTS.md §2 requires the lowest open milestone first. M0 is entirely `type:approval` —
human gates that no agent can close. Do not treat "M0 is 0% complete" as something to fix
by working around it, and do not let the readiness filter silently skip past it.

Jev's ruling (`milestone-order.mjs`): M0 does **not** block M1 (0.15) because that work is
read-only research, but M0 **does** block M2 (0.93) because M2 writes product code, which
issue #1 ("authorization to implement") explicitly gates. Verify with that probe before
starting a new stage rather than assuming.
