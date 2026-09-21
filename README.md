# KorWF-Pi

A Jev-assisted autonomous development workflow package for [Pi](https://github.com/badlogic/pi-mono).

Plan an application (or a change to one) inside Pi, then say `implement phase N` or
`implement everything`, and have the system carry it out with minimal intervention:
decomposing work, choosing models per task, executing in isolated worktrees, verifying
with real checks, using Jev to detect gaps in evidence, recovering from failures, and
reporting honestly.

> **Status:** planning complete, implementation not started. This repository is being
> built by AI agents working from the issue tracker. See [AGENTS.md](AGENTS.md).

## Documents

| File | Purpose |
| --- | --- |
| [PLAN.md](PLAN.md) | Full design: objectives, pipeline, scope areas A–J, architecture, records, gates, build sequence, release criteria. **Source of truth.** |
| [TODO.md](TODO.md) | Work-item checklist mirrored into GitHub issues. |
| [AGENTS.md](AGENTS.md) | How agents must work in this repository. |

## Core principles (from PLAN.md)

- **Jev is a narrow semantic classifier**, not a coding model, security boundary, or correctness oracle.
- **Deterministic checks gate completion.** Jev cannot waive a failing check; a worker's claim cannot set `done`.
- **Model selection is task-specific, Jev-ranked, allowlist-bounded, budget-bounded, visible, and recorded.**
- **Fully usable without a Jev key** — the deterministic workflow works alone.
- **No user-specific paths, providers, or credentials in shipped code.**
- **The system never weakens its own permission, allowlist, or spending policy.**

## Planned user interface

```
/korwf plan <goal>            investigate and produce a phased plan
/korwf run <phase-id | all>   execute within approved scope and mode
/korwf tasks | phases         boards with dependencies, blockers, evidence
/korwf status                 workers, models, fallbacks, budgets, running cost
/korwf pause | resume | cancel
/korwf review                 artifacts and verification coverage
/korwf why <decision>         decision inputs and policy application
/korwf models                 catalog, cards, availability/caps, pins
/korwf mode                   shadow | advisory | supervised | bounded autonomous
/korwf off                    disable optional assistance (safety controls remain)
/korwf eval                   explicit, budget-approved evaluation runs
```

## Build sequence

Work is organised into eight milestones matching PLAN §8. Each stage has an exit criterion
that must be met before the next begins.

1. Discovery and contracts
2. Package and adapter foundation
3. Context, planning, phases, durable tasks
4. Verification, review, recovery
5. Model catalog, Jev selection, fallback, single-worker execution
6. Parallel orchestration, integration, unattended operation
7. Memory, compaction, handoffs, adaptive improvements
8. Evaluation, hardening, release

## Licence

MIT — see [LICENSE](LICENSE).
