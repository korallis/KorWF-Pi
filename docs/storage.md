# The KorWF store

**Status:** implemented in issue #23. **Design authority:** PLAN §5, §3.E (coordinator
lock), [ADR 0006](adr/0006-sqlite-single-writer.md). Record shapes and their revision
semantics live in [records.md](records.md); path resolution in
[`src/storage/paths.ts`](../src/storage/paths.ts) (#19).

This document describes what is on disk, who may open it, and what the store guarantees.

## 1. What is on disk

Everything lives under the storage root, `<project>/.korwf/` by default:

```
.korwf/
  korwf.sqlite            the store (WAL mode → also korwf.sqlite-wal / -shm while open)
  korwf.lock              coordinator ownership: { pid, startedAt, hostHash, packageVersion }
  artifacts/
    <attemptId>/
      manifest.json       every artifact with its SHA-256, media type, size, expiry
      <files…>            command output, diffs, review notes
```

Nothing is written outside this directory. No absolute path and no hostname is ever
persisted: the lockfile stores a salted hash of the host, `evidence.artifact` stores a
path relative to `artifacts/`, and provenance stores repository-relative paths.

## 2. Driver

Node's built-in **`node:sqlite`**. It requires Node ≥ 22.13 (see
[platform-support.md](platform-support.md)), adds no dependency, and needs no native build
step — which matters for a Pi package, because a failed native build would disable the
whole workflow. `src/storage/sqlite.ts` is the only module that loads it; the rest of
`src/storage/` and all domain modules use the typed repositories.

## 3. Single writer

Exactly one process may write (ADR 0006). Ownership is the lockfile, created with
`O_EXCL`:

| Situation | Result |
|---|---|
| No lockfile | Lock created; `report.lock.kind === "created"`. |
| Held by a **live** pid | Waits `storage.lockTimeoutMs` (default 5000), then throws `StoreLockedError` (`KORWF_STORE_LOCKED`) naming the holder's pid. |
| Held by a **dead** pid | Stale: the lock is taken over, `kind === "took_over_stale"`, and an audit row with actor `korwf:lock` records the displaced pid. |
| Lockfile unreadable | Treated as stale (a crash left it behind) and taken over. |
| `writable: false` | No lock is taken at all; a read-only connection is opened. |

A second process that only needs to read — `/korwf status`, boards, replay — calls
`openStoreReadOnly(root)` and is never blocked by the writer (WAL). Any write call on a
read-only handle throws `ReadOnlyStoreError`.

**Workers never open the store.** Their command line and environment carry no store path
(ADR 0004, rule 2); everything a worker produces enters the store through the
coordinator's RPC event handling.

## 4. Migrations

Numbered, forward-only SQL files in `src/storage/migrations/NNNN-name.sql`, applied on
open, each inside `BEGIN IMMEDIATE`, each recorded in `schema_migration` with its
SHA-256. There are no down migrations and no `CREATE TABLE IF NOT EXISTS` anywhere else:
if it is not in a numbered file, it does not exist.

- A crash mid-migration rolls back; the store stays at the previous version with no
  partial schema (`test/unit/storage/migrations.test.ts`).
- A store whose recorded version is **newer** than the package knows is refused with
  `SchemaTooNewError` rather than guessed at.
- The upgrade test matrix walks every intermediate version and grows automatically as
  `0002-*.sql`, `0003-*.sql` are added.

### Adding a migration

1. Add `src/storage/migrations/000N-what-it-does.sql` — the next consecutive number.
2. Never edit a shipped migration: its checksum is recorded in every existing store.
3. If the change alters a record type, update `src/storage/records.ts`,
   [records.md](records.md), and the relevant `TableSpec` in `src/storage/repos/specs.ts`
   in the same PR. `test/unit/storage/schema.test.ts` fails if they drift.
4. Append-only tables need `BEFORE UPDATE`/`BEFORE DELETE` triggers in the migration that
   creates them.

## 5. Storage shape

Each table has: the envelope (`id`, `createdAt`, `updatedAt`, `schemaVersion`), the
columns that are joined, filtered, or foreign-keyed on, and a `payload` column holding the
whole record as canonical JSON (object keys sorted, so hashes are stable). Nested foreign
keys written `a.b` in [records.md §9](records.md) are promoted to real columns —
`decision.subjectTaskId`, `approval.scopeTaskId`, `memory.sourceDecisionId` — so SQLite
enforces them. `PRAGMA foreign_keys = ON` on every connection.

## 6. Append-only and audit

`decision`, `evidence`, `model_outcome` and `audit_entry` are append-only, enforced twice:

- their repositories are `AppendOnlyRepository`, which has no `update`/`delete` method;
- `BEFORE UPDATE`/`BEFORE DELETE` triggers `RAISE(ABORT, '<table> is append-only')`.

Corrections are new rows (`Evidence.supersedesId`, a new `Decision` with a new
`stateHash`). Nothing is deleted.

Every mutable insert, update and delete writes one `audit_entry` with the actor, the
timestamp, and SHA-256 hashes of the record before and after. **Values are never copied
into the audit row** — only hashes — so the audit log cannot become a second copy of
user data. `store.setActor()` changes the recorded actor; reconciliation writes as
`korwf:reconciler` and lock takeover as `korwf:lock`.

## 7. The write queue

Every mutating call goes through `store.write(fn)`, which wraps the work in
`BEGIN IMMEDIATE`. Nested calls join the outer transaction rather than starting a new
one, so a multi-record change is atomic and a gate predicate always evaluates against a
consistent snapshot (ADR 0006 rule 6). A rule rejection rolls the whole transaction back.

## 8. Startup reconciliation

After taking the lock and before accepting commands, `openStore` reconciles every
`attempt` with `outcome IS NULL` (PLAN §5 "abandoned attempts reconciled on startup"):

- worker **alive** ⇒ `onReattach` is called and the attempt is left open;
- worker **gone** ⇒ `outcome = "abandoned"`, `endedAt` stamped, audit row written; the
  worktree is left intact.

`src/storage/reconcile.ts` owns the store half only. The liveness probe is injected: the
default (`assumeWorkersGone`) treats every worker as gone, which is the safe reading for a
store just opened by a new process. Stage 5 supplies the real probe and the task-state
follow-up per [state-machine.md](state-machine.md). Reconciliation is idempotent.

Pass `reconcile: false` to `openStore` to install a probe before reconciling.

## 9. Artifacts

`ArtifactStore` writes under `artifacts/<attemptId>/` and maintains `manifest.json`.
Retention (`storage.artifactRetentionDays`) deletes **bytes**, never rows: the manifest
entry survives with `expiredAt` set, so an evidence row still explains what was captured
and why it is gone. Paths containing `..` or starting with `/` are refused.

## 10. Errors

Every failure a caller can act on has a class and a stable `code`:
`KORWF_STORE_LOCKED`, `KORWF_LOCKFILE_CORRUPT`, `KORWF_SCHEMA_TOO_NEW`,
`KORWF_MIGRATION_FAILED`, `KORWF_RECORD_RULE`, `KORWF_STORE_READONLY`,
`KORWF_RECORD_NOT_FOUND`. All extend `StoreError`. Messages name the project path
involved (the user's own) and never a credential.
