# Architecture decision records

One file per decision, numbered in the order they were accepted. Numbers are never
reused; a superseded ADR keeps its file and gains a `Superseded by` line. A new ADR
continues the numbering from the highest existing one.

Format: `NNNN-short-slug.md` with a header block (Status, Date, Issue/Design authority,
Related), then Context, Decision, Consequences. Status is one of `Proposed`,
`Accepted`, `Superseded by NNNN`, `Deprecated`.

## Index (Stage 1 — Discovery and contracts)

| ADR | Title | Status | Issue | Decides |
|---|---|---|---|---|
| [0001](0001-reuse-of-pi-examples.md) | Reuse, extend, or replace: Pi's shipped example extensions | Accepted | #8 | Per-example reuse/extend/replace table, copy manifest, licence and attribution |
| [0002](0002-source-layout.md) | Source layout | Accepted | #8 | `src/` module tree, dependency direction, `git/`-only git, `security/` consulted never bypassed, `korwf` namespacing |
| [0003](0003-jev-transport.md) | Jev transport — raw `fetch` behind our own interface, not the JS SDK | Proposed (transport decision stands; adapter rules confirmed by [0007](0007-jev-optional-design.md)) | #9 | `JevTransport` seam, model pin, key handling, retries, redaction, accounting |
| [0004](0004-worker-interface.md) | Worker interface: Pi subprocess over RPC | Accepted | #16 | `pi --mode rpc` workers, recursion guards, three-tier cancellation, Herdr visibility |
| [0005](0005-agent-autonomy-and-approval-scope.md) | Agent autonomy and the scope of human approval | Accepted | — | Build-time (not runtime) approval scope for agents working on this repository |
| [0006](0006-sqlite-single-writer.md) | SQLite store with a single writer process | Accepted | #17 | Lockfile ownership, workers never open the store, migrations, append-only triggers, startup reconciliation |
| [0007](0007-jev-optional-design.md) | Jev is optional at runtime | Accepted | #17 | Every Jev question declares a deterministic fallback; optional mode is a first-class, recorded state |
| [0008](0008-code-enforced-policy-after-jev-selection.md) | Jev ranks, code enforces | Accepted | #17 | Five-stage pipeline: filter → Jev → validate → policy → record; Jev answers can only narrow |
| [0009](0009-worktree-isolation-model.md) | Worktree isolation model | Accepted | #17 | One worktree per writing attempt, one integration owner, worktrees are not a security boundary |
| [0010](0010-no-fork-pi-package.md) | KorWF ships as a Pi package; Pi is never forked or patched | Accepted | #17 | Documented-surface allowlist, single import boundary, gaps handled KorWF-side or upstream |

## Related specifications (not ADRs)

- [`docs/threat-model.md`](../threat-model.md) — assets, actors, data-flow diagram,
  trust boundaries with mitigations, residual risks (#17).
- [`docs/records.md`](../records.md), [`docs/state-machine.md`](../state-machine.md),
  [`docs/gates.md`](../gates.md) — record, transition and gate specifications.
- [`docs/config-reference.md`](../config-reference.md) and
  [`src/config/schema.json`](../../src/config/schema.json) — configuration contract.
- [`docs/pi-integration-map.md`](../pi-integration-map.md),
  [`docs/typesafe-api-reference.md`](../typesafe-api-reference.md) — verified external
  surfaces.

## Adding an ADR

1. Take the next number. Reference, do not restate, earlier ADRs.
2. Cite the PLAN section that authorises the decision; if PLAN and the decision disagree,
   raise it on the issue first (AGENTS.md §1).
3. If the decision changes a trust boundary, update `docs/threat-model.md` in the same PR.
4. Add the row here.
