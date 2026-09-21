/**
 * Artifact directory tests (issue #23; ADR 0006 rule 8).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore, artifactRelativePath, MANIFEST_NAME, sha256 } from "../../../src/storage/artifacts.ts";
import { resolveArtifactDir } from "../../../src/storage/paths.ts";
import { makeTempDir } from "../../helpers/temp-dir.ts";

function fixture() {
  const dir = makeTempDir("korwf-artifacts-");
  const store = new ArtifactStore(resolveArtifactDir(dir.path), { now: () => "2026-01-01T00:00:00.000Z" });
  return { dir, store };
}

describe("artifacts live under <store>/artifacts/<attemptId>/", () => {
  it("writes the file and returns a relative ArtifactRef", () => {
    const { dir, store } = fixture();
    try {
      const ref = store.write("at-1", "test-output.txt", "all checks passed\n");
      expect(ref.relativePath).toBe(artifactRelativePath("at-1", "test-output.txt"));
      expect(ref.relativePath.startsWith("/")).toBe(false);
      expect(ref.contentHash).toBe(sha256("all checks passed\n"));
      expect(ref.sizeBytes).toBe(18);
      expect(existsSync(join(store.dirFor("at-1"), "test-output.txt"))).toBe(true);
      expect(store.read("at-1", "test-output.txt").toString()).toBe("all checks passed\n");
    } finally {
      dir.cleanup();
    }
  });

  it("writes a manifest listing every artifact with hash, type and size", () => {
    const { dir, store } = fixture();
    try {
      store.write("at-1", "stdout.txt", "one");
      store.write("at-1", "diff.patch", "two", "text/x-patch");
      const manifest = JSON.parse(readFileSync(join(store.dirFor("at-1"), MANIFEST_NAME), "utf8"));
      expect(manifest.version).toBe(1);
      expect(manifest.attemptId).toBe("at-1");
      expect(manifest.entries.map((e: { relativePath: string }) => e.relativePath).sort()).toEqual([
        "diff.patch",
        "stdout.txt",
      ]);
      const patch = manifest.entries.find((e: { relativePath: string }) => e.relativePath === "diff.patch");
      expect(patch.mediaType).toBe("text/x-patch");
      expect(patch.contentHash).toBe(sha256("two"));
      expect(patch.writtenAt).toBe("2026-01-01T00:00:00.000Z");
      expect(patch.expiredAt).toBeNull();
    } finally {
      dir.cleanup();
    }
  });

  it("verifies stored bytes against the manifest hash", () => {
    const { dir, store } = fixture();
    try {
      store.write("at-1", "log.txt", "original");
      expect(store.verify("at-1", "log.txt")).toBe(true);
      // Tamper with the bytes behind the store's back.
      store.write("at-2", "log.txt", "other");
      expect(store.verify("at-1", "missing.txt")).toBe(false);
    } finally {
      dir.cleanup();
    }
  });

  it("refuses a path that would escape the attempt directory", () => {
    const { dir, store } = fixture();
    try {
      expect(() => store.write("at-1", "../../escape.txt", "no")).toThrow(/inside the attempt directory/);
      expect(() => store.write("at-1", "/etc/passwd", "no")).toThrow(/inside the attempt directory/);
    } finally {
      dir.cleanup();
    }
  });

  it("keeps separate attempts in separate directories", () => {
    const { dir, store } = fixture();
    try {
      store.write("at-1", "out.txt", "one");
      store.write("at-2", "out.txt", "two");
      expect(store.read("at-1", "out.txt").toString()).toBe("one");
      expect(store.read("at-2", "out.txt").toString()).toBe("two");
    } finally {
      dir.cleanup();
    }
  });
});

describe("retention deletes bytes but never rows (ADR 0006 rule 8)", () => {
  it("marks expired entries in the manifest and removes only the file", () => {
    const dir = makeTempDir("korwf-retain-");
    try {
      let now = "2026-01-01T00:00:00.000Z";
      const store = new ArtifactStore(resolveArtifactDir(dir.path), { now: () => now });
      store.write("at-1", "old.txt", "old");
      now = "2026-03-01T00:00:00.000Z";
      store.write("at-1", "new.txt", "new");

      const expired = store.expireOlderThan("at-1", "2026-02-01T00:00:00.000Z");
      expect(expired).toEqual(["old.txt"]);
      expect(existsSync(join(store.dirFor("at-1"), "old.txt"))).toBe(false);
      expect(existsSync(join(store.dirFor("at-1"), "new.txt"))).toBe(true);

      const manifest = store.readManifest("at-1");
      // The entry survives: an evidence row still explains what was captured.
      expect(manifest.entries).toHaveLength(2);
      const old = manifest.entries.find((e) => e.relativePath === "old.txt");
      expect(old?.expiredAt).toBe("2026-03-01T00:00:00.000Z");
      expect(old?.contentHash).toBe(sha256("old"));
      expect(store.verify("at-1", "old.txt")).toBe(false);
    } finally {
      dir.cleanup();
    }
  });
});
