# ADR 0002 — Source layout

- **Status:** Accepted
- **Date:** 2026-09-21
- **Issue:** #8 · **Design authority:** PLAN §4 (layout), §3.J (packaging)
- **Supersedes:** the provisional `src/` tree in PLAN §4 and AGENTS.md §8 (AGENTS.md §8 is
  updated in the same change)

## Context

PLAN §4 states that its `src/` layout "is revised after [the reuse] table exists".
ADR 0001 assigns every reused or extended example a home module. Three needs surfaced
that PLAN §4's tree does not name:

1. **Git operations** — checkpoints (ADR 0001 row 5), dirty-tree checks (row 7),
   worktree lifecycle (rows 1, 3), and conflict parsing (row 11) are all git; PLAN §4 has
   no module for them, and spreading `pi.exec("git", …)` across `workflow/`, `workers/`,
   and `verification/` would make the "preserve uncommitted user work" guarantee (PLAN §G)
   hard to audit.
2. **Reused TUI components** — questionnaire (row 12), task/phase boards (row 4), status
   widget (row 2) are Pi-TUI code with no business logic; they belong under the Pi adapter,
   not in domain modules.
3. **Shipped assets** — role definitions and prompt fragments (row 1), the bundled
   aptitude hints file (PLAN §D layer 2), and versioned Jev question texts (PLAN §6) are
   data that ships with the package, is versioned (PLAN §I records versions), and is read
   at runtime. They are not TypeScript modules.

Everything else in PLAN §4 stands. The decision is therefore **PLAN §4 unchanged plus
three additions**, with the boundaries below made explicit.

## Decision

```text
src/
  extension/     Pi lifecycle adapters, commands, tools, hooks; the only module that
                 imports @earendil-works/pi-coding-agent's ExtensionAPI
    ui/          Pi-TUI components: questionnaire, boards, status widget, dialogs
  workflow/      phases, state machine, scheduler, approvals, unattended policy,
                 recovery, integration ownership
  decisions/     versioned Jev questions and composition policies
  jev/           transport adapter, validation, deadlines, usage, optional-mode
  models/        catalog, model cards, task profiles, Jev selection, caps/fallback
  workers/       subprocess lifecycle, contracts, role loading, handoff to workers
  context/       retrieval, passage selection, capability suggestions
  verification/  checks, evidence, reviews, task and phase gates
  memory/        provenance, summaries, compaction, handoff packets
  storage/       SQLite, migrations, lockfile, artifacts
  security/      data boundaries, privacy defaults, execution policy, secrets
  telemetry/     decision traces, accounting, metrics
  evaluation/    replay, baselines, calibration, regression suites
  config/        schema, defaults, validation, layered merge
  git/           status, checkpoints, worktrees, conflicts (all git invocations)
resources/       shipped, versioned data: roles/, prompts/, model-hints, questions
docs/            architecture decisions (docs/adr/), config reference, specs
test/            unit/, integration/, scenario/ (mirrors src/ paths)
scripts/         probes and maintenance (scripts/probe/ for Stage 1 experiments)
```

### Boundaries

- **Dependency direction.** `extension/` → `workflow/` → everything else. Domain modules
  (`workflow/`, `workers/`, `verification/`, …) never import from `extension/`; they receive
  Pi capabilities as injected interfaces so they are testable offline (PLAN §8 Stage 2
  exit: "offline tests pass"). `git/` and `storage/` are leaf modules with no domain
  imports.
- **`git/` is the only place that runs git.** Any `pi.exec("git", …)` outside `src/git/`
  is a review failure. Every function that can change the working tree or the stash takes
  an explicit worktree path and is audited through `telemetry/`.
- **`security/` is consulted, never bypassed.** Execution-policy and data-boundary checks
  are pure functions over (call, role, mode, config); `extension/` hooks and `workers/`
  both call them, so a worker and the main session cannot diverge in what they allow.
- **`resources/` is read-only at runtime** and carries a version file; PLAN §I requires
  the question-set, policy, and package versions on every record.
- **Namespacing** (PLAN §J): commands `/korwf …`, tools `korwf_*`, storage under
  `<project>/.korwf/`. Enforced by a test in Stage 2 (#19), not by convention.
- **Attribution.** Files adapted from Pi examples carry the header comment and the
  repository the `THIRD_PARTY_NOTICES.md` described in ADR 0001.

### Where ADR 0001's decisions land

| ADR 0001 row | Module |
|---|---|
| 1 subagent | `workers/` (spawn, stream, concurrency, role loader); role files in `resources/roles/` |
| 2 plan-mode | `security/execution-policy`; widget in `extension/ui/` |
| 3 sandbox | `security/` (presence detection); config merge in `config/` |
| 4 todo | `workflow/` + `storage/`; board in `extension/ui/` |
| 5 git-checkpoint | `git/checkpoints`; policy in `workflow/recovery` |
| 6 handoff | `memory/handoff`; command in `extension/` |
| 7 dirty-repo-guard | `git/status`; hook in `workflow/approvals` |
| 8 permission-gate | `security/execution-policy` + `workflow/approvals` |
| 9 protected-paths | `security/data-boundaries` |
| 10 custom-compaction | `memory/compaction` |
| 11 git-merge-and-resolve | `git/conflicts`; policy in `workflow/integration` |
| 12 questionnaire | `extension/ui/questionnaire` |
| 13 structured-output | `workers/contracts` |

## Consequences

- #19 (package manifest, modular layout) creates `src/<module>/index.ts` for the fifteen
  `src/` entries above plus `resources/`, `test/`, and `scripts/`.
- AGENTS.md §8 now reproduces this tree verbatim and points here; later revisions edit
  this ADR (or supersede it) and AGENTS.md §8 in the same PR.
- PLAN §4's tree is not edited; PLAN delegates the revision to Stage 1 and this ADR is the
  record of it.
