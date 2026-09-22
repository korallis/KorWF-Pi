# Orchestrator playbook — you are the orchestrator

Read this with `SKILL.md`. `SKILL.md` gives the *policy* (escalation, evidence gate,
probability artefacts); this file gives the *loop you personally run*.

## 0. The thing to get right

**This pi session is the orchestrator.** Not a spectator watching `scripts/orchestrate/run.mjs`,
not a commentator on its log. You select work, you ask Jev, you spawn agents, you review,
you merge. `run.mjs` is a *tool you may call* for the mechanical parts (deterministic
checks, Jev question batteries, merge review) — it is not a replacement for you, and
"I started run.mjs" is not orchestration.

Two execution modes exist. Know which one you are in:

| | `run.mjs` batch mode | **agentic mode (default)** |
|---|---|---|
| Worker | headless `pi -p --mode json` subprocess | **real Herdr agent** in a pane (`herdr agent start`) |
| Visible in Agents panel | no (invisible by construction) | **yes, by name** |
| Can be steered mid-task | no | yes (`herdr agent prompt`) |
| Can ask a question | no (`ctx.hasUI === false`) | yes — shows as `blocked` |
| Who decides model | Jev, inside the script | **Jev, asked by you** |
| Use when | long unattended queue, Lee is away | **normal work, Lee is watching** |

Default to agentic mode. Use batch mode only for a long unattended queue, and say so.

### 0.1 The mistake that keeps happening — check yourself here

Typing `node scripts/orchestrate/run.mjs` is the muscle-memory error. It has been made
repeatedly, *including right after writing this playbook*, because the command is short,
familiar, and appears at the top of the orchestrate README. It is not orchestration; it is
handing the job to batch mode and watching a log.

**Before you start any run, answer these three out loud:**

1. Did I ask Jev which issue and which model? (`ask-jev.mjs`) — not "the script will".
2. Will a real pi agent appear in the Agents panel by name? If no, you are in batch mode.
3. Did Lee ask for unattended batch? If no, do not use `run.mjs` to dispatch.

**What Lee sees is the test.** If he opens the worker's pane and finds a `watch` loop
printing `git log` instead of a pi session, you got this wrong — that is batch mode's fake
"surface" pane, not an agent. This exact thing happened on #14: six batch attempts wrote
nothing, and one real agent then finished the issue and opened PR #120.

`run.mjs` still owns `--review` and `--merge`. Using it for those is correct; using it to
*dispatch* when Lee is watching is not.

## 1. Every judgment goes to Jev

"Full agentic" means **no hardcoded judgment**. Before you decide anything non-mechanical,
ask Jev and log it. Code enforces; Jev decides.

| Decision | How |
|---|---|
| Which issue next | `ask-jev.mjs pick-issue` (readiness is code; *priority* is Jev) |
| Which model + thinking | `ask-jev.mjs select-model` — never your own taste, never `$PI_MODEL` |
| Is the issue well-specified | `select-model` returns `sufficient`; < 0.25 → do not dispatch |
| Is a blocker owner-only | `SKILL.md` §1, `triage.mjs`, `escalateOrPark()` |
| Is the work done | `run.mjs --review <n>` (evidence gate) |
| Merge or loop | `run.mjs --merge <n>` (decomposed merge review) |
| Anything you are unsure about | write a probe, log to `.orchestrate/`, act on it |

If you find yourself writing `if` on a judgment, you are doing it wrong — ask Jev.
If Jev is unavailable, fall back **deterministically and say so** (PLAN: the system must
work with no Jev key). Never silently guess.

## 2. The loop

```bash
set -a; . ~/Projects/.env; set +a          # JEV_API_KEY — never forwarded to a worker
S=.pi/skills/korwf-worker-delegation/scripts
```

### 2.1 Sync and pick

```bash
git fetch --prune -q origin && git merge --ff-only origin/main   # skip if dirty/not main
node scripts/orchestrate/ask-jev.mjs pick-issue                  # Jev ranks ready issues
```

Respect milestone order (`SKILL.md` §6). `agent-ready`, lowest open milestone, no open
blockers, not `needs-human`.

### 2.2 Ask Jev for the model

```bash
node scripts/orchestrate/ask-jev.mjs select-model <issue>
```

