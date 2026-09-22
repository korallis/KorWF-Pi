/**
 * SQLite store, migrations, lockfile, artifacts (KorWF-Pi module, see
 * docs/adr/0002-source-layout.md and docs/adr/0006-sqlite-single-writer.md).
 *
 * This is the only module in the package that imports a SQLite driver
 * (`node:sqlite`). Domain modules use the typed repositories on `Store`;
 * they never hold a raw connection.
 *
 * **Re-export style: `export *`, deliberately.** Listing every symbol explicitly makes this
 * barrel a guaranteed merge conflict: four consecutive PRs each appended an export block to
 * `src/workflow/index.ts` and each had to be resolved by hand, always by keeping both.
 * `export *` is additive, so modules added in parallel do not conflict; a genuine
 * duplicate-name clash still fails the build, which is what we want to hear about.
 */
export * from "./action-log.ts";
export * from "./gate-receipts.ts";
export * from "./artifacts.ts";
export * from "./db.ts";
export * from "./decision-cache.ts";
export * from "./errors.ts";
export * from "./lock.ts";
export * from "./migrations.ts";
export * from "./paths.ts";
export * from "./reconcile.ts";
export * from "./records.ts";
export * from "./recovery-log.ts";
export * from "./sqlite.ts";
export * from "./trace-store.ts";
export * from "./transition-log.ts";
