---
name: jev-orchestration
description: How this repository is built — autonomously, by agents, using Jev (TypeSafe System One) for every judgment call. ALWAYS load before running, changing, or reasoning about scripts/orchestrate/*, before escalating anything to the repo owner, before adding or removing a `needs-human` label, before deciding whether work is "done", and before interpreting a Jev probability. Covers the escalation policy (what genuinely needs a human vs what the orchestrator must solve itself), the evidence gate and its known scoring artefacts, delegation to worker agents, worktree/branch cleanup, and milestone ordering.
---

# Jev-driven orchestration

This repository is built by agents from its issue tracker. The orchestrator
(`scripts/orchestrate/run.mjs`) selects work, dispatches workers, reviews their output
and merges. **Jev decides; code enforces.** Anything requiring judgment — is this
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
| Which model should take this issue? | `profileAndSelect()` in `run.mjs` |
| Is the gate threshold right? | `probe-overclaim.mjs` |

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
attempt budget. `escalateOrPark()` asks Jev which case applies; `risk:high` always
escalates regardless (AGENTS.md §4), and if Jev is unavailable it **fails closed** to
`needs-human`.

Before escalating anything, ask: *could a capable agent resolve this by reading PLAN.md,
the issue, and the code?* If yes, it is not a human escalation.

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
worker's claim.

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

## 5. Delegation and cleanup

Workers are real pi sessions in Herdr panes — there are no sub-agents. See the
`korwf-worker-delegation` skill (`.pi/skills/`) for this repo's rules and the
`herdr-pi-delegation` skill for generic Herdr mechanics; use
`.pi/skills/korwf-worker-delegation/scripts/spawn-pi.sh` and `stop-pi.sh`.
Nest a worker under this repo with `--open-worktree <path>` (sidebar nesting is by git
worktree identity, never by cwd or label).

**Close agents and their Spaces when finished.** Never close a tab or workspace that
holds other live agents — it kills them all; `stop-pi.sh` refuses this without `--force`.

**Clean up worktrees when done, local and remote.** `gh pr merge --delete-branch` deletes
only the *remote* branch. `cleanupWorktree()` also removes the worktree, the local branch
and stale tracking refs; `sweepWorktrees()` runs at the end of each session for
closed issues, and **refuses to remove a branch holding unmerged commits**.

## 6. Milestone ordering

AGENTS.md §2 requires the lowest open milestone first. M0 is entirely `type:approval` —
human gates that no agent can close. Do not treat "M0 is 0% complete" as something to fix
by working around it, and do not let the readiness filter silently skip past it.

Jev's ruling (`milestone-order.mjs`): M0 does **not** block M1 (0.15) because that work is
read-only research, but M0 **does** block M2 (0.93) because M2 writes product code, which
issue #1 ("authorization to implement") explicitly gates. Verify with that probe before
starting a new stage rather than assuming.
