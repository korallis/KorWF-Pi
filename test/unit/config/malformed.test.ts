/**
 * Malformed input handling (issue #21 Scope: "validation errors are precise
 * (path + reason) and never crash Pi").
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../helpers/temp-dir.ts";
import { loadConfig, PROJECT_CONFIG_RELATIVE_PATH } from "../../../src/config/index.ts";

function withProject(contents: string | null) {
  const dir = makeTempDir();
  const projectRoot = join(dir.path, "project");
  mkdirSync(join(projectRoot, ".korwf"), { recursive: true });
  if (contents !== null) writeFileSync(join(projectRoot, PROJECT_CONFIG_RELATIVE_PATH), contents);
  return { projectRoot, file: join(projectRoot, PROJECT_CONFIG_RELATIVE_PATH), cleanup: dir.cleanup };
}

function load(projectRoot: string) {
  return loadConfig(projectRoot, { userConfigDir: null, env: {} });
}

describe("malformed input never throws and always names the file", () => {
  for (const [label, body] of [
    ["truncated JSON", '{ "mode": '],
    ["trailing comma", '{ "mode": "shadow", }'],
    ["a JSON array", "[1,2,3]"],
    ["a bare string", '"shadow"'],
    ["null", "null"],
    ["an empty file", ""],
  ] as const) {
    it(`rejects ${label} with a path-qualified error instead of throwing`, () => {
      const f = withProject(body);
      try {
        const result = load(f.projectRoot);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]?.path).toContain(f.file);
        expect(result.message).toContain("configuration is invalid");
      } finally {
        f.cleanup();
      }
    });
  }

  it("a config with several problems reports all of them, each with its own path", () => {
    const f = withProject(
      JSON.stringify({ nope: 1, mode: "turbo", budgets: { workflow: { maxSpendUsd: -5 } } }),
    );
    try {
      const result = load(f.projectRoot);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const paths = result.errors.map((e) => e.path);
      expect(paths).toContain("nope");
      expect(paths).toContain("mode");
      expect(paths).toContain("budgets.workflow.maxSpendUsd");
      for (const e of result.errors) expect(e.message).not.toBe("");
    } finally {
      f.cleanup();
    }
  });

  it("an unreadable file is an error, not an exception", () => {
    const f = withProject("{}");
    try {
      chmodSync(f.file, 0o000);
      const result = load(f.projectRoot);
      // Running as root can still read a 000 file; then the load simply succeeds.
      if (!result.ok) {
        expect(result.errors[0]?.message).toContain("could not be read");
      } else {
        expect(result.config.mode).toBe("shadow");
      }
    } finally {
      chmodSync(f.file, 0o600);
      f.cleanup();
    }
  });

  it("a missing project directory loads the shipped defaults rather than failing", () => {
    const dir = makeTempDir();
    try {
      const result = loadConfig(join(dir.path, "does-not-exist"), { userConfigDir: null, env: {} });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.config.mode).toBe("shadow");
    } finally {
      dir.cleanup();
    }
  });

  it("a `$schema` hint in the file is ignored rather than rejected as an unknown key", () => {
    const f = withProject(JSON.stringify({ $schema: "https://korwf.dev/schema/config/v1.json", mode: "advisory" }));
    try {
      const result = load(f.projectRoot);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.config.mode).toBe("advisory");
    } finally {
      f.cleanup();
    }
  });
});
