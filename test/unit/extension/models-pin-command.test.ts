/**
 * `/korwf models pin` / `unpin` (issue #61; PLAN §3.D "Pinned model").
 *
 * AC: "Pinned model used regardless of mock Jev ranking" (persistence side:
 * the pin lands in project config where `resolvePin` reads it).
 * AC: "Pinned model outside allowlist → error explaining why, not silent use."
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { parsePinArgs, parseUnpinArgs, pinModel, unpinModel } from "../../../src/extension/commands/models-pin.ts";
import { PROJECT_CONFIG_RELATIVE_PATH } from "../../../src/config/defaults.ts";

let dir: TempDir | undefined;
afterEach(() => {
  dir?.cleanup();
  dir = undefined;
});

function configPath(root: string): string {
  return join(root, PROJECT_CONFIG_RELATIVE_PATH);
}

describe("parsePinArgs / parseUnpinArgs", () => {
  it("parses model and defaults task kind to 'default'", () => {
    const parsed = parsePinArgs(["acme/model-1"]);
    expect(parsed).toEqual({ ok: true, model: "acme/model-1", taskKind: "default" });
  });

  it("parses --task", () => {
    const parsed = parsePinArgs(["acme/model-1", "--task", "implement"]);
    expect(parsed).toEqual({ ok: true, model: "acme/model-1", taskKind: "implement" });
  });

  it("rejects a missing model", () => {
    const parsed = parsePinArgs([]);
    expect(parsed.ok).toBe(false);
  });

  it("rejects an unknown --task value", () => {
    const parsed = parsePinArgs(["acme/model-1", "--task", "bogus"]);
    expect(parsed.ok).toBe(false);
  });

  it("parseUnpinArgs defaults to 'default'", () => {
    expect(parseUnpinArgs([])).toEqual({ taskKind: "default" });
  });
});

describe("AC: pinned model used regardless of mock Jev ranking (persisted for resolvePin to read)", () => {
  it("writes models.allowlist.pins.<kind> into the project config", () => {
    dir = makeTempDir();
    const result = pinModel(dir.path, "acme/model-1", "implement");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Pinned acme/model-1");
    const written = JSON.parse(readFileSync(configPath(dir.path), "utf8")) as {
      models?: { allowlist?: { pins?: Record<string, string> } };
    };
    expect(written.models?.allowlist?.pins?.implement).toBe("acme/model-1");
  });

  it("preserves an existing project config's other keys", () => {
    dir = makeTempDir();
    mkdirSync(join(dir.path, ".korwf"), { recursive: true });
    writeFileSync(configPath(dir.path), JSON.stringify({ mode: "supervised" }));
    pinModel(dir.path, "acme/model-1", "default");
    const written = JSON.parse(readFileSync(configPath(dir.path), "utf8")) as { mode?: string };
    expect(written.mode).toBe("supervised");
  });
});

describe("AC: pinned model outside allowlist → error explaining why, not silent use", () => {
  it("refuses to write a pin the config's own allowlist would reject", () => {
    dir = makeTempDir();
    mkdirSync(join(dir.path, ".korwf"), { recursive: true });
    writeFileSync(
      configPath(dir.path),
      JSON.stringify({ models: { allowlist: { providers: [], models: ["acme/other"] } } }),
    );
    const result = pinModel(dir.path, "acme/model-1", "default");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Cannot pin acme/model-1");
    // Nothing was written: the file still has no pins.
    const written = JSON.parse(readFileSync(configPath(dir.path), "utf8")) as {
      models?: { allowlist?: { pins?: Record<string, string> } };
    };
    expect(written.models?.allowlist?.pins).toBeUndefined();
  });
});

describe("unpinModel", () => {
  it("removes the pin for a task kind and leaves others intact", () => {
    dir = makeTempDir();
    pinModel(dir.path, "acme/model-1", "implement");
    pinModel(dir.path, "acme/model-2", "test");
    const result = unpinModel(dir.path, "implement");
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(configPath(dir.path), "utf8")) as {
      models?: { allowlist?: { pins?: Record<string, string> } };
    };
    expect(written.models?.allowlist?.pins?.implement).toBeUndefined();
    expect(written.models?.allowlist?.pins?.test).toBe("acme/model-2");
  });

  it("unpinning a task kind with no pin is a no-op, reported as such", () => {
    dir = makeTempDir();
    const result = unpinModel(dir.path, "default");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("No pin set");
    expect(existsSync(configPath(dir.path))).toBe(false);
  });
});