Returns `{model, thinking, profile:{domain,depth,contextSize,sufficient}, ranking, rule}`,
constrained to `config.json` `allowlist.models` (mac-mini only) and logged to
`.orchestrate/decisions.jsonl`. **Do not override it.** If `sufficient < 0.25`, comment on
the issue and stop — do not dispatch a worker at an under-specified issue.

### 2.3 Spawn a real agent, one per issue, in its own worktree

```bash
# new branch + worktree + nested Space
$S/spawn-pi.sh issue-<n> <model> <thinking> --worktree issue-<n>-<slug> --task "issue #<n>"

# worktree already exists (resuming, or batch mode left one behind)
$S/spawn-pi.sh issue-<n> <model> <thinking> --open-worktree ../korwf-worktrees/issue-<n> --task "issue #<n>"
```

**Verify it is a real agent before prompting** — this is the check that catches the
batch-mode mistake:

```bash
herdr agent list | jq -c '.result.agents[]|{name,agent_status}'   # must list issue-<n>
pgrep -af 'provider mac-mini'                                     # must show a real pi process
```

If `agent list` does not show your worker by name, you have not spawned an agent.

- `--worktree` creates the branch, checkout and a Space that **nests under KorWF-Pi**
  (sidebar nesting is by git worktree identity). Lee can see and click it.
- Never `pane split --current` (that is his tab). Never `workspace create --cwd`.
- Announce on the issue: `gh issue comment <n> -b "Orchestrator: dispatching to mac-mini/<model> (thinking <t>). Selection rule: <rule>."`

### 2.4 Prompt it (self-contained — it has no memory of this chat)

Use the contract in `korwf-worker-delegation` §3: issue number + "read the issue, AGENTS.md
and PLAN.md", the branch it owns, acceptance criteria, the Verification commands to run and
paste, the PR template with `Closes #<n>`, and "comment `Starting — <plan>` first".

Two clauses that are not optional, both learned from #14:

1. **The truncation guard** (§3.1) — paste it verbatim; it is why the agent succeeded
   where six batch attempts wrote nothing:

   > Create each file with a SHORT write, then extend it with successive small edit calls.
   > Never emit more than a few hundred lines in one tool call. Commit after each file so
   > progress survives a truncated turn. Keep your replies to one or two lines — narration
   > spends the same budget the tool call needs.

2. **If the branch already has commits, say so and tell it to inspect first**, or it will
   redo or clobber finished work:

   > A previous attempt already made N commits on this branch. INSPECT FIRST, do not redo
   > finished work: `git log --oneline origin/main..HEAD` and `git status`.

```bash
herdr agent prompt issue-<n> "$(cat <<'EOF'
...task...
When finished, write your complete result as Markdown to /tmp/issue-<n>-result.md
and reply only with that path.
EOF
)" --wait --timeout 2700000
```

### 2.4b Run a fleet — parallel without losing quality

`herdr agent prompt --wait` blocks until the agent settles, which serialises a fleet. Do
not drop `--wait` to get around that: **without it the submission is not reliably
delivered**, and an agent will sit at `0.0%` context while you believe it is working. That
has happened three times here.

Use the helper, which backgrounds the blocking call *and verifies delivery*:

```bash
D=.pi/skills/korwf-worker-delegation/scripts/dispatch-worker.sh
$D issue-15  /tmp/p15.md      # {"agent":"issue-15","delivered":true,...}
$D issue-17  /tmp/p17.md
$D issue-125 /tmp/p125.md
```

It polls the agent out of `idle` and reports `delivered:false` if the prompt did not land
(`agent_prompt_stalled` on a freshly started agent is transient — it retries once). **Never
treat a dispatch as successful without that confirmation.**

What keeps quality up while running several at once:

| Rule | Why |
|---|---|
| One issue, one branch, one worktree, one agent | No two agents ever touch the same files |
| Pick issues with **disjoint deliverables** | Two spec issues writing different docs are safe; two touching `src/models/` are not |
| Respect declared `deps` | `ask-jev.mjs pick-issue` already filters on real issue state |
| Keep `workers.concurrency` (2–3) in mind as the honest ceiling | More agents means more of *your* attention per merge, and review is the bottleneck, not dispatch |
| Review and merge **serially** | Each merge changes `main`; the next PR must rebase onto it and be re-verified (§2.6) |

