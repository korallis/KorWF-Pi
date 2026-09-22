# Output-token budget awareness

**Issue:** #124 · **Design authority:** [docs/PRD.md](PRD.md) §3.3, `PLAN.md` §2.3, §3.C, §3.E, §3.G

## The failure this prevents

Every assistant turn has a hard **output**-token ceiling (`maxTokens` in Pi's model
registry — 16384 on every model in the current registry), shared with reasoning when the
thinking level is high. A turn asked to produce a large artifact in one tool call is
truncated at `stopReason: "length"` **before the tool call is emitted**. Nothing is written
to disk. The turn leaves behind a narration fragment and no result.

Measured in this repository while building it:

| Issue | Attempts | Tokens | Files written | Final message |
|---|---|---|---|---|
| #14 | 6, across two model families | ~400k combined with #11 | 0 | `Now writing docs/gates.md.` (28 chars) |
| #11 | 3 | — | 0 | `Now I have the full picture. Writing the schema.` |

Both presented to the evidence gate as "worker overclaims (p=0.92), criteria unmet" — the
opposite of the truth. The worker had not overclaimed; it had been cut off.

Planning sized tasks against the **context window**. The context window was never the
binding constraint (16384 output vs ≥200 000 context); `maxTokens` was.

## Three behaviours, all deterministic

Nothing below consults Jev, a clock, or the network. The behaviour is identical with Jev
disabled and with no key (PLAN §3.J).

### 1. Planner sizing against `maxTokens` — `src/workflow/output-budget.ts`

`sizeTaskOutput(artifacts, limits, thinking)` sizes each expected artifact against the
*usable single-turn output budget*, not the context window:

```
maxTokens        = registry maxTokens, or ASSUMED_MAX_OUTPUT_TOKENS (16384) when unreported
reasoningReserve = maxTokens × THINKING_RESERVE[thinking]     (off 0, low .1, medium .25, high .5)
usableTokens     = maxTokens − reasoningReserve
decomposeAbove   = usableTokens × DECOMPOSE_FRACTION (0.5)
warnAbove        = usableTokens × WARN_FRACTION      (0.25)
```

Verdicts, worst-wins across the task's artifacts:

| Verdict | Condition | Planner action |
|---|---|---|
| `fits` | ≤ `warnAbove` | none |
| `tight` | ≤ `decomposeAbove` | note it in the plan; little headroom for reasoning |
| `decompose` | > `decomposeAbove` | split into `suggestedSteps` production steps |
| `flag` | > `decomposeAbove` **and** declared `atomic` | surface to the planner; incremental writes cannot fix it |

**Why 0.5.** A turn's output budget is shared between the reasoning trace, the narration
and the tool call carrying the artifact body, so the body can only ever have a fraction of
the ceiling. Half leaves an equal share for everything else. Anything higher reproduces
the #14 signature whenever a model thinks at length.

**Why "unreported ≠ unlimited".** A registry that reports no `maxTokens` yields
`assumed: true` and the conservative 16384 floor. Assuming less only decomposes more;
assuming more is the exact defect this module exists to prevent.

`planIncrementalSteps()` turns a `decompose` verdict into concrete steps: step 1 is a
short `write` creating the file, every later step an `edit` extending it, each under
`decomposeAbove`.

### 2. Truncation as a harness failure — `src/workers/truncation.ts`

`classifyTurn(observation)` reads the recorded `stopReason` — never the length of the
worker's final text, which is an unreliable proxy — and returns a `failureClass`:

- `harness`: `truncated`, `timeout`, `transport_error`, `capped`. The execution
  environment failed; the work was never judged.
- `quality`: the work was judged and found wanting (`gap`).

The ordering matters: truncation is checked **before** anything that inspects the worker's
output, because a truncated turn has no output to inspect. Checking "did it produce a
report?" first is precisely how six identical #14 failures were mislabelled as
overclaiming.

The classification is persisted as `Attempt.termination` (`AttemptTermination` in
`src/storage/records.ts`), not merely logged: `stopReason` verbatim, `truncated`,
`failureKind`, `failureClass`, `consumedAttemptBudget`, `outputTokens`. A `null`
`termination` means "not observed", never "ended cleanly".

### 3. Two budgets, separately bounded — `src/workflow/attempt-budget.ts`

| Budget | Counts | Default | Exhausted → |
|---|---|---|---|
| attempt | turns that produced work to judge | 3 | `attempt_limit` |
| harness-retry | truncation, timeout, transport error, cap | 3 | `harness_limit` |
| consecutive truncations | truncations since the last non-truncated turn | 2 | `persistent_truncation` |

A truncated turn **does not** consume an attempt slot, and its feedback
(`TRUNCATION_FEEDBACK`) describes the truncation and the mechanical remedy. It makes no
claim about the acceptance criteria, because none were assessed — `isHarnessFeedback()`
asserts that, and a test asserts it too.

Because the harness budget is separate and bounded, a task that truncates every time stops
with `persistent_truncation` ("the task is over-sized for this model's output budget:
decompose it before retrying") rather than looping forever, and without ever reporting the
worker as having failed the criteria.

`settleTurn()` in `src/workflow/attempt-controller.ts` composes the two: classify, ignore
any gate result on a harness failure, fold into the budgets, emit feedback and telemetry.

### 4. Worker contracts — `resources/roles/`

One shipped Markdown contract per PLAN §3.E role (scout, planner, implementer, verifier,
reviewer, integrator). Every one carries the incremental-write clause verbatim: short
write, successive small edits, commit after each file or major section, replies of one or
two lines. `loadRole()` **throws** if a contract has lost any of those instructions, so a
future edit cannot silently reintroduce the failure. The planner contract additionally
states that tasks are sized against `maxTokens`, and the reviewer contract that a
truncated attempt must not be reported as unmet criteria.

## Out of scope

Raising `maxTokens` or changing provider parameters. The fix is decomposition, not a
bigger budget.
