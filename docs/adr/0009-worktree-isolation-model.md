# ADR 0009 — Worktree isolation model: change isolation, one integration owner, not a security boundary

- **Status:** Accepted (Stage 1, issue #17).
- **Date:** 2026-09-21
- **Design authority:** PLAN §3.E "Separate Git worktrees for parallel writing workers;
  one integration owner; never concurrent uncontrolled integration into the user's
  tree." and "**Worktrees are change isolation, not security isolation.** Restricted
  execution uses a separately defined sandbox."; §3.G "preserve uncommitted user work";
  §5 (fork/resume reconciles live repository state).
- **Related:** ADR 0001 rows 3 (sandbox not bundled), 5 (checkpoints), 7 (dirty-repo
  guard), 11 (merge/resolve); ADR 0002 (`git/` is the only module that runs git);
  ADR 0004 (worker cwd = worktree); ADR 0006 (store is outside every worktree);
  `docs/threat-model.md` B4, B6, R8, R9, R12.

## Context

Parallel writing workers need somewhere to write that is not each other's files and
not the user's checkout. Git worktrees give that cheaply: same object store, separate
index and working directory, one branch each. What they do **not** give is any
restriction on what a process running inside them can do — a worker's `bash` can `cd`
anywhere, read any file the user can, and write to the user's checkout by absolute
path. PLAN §3.E states this explicitly; this ADR records the consequences so that
no later issue treats "it runs in a worktree" as a permission argument.

Alternatives for the *writing* boundary:

- **A — workers share the user's checkout, serialised.** No parallelism; every worker
  write touches uncommitted user work (A2 in the threat model). Rejected.
- **B — one worktree per writing attempt, one integrator.** Parallel; user checkout
  untouched until integration; conflicts detected in code at integration time.
- **C — full clones per worker.** Same isolation as B, much more disk and time; no
  benefit since the object store is not the boundary either. Rejected.

## Decision

**Option B, with the explicit statement that a worktree is a *change* boundary only.**

### Layout and lifecycle

1. Worktrees live under the store, outside the user's checkout and outside each other:
   `<store>/worktrees/<attemptId>/` (`src/storage/paths.ts` resolves `<store>`;
   default `<project>/.korwf/`, so `.korwf/` must be git-ignored by the product on
   first run and must never itself be inside a worktree — ADR 0006 rule 2 depends on
   this).
2. One worktree per **writing attempt** (implementer, integrator); read-only roles
   (scout, planner, verifier, reviewer) run in a worktree of the base revision too, so
   that their reads are revision-pinned and the user's dirty tree never leaks into
   evidence (`Evidence.revision`, `docs/gates.md` freshness).
3. Branch name `korwf/<workflowId>/<taskId>/<attemptId>`; base = the task's declared base
   revision; `git/worktrees` is the only code that creates or removes them (ADR 0002).
4. Worktrees survive `cancel`, `paused(cap)`, and crashes (`docs/state-machine.md`
   task-cap, task-cancel: "retain worktree"); they are removed only by
   `destructive_cleanup` (a fixed `stop` class) or by the user.

### Integration

5. **One integration owner** per workflow: the integrator role, running as a single
   attempt at a time, is the only writer to the user's branch. It refuses to start when
   the user's tree is dirty (ADR 0001 row 7 mechanism) unless the user explicitly
   stashes or approves; it takes a checkpoint first (row 5); merges attempt branches
   in dependency order; declared-ownership conflicts are detected in code before any
   merge, Jev adds only a coupling *signal*, and "default to serial when coupling is
   uncertain" (PLAN §3.E). Conflicts that survive go to `needs_changes`, never to an
   automatic resolution that touches user work.
6. `local_commit` on an attempt branch is `auto` only in `bounded_autonomous`;
   `remote_push` is `stop` everywhere. Integration into the user's branch is a
   `complete_task`/phase-gate outcome, not a side effect of a worker finishing.
7. Fork/resume of the Pi conversation never rewinds a worktree (PLAN §5): on resume,
   `git/status` reconciles the live tree with the attempt record and reports drift.

### What a worktree does not do

8. **Not a permission boundary.** A worker's authority comes from its role `--tools`,
   the approval classes, and the `tool_call` gate (ADR 0008, threat-model B3/B4) — never
   from its cwd. Path-boundary checks in `security/data-boundaries` compare *resolved*
   absolute paths against the worktree root for `write`/`edit`/custom tools; for `bash`
   this is a classifier, not enforcement (threat-model R7, R8).
9. **Not a secrets boundary.** A worktree contains whatever the repository contains,
   including files the deny lists exclude from *outbound* context; the deny list is
   applied at the outbound filter, not by omitting files from the checkout (sparse
   checkouts are not used — tests need the whole tree).
10. **Not a sandbox.** Network, filesystem outside the tree, and process limits require
    the separately defined sandbox PLAN §3.E names and ADR 0001 row 3 declines to
    bundle. `security/` detects whether the user has installed one and reports it in
    `/korwf status`; the residual is R9.

## Consequences

- `src/git/worktrees.ts`, `src/git/status.ts`, `src/git/checkpoints.ts`,
  `src/git/conflicts.ts` (ADR 0002 module list) implement 1–7; `workflow/integration`
  owns the single-integrator invariant and is tested with two attempts whose declared
  ownership overlaps.
- Disk usage grows with concurrent attempts; bounded by `budgets.workflow.maxConcurrency`
  (default 2) and `storage.artifactRetentionDays`.
- The user's uncommitted work is protected by construction (nothing but the integrator
  writes there, and it refuses when dirty), which is the PLAN §3.G guarantee.
- Anyone proposing "the worker is in a worktree so it can run without the gate" is
  pointed at rule 8 and threat-model B4.
EOF
git add -A && git commit -qm "docs(adr): 0009 worktree isolation model (#17)" && echo ok