A fleet does not lower the bar: every PR still passes the same evidence gate, the same
independent re-run of its verification commands, and the same merge review.

### 2.5 Supervise — this is the part batch mode cannot do

```bash
herdr agent list | jq -c '.result.agents[] | {name, agent_status}'
```

- `blocked` → it is asking something. Read it (`herdr agent read <name> --source visible`).
  **Answer it yourself** if PLAN.md/the issue settles it; escalate to Lee only per §1.
  This is the main advantage of agentic mode: a batch worker would have silently guessed.
- `working` far past expectation → read the pane, steer with another `agent prompt`
  rather than killing it.
- `done`/`idle` → collect the result file.

### 2.6 Record the attempt, verify independently, then merge

`--review` and `--merge` read `state.attempts[n]` and require the last attempt to be
`awaiting-review`. A batch run writes that record; **an agentic run must write it too**,
or the gate cannot see the work:

```bash
node scripts/orchestrate/ask-jev.mjs record-attempt <n> \
  --model <model> --thinking <t> --branch <branch> \
  --pr <url> --report-file /tmp/issue-<n>-result.md

node scripts/orchestrate/run.mjs --review <n>    # evidence gate on the attempt
node scripts/orchestrate/run.mjs --merge <n>     # merge review; squash-merges if clean
```

If `--merge` logs *"GitHub has not computed mergeability yet"*, that is a GitHub-side
delay, **not** a defect: the attempt stays `awaiting-review`, so just re-run `--merge <n>`
in a few seconds. Do not loop a worker over it. (This blocked PR #120 once while every Jev
score passed.)

Re-run pasted verification commands literally for anything merge-critical
(`SKILL.md` §4 — a worker once fabricated a transcript and the gate passed it). Prefer an
independent audit by a *different model family* than the one that wrote the code.

If the merge review blocks: its blockers become the next attempt's feedback and you loop
(`SKILL.md` §3.1). Only two things never loop: a genuine `needs-human`, and a diff that
changes enforcement code.

### 2.7 Clean up — immediately, not "later"

```bash
$S/stop-pi.sh issue-<n> --close workspace
git worktree remove ../korwf-worktrees/issue-<n>
git branch -d issue-<n>-<slug>        # -d never -D
git fetch --prune
```

## 3. Liveness — before you ever say "nothing is happening"

An empty Agents panel proves nothing about a *batch* run (headless workers are invisible).
In agentic mode the panel is authoritative. Either way, check what moves:

```bash
pgrep -af 'run.mjs'; pgrep -af 'provider mac-mini'
tail -5 .orchestrate/orchestrator.log
ls -la --time-style=+%H:%M:%S ../korwf-worktrees/issue-<n>/src
ps -o etime= -p <pid>                  # vs workers.timeoutMinutes
```

Silence is normal: a spec issue runs 10–40 minutes with no log line. **Never restart an
orchestrator or kill a worker to "fix" apparent inactivity** without mtime evidence — it
destroys the attempt in flight.

## 3.1 Known failure: output-token truncation (`stopReason: "length"`)

**Symptom.** Repeated attempts "fail the gate" with a clean worktree: no files written, a
final report of 30–100 characters ending mid-sentence, no fenced JSON block, and a high
`overclaims` score. Different models fail identically.

**Cause.** Every turn has a 16384 output-token ceiling, shared with reasoning at
`--thinking high`. A worker that tries to compose a whole document or source file in one
tool call is cut off **before the tool call is emitted**, so nothing reaches disk. This
cost six attempts and ~400k tokens on #14 across two model families before it was found.

**Do not misread it.** The gate will say "unmet criteria" and "overclaims 0.92". Both are
artefacts of an empty worktree. The worker did not overclaim; it was truncated. Escalating
this as a quality problem, or as `needs-human`, is wrong — it is a harness failure.

**Diagnose in one step:**

```bash
jq -r '.attempts["<n>"][] | "\(.model) \(.outcome) stop=\(.stopReason) chars=\(.report|length)"' .orchestrate/state.json
```

`stop=length` with `chars` under ~200 is this bug. If `stopReason` is absent the attempt
predates a1ef22c — re-run one attempt to capture it.

