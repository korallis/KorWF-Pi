/**
 * Unit test for the temp-dir fixture (issue #20 AC1: real unit test).
 */
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { makeTempDir, withTempDir } from "./temp-dir.ts";

describe("makeTempDir", () => {
  it("creates a directory under the OS temp dir that exists", () => {
    const { path, cleanup } = makeTempDir();
    try {
      expect(existsSync(path)).toBe(true);
      expect(path.startsWith(tmpdir())).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("cleanup() removes the directory and is safe to call twice", () => {
    const { path, cleanup } = makeTempDir();
    cleanup();
    expect(existsSync(path)).toBe(false);
    expect(() => cleanup()).not.toThrow();
  });
});

describe("withTempDir", () => {
  it("provides a writable directory and cleans it up after the callback", async () => {
    let capturedPath = "";
    await withTempDir((dir) => {
      capturedPath = dir;
      writeFileSync(`${dir}/marker.txt`, "hello");
      expect(existsSync(`${dir}/marker.txt`)).toBe(true);
    });
    expect(existsSync(capturedPath)).toBe(false);
  });

  it("still cleans up when the callback throws", async () => {
    let capturedPath = "";
    await expect(
      withTempDir((dir) => {
        capturedPath = dir;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(capturedPath)).toBe(false);
  });
});
