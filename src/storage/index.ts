/**
 * SQLite, migrations, lockfile, artifacts (KorWF-Pi module, see
 * docs/adr/0002-source-layout.md).
 *
 * Only `paths.ts` (storage root resolution, issue #19) is implemented so
 * far. The store itself (SQLite, migrations, lockfile ownership) is issue
 * #23 and later.
 */
export {
  DEFAULT_STORAGE_DIR_NAME,
  resolveStorageRoot,
  resolveDatabasePath,
  resolveLockfilePath,
  resolveArtifactDir,
} from "./paths.ts";
export type { RecordTypes, RecordTable, AnyRecord } from "./records.ts";
