# ADR 0011 — SQLite store with a single writer process

- **Status:** Accepted (Stage 1, issue #17). Implementation in #23 (store) and #21
  (`storage.*` config).
- **Date:** 2026-09-21
- **Design authority:** PLAN §5 "Store: SQLite (decided), single writer process, lockfile
  for coordinator ownership, explicit migrations, append-only audit table, artifact
  directory. Abandoned attempts reconciled on startup."; §3.E (workers), §3.F (evidence).
- **Related:** ADR 0004 (workers are subprocesses that never open the store), ADR 0009
  (worktrees), `docs/records.md` §4 (mutability), `docs/threat-model.md` B7.

## Context

PLAN §5 decides *SQLite*; this ADR records **why one writer**, what "writer" means
when there are N worker processes, and what the lockfile and migrations must guarantee.
The choice is made now because the records spec (`docs/records.md`), the gate spec
(`docs/gates.md`) and the worker interface (ADR 0004) all assume it, and Stage 2 issues
(#19, #21, #23) build on it.

Alternatives considered:

- **A — every process opens the database.** Workers write their own `Attempt`/`Evidence`
  rows. SQLite supports this with WAL and busy timeouts, but (i) a worker gains the
  ability to write *any* table, including `approval` and `evidence` rows it did not earn
  (threat-model T3); (ii) gate predicates read a state that another process may be
  mid-way through changing; (iii) a worker's crash mid-transaction leaves recovery to
  whoever opens next.
- **B — one writer, workers report over RPC.** The orchestrator's Pi process is the only
  holder of a write connection; workers stream events (ADR 0004) and the orchestrator
  turns them into records. Workers never receive the database path.
- **C — a separate daemon process owning the store.** Cleanest isolation, but a third
  process to supervise, to install, to keep alive across Pi restarts; PLAN §J
  (package, no extra setup) argues against.

## Decision

**Option B.** Exactly one process — the Pi session that loaded the `korwf` extension and
won the lockfile — holds the write connection to `<store>/korwf.sqlite`. Everything a
worker produces enters the store through the orchestrator's RPC event handling.

Rules the implementation (#23) must follow:

1. **Lockfile = coordinator ownership.** `storage/lockfile` creates
   `<store>/korwf.lock` (path from `src/storage/paths.ts`) with `O_EXCL`, writes
   `{ pid, startedAt, hostname-hash, packageVersion }`, and holds it for the session.
   A second instance waits `storage.lockTimeoutMs` (default 5000) then fails with a
   clear message naming the holder's pid. A lockfile whose pid is dead is stale and may
   be taken over after the reconciliation step below runs.
2. **Workers never open the database.** The worker command line and environment
   (ADR 0004) carry no store path; `storage/` is not in any role's tool surface. A worker
   with `bash` could still find the file — that is threat-model R13, and the reason for
   rule 5.
3. **Read connections are cheap and many.** `/korwf status`, boards, and `evaluation/`
   replay open read-only connections; readers never block the writer (WAL journal mode,
   set once by the first migration).
4. **Explicit, forward-only migrations** in `storage/migrations/NNNN-*.sql`, applied in a
   transaction, recorded in a `schema_migration` table; the package refuses to open a
   store whose version is newer than it knows. No implicit `CREATE TABLE IF NOT EXISTS`
   outside migrations.
5. **Append-only tables are enforced twice**: at the type level (`UpdatePatch<T> = never`,
   `docs/records.md` §4) and by `BEFORE UPDATE` / `BEFORE DELETE` triggers that
   `RAISE(ABORT)` on `decision`, `evidence`, `model_outcome`, `audit_entry`. Corrections
   are new rows (`supersedesId`).
6. **Every write goes through one serialised queue** in `storage/`, so a gate predicate
   evaluates against a consistent snapshot (`BEGIN IMMEDIATE`). Domain modules never
   hold raw connections.
7. **Reconciliation on startup** (PLAN §5 "abandoned attempts reconciled"): after taking
   the lock, before accepting commands, every `attempt` with `outcome IS NULL` is checked
   against the persisted worker pid/snapshot (ADR 0004): alive ⇒ re-attach; dead ⇒
   `outcome = crashed`, worktree left intact, task transitions per
   `docs/state-machine.md`.
8. **Artifacts** live beside the database (`<store>/artifacts/<attemptId>/…`) and are
   referenced by relative path in `evidence.artifact`; retention is
   `storage.artifactRetentionDays`; deletion never removes a row (rows record the
   artifact as expired).

## Consequences

- `src/storage/` is a leaf module (ADR 0002) exposing typed repositories, a write queue,
  and the lockfile; nothing else imports `better-sqlite3`/`node:sqlite`.
- The orchestrator process is a single point of failure for *writing*; that is
  acceptable because Pi's session is already that for the user, and rule 7 makes a
  restart safe.
- Concurrency limits (PLAN §3.E) are naturally enforced where the writer is.
- A future daemon (option C) remains possible behind the same repository interface if
  multi-session use ever becomes a requirement; nothing here precludes it.
- Threat-model B7 and R13 cite this ADR; changing rule 2 or 5 requires updating them.
