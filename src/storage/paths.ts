/**
 * Storage root resolution (issue #19 Scope).
 *
 * KorWF-Pi's on-disk state (SQLite database, artifacts, lockfile) lives
 * under a single namespaced directory rooted at the project. Nothing is
 * ever written into the user's source tree outside this directory.
 *
 * Default: `<project>/.korwf/`. Overridable by config (see `src/config/`,
 * not yet implemented) via an absolute or project-relative path; when
 * overridden, the resolved path must still be inside the project unless the
 * caller explicitly opts out (future config work — out of scope here).
 *
 * No I/O happens in this module; it only computes paths. Callers create the
 * directory when they first need to write to it.
 */
import { join, resolve, isAbsolute } from "node:path";

/** Name of the default storage directory, relative to the project root. */
export const DEFAULT_STORAGE_DIR_NAME = ".korwf";

/**
 * Resolve the KorWF storage root for a given project directory.
 *
 * @param projectRoot Absolute path to the project root (e.g. `ctx.cwd`).
 * @param override Optional override from config: an absolute path, or a
 *   path relative to `projectRoot`. When omitted, resolves to
 *   `<projectRoot>/.korwf`.
 */
export function resolveStorageRoot(
  projectRoot: string,
  override?: string,
): string {
  if (override === undefined || override === "") {
    return join(projectRoot, DEFAULT_STORAGE_DIR_NAME);
  }
  return isAbsolute(override)
    ? resolve(override)
    : resolve(projectRoot, override);
}

/** Path to the SQLite database file under the storage root. */
export function resolveDatabasePath(storageRoot: string): string {
  return join(storageRoot, "korwf.sqlite");
}

/** Path to the coordinator lockfile under the storage root. */
export function resolveLockfilePath(storageRoot: string): string {
  return join(storageRoot, "korwf.lock");
}

/**
 * Path to the *coordinator* lockfile under the storage root (issue #77).
 *
 * Deliberately a different file from `resolveLockfilePath`: the store lock
 * (#23) protects the database, the coordinator lock protects the right to
 * schedule. A read-only session may hold neither, a writer holds the store
 * lock without scheduling, and only a `/korwf run` takes this one.
 */
export function resolveCoordinatorLockPath(storageRoot: string): string {
  return join(storageRoot, "korwf-coordinator.lock");
}

/** Path to the artifact directory under the storage root. */
export function resolveArtifactDir(storageRoot: string): string {
  return join(storageRoot, "artifacts");
}
