# Working in this repository (for agents)

This project is built by AI agents from the GitHub issue tracker. Read this file fully
before doing anything. If your context has been compacted, **re-read this file and the
issue you are working on** — every issue is written to be self-contained.

## 1. Source of truth

- **[PLAN.md](PLAN.md)** is the design authority. If an issue and PLAN.md disagree, stop
  and raise it on the issue; do not silently pick one.
- **[TODO.md](TODO.md)** mirrors the issue list. Tick items there in the same PR that
  closes the issue.
- Each GitHub issue quotes the governing PLAN sections inline, so you can work from the
  issue alone after compaction.

## 2. Picking work

1. Only take issues labelled **`agent-ready`** (no open blockers) in the **lowest open
   milestone**. Stages are ordered by dependency; do not start Stage N+1 work while Stage N
   has open issues unless the issue explicitly says it is independent.
2. Read the issue's **Blocked by** list. If any linked issue is still open, the label is
   stale — do not start; comment on the issue instead.
3. Comment `Starting — <short plan>` on the issue before you begin so other agents do not
   duplicate the work.

## 3. Doing the work

- **One issue per branch.** Branch name: `issue-<number>-<short-slug>`.
- Use a separate git worktree if other agents may be active: `git worktree add ../korwf-issue-<n> -b issue-<n>-<slug>`.
- Never commit to `main` directly.
- Every commit message references the issue: `feat(models): add model card merge (#42)`.
  Use conventional-commit prefixes: `feat`, `fix`, `test`, `docs`, `refactor`, `chore`, `spec`.
- Keep the scope to what the issue says. If you discover adjacent work, **open a new issue**
  with full context rather than expanding scope.

## 4. Non-negotiable constraints (from PLAN §2.4, §7, §10)

These apply to every issue regardless of what it says:

- **No credentials, user-specific paths, or provider names hardcoded** in shipped code.
  Secrets come from env vars or Pi's secrets facility only. `.env*` is git-ignored and
  must stay that way.
- **Deterministic checks cannot be waived** by Jev, by a worker's claim, or by any tool
  path. Do not add bypasses "for testing".
- **The system must work with no Jev key.** Every Jev-assisted decision needs a
  deterministic fallback.
- **The system never weakens its own permission, allowlist, or spending policy.**
- **High-risk actions** (destructive cleanup, deployment, credential access, publishing,
  remote pushes) require explicit approval regardless of mode.
- **Mocked tests never authorise live requests.** Live Jev or model calls need an explicit
  budget approved by the user on the issue.
- **Development-environment policy** (author-specific, PLAN §11): when running Pi models
  during development, use only the `mac-mini` provider through the product's own
  allowlist config. Never hardcode this in shipped code.

## 5. Definition of done

An issue is done only when **all** of its acceptance criteria are met and:

1. The commands listed under **Verification** in the issue exit 0, and you have pasted
   the output (or a summary with exit codes) in the PR description.
2. New behaviour has tests. Test names reference the acceptance criterion they exercise.
3. The corresponding TODO.md item is ticked.
4. No `.env`, key, or credential appears in the diff (`git diff --cached | grep -iE 'apikey|secret|token'` is empty or false-positive-explained).
5. The PR body uses the template in §6 and says `Closes #<n>`.

A code path existing is not "done". Permissions, failure behaviour, observability, and
acceptance criteria all have to be satisfied (TODO.md "Definition of complete").

## 6. PR template

```
Closes #<n>

## What
<one paragraph: what was built and why, in terms an agent with no context can follow>

## Acceptance criteria
- [x] <criterion 1> — evidence: <test name / command / file>
- [x] <criterion 2> — evidence: ...

## Verification output
<command> → exit 0
<command> → exit 0

## Decisions and deviations
<anything you decided that the issue left open, or where you deviated from it and why>

## Follow-ups opened
#<n>, #<m>  (or "none")
```

## 7. Handoff and compaction hygiene

- Before any long step, write progress to the issue as a comment: what is done, what is
  next, any open question. Assume you may lose context at any moment.
- If you stop without finishing, comment `Paused — <state>` and push your branch so
  another agent can resume.
- Do not rely on chat history for requirements. The issue and PLAN.md are the memory.

## 8. Repository layout (decided in [docs/adr/0002-source-layout.md](docs/adr/0002-source-layout.md))

```
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

Boundaries that reviewers enforce (details in ADR 0002): domain modules never import
`extension/`; `src/git/` is the only place that runs git; `security/` checks are pure
functions called by both the extension hooks and `workers/`; everything user-facing is
namespaced `korwf`. Reuse decisions for Pi's shipped examples are in
[docs/adr/0001-reuse-of-pi-examples.md](docs/adr/0001-reuse-of-pi-examples.md). If a
later ADR revises the layout, update this section in the same PR.

## 9. Pi reference material

Pi docs and examples are installed locally at
`/home/lee/.local/share/mise/installs/pi/0.86.0/pi/` (`README.md`, `docs/`, `examples/`).
When an issue references `docs/extensions.md`, `docs/packages.md`, etc., resolve them
there. Read cross-referenced `.md` files completely before implementing Pi integration.
