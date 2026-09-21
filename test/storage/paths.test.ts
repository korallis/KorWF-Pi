/**
 * Tests for src/storage/paths.ts (issue #19).
 *
 * Exercises acceptance criterion: "No command, tool, or storage path lacks
 * the korwf prefix" — the storage root and its children are namespaced.
 */
import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import {
  DEFAULT_STORAGE_DIR_NAME,
  resolveStorageRoot,
  resolveDatabasePath,
  resolveLockfilePath,
  resolveArtifactDir,
} from "../../src/storage/paths.ts";

describe("resolveStorageRoot (AC: storage path namespaced korwf)", () => {
  it("defaults to <project>/.korwf", () => {
    expect(DEFAULT_STORAGE_DIR_NAME).toBe(".korwf");
    expect(resolveStorageRoot("/project")).toBe(join("/project", ".korwf"));
  });

  it("resolves a relative override against the project root", () => {
    expect(resolveStorageRoot("/project", "state/korwf")).toBe(resolve("/project", "state/korwf"));
  });

  it("resolves an absolute override as-is", () => {
    expect(resolveStorageRoot("/project", "/elsewhere/korwf")).toBe(resolve("/elsewhere/korwf"));
  });

  it("treats an empty override the same as no override", () => {
    expect(resolveStorageRoot("/project", "")).toBe(join("/project", ".korwf"));
  });
});

describe("storage sub-paths stay under the storage root", () => {
  const root = resolveStorageRoot("/project");

  it("database path is under the storage root", () => {
    expect(resolveDatabasePath(root)).toBe(join(root, "korwf.sqlite"));
  });

  it("lockfile path is under the storage root", () => {
    expect(resolveLockfilePath(root)).toBe(join(root, "korwf.lock"));
  });

  it("artifact dir is under the storage root", () => {
    expect(resolveArtifactDir(root)).toBe(join(root, "artifacts"));
  });
});
