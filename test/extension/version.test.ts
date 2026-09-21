/**
 * Tests for src/extension/commands/version.ts (issue #19).
 *
 * Exercises acceptance criterion: "/korwf version prints the package
 * version." (End-to-end isolated-session verification is manual; see the
 * PR description for the transcript. This test checks the value the
 * command prints is read from the real package.json, not hardcoded.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPackageVersion, versionMessage } from "../../src/extension/commands/version.ts";

describe("getPackageVersion (AC: /korwf version prints the package version)", () => {
  it("matches the version field in package.json", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = join(here, "..", "..", "package.json");
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
    expect(getPackageVersion()).toBe(manifest.version);
  });
});

describe("versionMessage (AC: /korwf version output is namespaced korwf)", () => {
  it("is prefixed with the korwf-pi package name", () => {
    expect(versionMessage()).toMatch(/^korwf-pi v\d+\.\d+\.\d+/);
  });
});