**Handled automatically now:** truncation is outcome `truncated`, does not consume the
attempt budget, does not feed false "you missed the criteria" feedback, and switches model
family after two occurrences. If you see it persist, the prompt is asking for too much in
one turn — split the issue, do not raise the budget.

## 3.2 CI failures are usually real — and usually not the PR's fault

Every CI failure in M2/M3 so far has been a genuine defect, but **three of five belonged to
an earlier merged PR** and only surfaced when a later branch rebased onto it. Fix them on
the branch that hit them, and say whose they were.

| Symptom | Real cause | Fix |
|---|---|---|
| `bad option: --experimental-strip-types` | `engines.node` said 20; the flag needs 22.6 | raise the floor to what the code needs |
| `expected 3.17 to be less than 1` | a wall-clock assertion measures the runner, not the code | assert the *property* (a `setTimeout(0)` has not fired ⇒ no I/O awaited) |
| `expected ['a','b'] to equal ['b','a']` | 0ms-vs-5ms timer race — flaky by construction | gate one call on a promise the other resolves |
| `Cannot read properties of undefined` | **ripgrep is not installed on CI**; `run()` swallowed ENOENT as "no matches" | distinguish *not installed* from *found nothing*; add a `git grep` fallback |
| `expected false to be true` on `tool === "rg"` | the test asserted *which tool ran*, not the requirement | assert the invariant: whatever ran is named honestly |

**The pattern:** a test that passes locally and fails on CI is usually asserting something
about *your machine* — a wall clock, an installed binary, a scheduling race. Reproduce the
CI condition before changing anything:

```bash
# no ripgrep, as on a GitHub runner
D=$(mktemp -d); ln -s "$(command -v git)" "$D/git"; ln -s "$(command -v node)" "$D/node"
PATH="$D:/usr/bin:/bin" npx vitest run <file>
```

And check whether CI *actually ran* the tests rather than skipping them — `# skipped 0`
in the log is the proof, especially for suites that shell out to an external binary.

## 3.3 Parallel-branch collisions: the four kinds, and how each resolves

Running three workers at once produces collisions at the integration boundary, not in the
work itself. All four kinds seen so far are mechanical once recognised:

| Collision | Symptom on rebase | Resolution |
|---|---|---|
| **Barrel exports** | conflict in `src/*/index.ts` | keep both; better, convert the barrel to `export *` so it cannot recur |
| **TODO.md ticks** | adjacent checklist lines | union of ticks — both items really are done |
| **Migration numbers** | `two migration files claim version N`, store refuses | renumber the *later* branch's file; never renumber a merged one |
| **Duplicate symbol** | `TS2308: already exported a member named X` | two genuinely different functions — rename one to say what it does, do not merge them |

Two of these were *caught because* of a safety property rather than in spite of one:
`export *` surfaced a real `checkState` ambiguity that a named barrel would have hidden
behind a hand resolution, and the store's migration guard refused to apply either file
rather than silently picking one.

**ADR numbers collide the same way.** An in-flight branch renumbers **its own** new ADR;
it never edits a merged one. Doing the reverse produced two files titled `ADR 0011` and
corrupted cross-references (#125).

**Stale PR bodies read as dishonesty.** After the orchestrator fixes something on a
branch — a renumbered migration, a renamed symbol — the PR body still describes the old
state, and `honest` drops. Update the body, then re-review: #53 went 0.61 → 0.67 → 0.74
with the diff attached, purely from correcting one filename.

## 4. Hard rules (do not let a long session erode these)

1. Only `mac-mini` models from `config.json` `allowlist.models`. Never fall back to another
   provider if the proxy fails — report it.
2. Never pass credentials to a worker. Herdr panes do not inherit `JEV_API_KEY` (verified);
   keep it that way — never `export` it into a worker pane.
3. Never commit to `main`; one issue, one branch, one worktree, one agent.
4. Never close a pane/tab/Space you did not create; never `herdr server stop`. Closing a
   tab kills every agent in it. Cleanup is `stop-pi.sh` only.
5. Deterministic checks are never waivable — not by Jev, not by a worker's claim, not by you.
6. `needs-human` means *only Lee can resolve it* (spend, credentials, publishing,
   irreversible acts, permissions, unsettled product decisions). Running out of attempts is
   your problem: `orchestrator-stuck`.
7. Run `node scripts/orchestrate/check-layout.mjs` after touching orchestration code.
