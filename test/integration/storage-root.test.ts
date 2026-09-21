/**
 * Integration test (issue #20 AC1: real integration test).
 *
 * Exercises `src/storage/paths.ts` against a real, isolated filesystem: it
 * resolves the storage root for a fake project, creates it and the artifact
 * directory on disk, writes files at the resolved database/lockfile paths,
 * and asserts everything lands under the temp project root and nowhere
 * else. This is "integration" rather than unit because it crosses the
 * module boundary into real `node:fs` I/O via the temp-dir fixture, the way
 * a caller (e.g. the extension's storage bootstrap) will.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../helpers/temp-dir.ts";
import {
  DEFAULT_STORAGE_DIR_NAME,
  resolveArtifactDir,
  resolveDatabasePath,
  resolveLockfilePath,
  resolveStorageRoot,
} from "../../src/storage/paths.ts";

describe("storage root bootstrap (integration)", () => {
  it("creates the default storage tree entirely inside the project root", async () => {
    await withTempDir((projectRoot) => {
      const storageRoot = resolveStorageRoot(projectRoot);
      const artifactDir = resolveArtifactDir(storageRoot);
      const dbPath = resolveDatabasePath(storageRoot);
      const lockPath = resolveLockfilePath(storageRoot);

      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(dbPath, "");
      writeFileSync(lockPath, String(process.pid));

      expect(storageRoot).toBe(`${projectRoot}/${DEFAULT_STORAGE_DIR_NAME}`);
      expect(existsSync(artifactDir)).toBe(true);
      expect(existsSync(dbPath)).toBe(true);
      expect(existsSync(lockPath)).toBe(true);
      // Nothing escapes the project root.
      for (const p of [storageRoot, artifactDir, dbPath, lockPath]) {
        expect(p.startsWith(projectRoot)).toBe(true);
      }
    });
  });

  it("honours an absolute override and still creates a usable tree", async () => {
    await withTempDir(async (projectRoot) => {
      await withTempDir((overrideRoot) => {
        const storageRoot = resolveStorageRoot(projectRoot, overrideRoot);
        mkdirSync(resolveArtifactDir(storageRoot), { recursive: true });

        expect(storageRoot).toBe(overrideRoot);
        expect(existsSync(resolveArtifactDir(storageRoot))).toBe(true);
        // Override roots are honoured, not silently forced under the project.
        expect(storageRoot.startsWith(projectRoot)).toBe(false);
      });
    });
  });

  it("honours a project-relative override, resolved under the project root", async () => {
    await withTempDir((projectRoot) => {
      const storageRoot = resolveStorageRoot(projectRoot, "state/korwf");
      mkdirSync(storageRoot, { recursive: true });

      expect(storageRoot).toBe(`${projectRoot}/state/korwf`);
      expect(existsSync(storageRoot)).toBe(true);
    });
  });
});
