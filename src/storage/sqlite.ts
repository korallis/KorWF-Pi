/**
 * The one place the SQLite driver is loaded (ADR 0006: "nothing else imports
 * `better-sqlite3`/`node:sqlite`").
 *
 * The driver is Node's built-in `node:sqlite` (available unflagged from Node
 * 22.13; see `docs/platform-support.md`). It is loaded through `createRequire`
 * rather than a static `import` because bundler-based tooling in the test
 * harness (vite-node, used by vitest) normalises `node:sqlite` to `sqlite`
 * before checking it against `module.builtinModules` — and `sqlite` is only
 * ever listed with its `node:` prefix, so the bundler tries to resolve it as a
 * file and fails. `createRequire` is plain Node resolution, which has no such
 * step. Types still come from `node:sqlite` via a type-only import, which is
 * erased at compile time.
 */
import { createRequire } from "node:module";
import type {
  DatabaseSync as DatabaseSyncType,
  SQLInputValue as SQLInputValueType,
  StatementSync as StatementSyncType,
} from "node:sqlite";

interface NodeSqliteModule {
  readonly DatabaseSync: new (
    path: string,
    options?: { readonly readOnly?: boolean },
  ) => DatabaseSyncType;
}

const sqlite = createRequire(import.meta.url)("node:sqlite") as NodeSqliteModule;

/** Synchronous SQLite connection. See `node:sqlite` documentation. */
export const DatabaseSync = sqlite.DatabaseSync;

export type Database = DatabaseSyncType;
export type Statement = StatementSyncType;
/** Values SQLite accepts as a bound parameter. */
export type SqlInputValue = SQLInputValueType;
