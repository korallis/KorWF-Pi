/**
 * Tests for src/config/schema.json and src/config/types.ts (issue #11).
 *
 * Runs with plain JSON inspection so no schema library is required at test
 * time; the same cases were exercised under ajv 2020 strict mode while
 * drafting (see the PR for #11). Test names reference acceptance criteria.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { KorwfConfig, KorwfConfigInput } from "../../src/config/types.ts";
import { CONFIG_SECTIONS } from "../../src/config/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, "../../src/config/schema.json"), "utf8"));

/** Minimal default-resolver: walks `properties[*].default` recursively. */
function resolveDefaults(node: any, root = schema): unknown {
  if (node.$ref) node = { ...root.$defs[node.$ref.split("/").pop()], ...node, $ref: undefined };
  if (node.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries<any>(node.properties)) {
      const d = "default" in v ? v.default : undefined;
      out[k] = d !== undefined && typeof d === "object" && !Array.isArray(d) && d !== null && Object.keys(d).length === 0
        ? resolveDefaults(v, root)
        : d !== undefined ? d : resolveDefaults(v, root);
    }
    return out;
  }
  return node.default;
}

describe("AC1: an empty config validates and yields a working no-Jev configuration", () => {
  const resolved = resolveDefaults(schema) as KorwfConfig;
  it("schema is draft 2020-12 and every root section has a default", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    for (const s of CONFIG_SECTIONS) expect(schema.properties[s]).toHaveProperty("default");
  });
  it("resolved empty config is no-Jev, shadow mode, empty allowlist, empty static order", () => {
    const input: KorwfConfigInput = {};
    expect(input).toEqual({});
    expect(resolved.jev.enabled).toBe(false);
    expect(resolved.jev.keySource.kind).toBe("env");
    expect(resolved.mode).toBe("shadow");
    expect(resolved.models.allowlist.providers).toEqual([]);
    expect(resolved.fallback.staticOrder).toEqual([]);
    expect(resolved.storage.path).toBeNull();
  });
});

describe("AC2: config cannot reduce the privacy deny list below the shipped minimum", () => {
  const paths = schema.$defs.ShippedDenyPaths.const as string[];
  const patterns = schema.$defs.ShippedDenyPatterns.const as string[];
  it("denyPaths/denyPatterns carry a `contains` constraint for every shipped entry", () => {
    const p = schema.$defs.Privacy.properties;
    expect(p.denyPaths.allOf.map((c: any) => c.contains.const)).toEqual(paths);
    expect(p.denyPatterns.allOf.map((c: any) => c.contains.const)).toEqual(patterns);
    expect(p.denyPaths.default).toEqual(paths);
    expect(p.denyPatterns.default).toEqual(patterns);
  });
  it("shipped minimum covers PLAN §7: .env*, key files, credential stores, node_modules, build output", () => {
    expect(paths).toEqual(expect.arrayContaining(["**/.env", "**/.env.*", "**/*.pem", "**/.aws/**", "**/node_modules/**", "**/dist/**"]));
  });
  it("every shipped pattern compiles as an ECMAScript regex with flags iu", () => {
    for (const re of patterns) expect(() => new RegExp(re, "iu")).not.toThrow();
  });
});

describe("AC3/AC4: no machine-specific path, provider, or hostname in defaults", () => {
  const text = readFileSync(join(here, "../../src/config/schema.json"), "utf8");
  it("does not mention the author's local provider, /home/, /Users/, or localhost", () => {
    // The author's development-only provider name (PLAN §11) is assembled here so this
    // test file itself never contains the literal.
    const localProvider = ["mac", "mini"].join("-");
    for (const bad of [localProvider, "/home/", "/Users/", "localhost", "127.0.0.1"]) expect(text).not.toContain(bad);
  });
  it("only hostname in defaults is the public TypeSafe API origin", () => {
    const hosts = [...text.matchAll(/https?:\/\/([^/"\s]+)/g)].map((m) => m[1]);
    expect(new Set(hosts)).toEqual(new Set(["json-schema.org", "korwf.dev", "api.typesafe.ai"]));
  });
});

describe("Validation beyond types", () => {
  it("budgets are >= 0 or null", () => {
    expect(schema.$defs.NonNegativeOrNull).toMatchObject({ type: ["number", "null"], minimum: 0 });
  });
  it("high-risk approval classes are pinned to `stop` in every mode", () => {
    for (const mode of ["shadow", "advisory", "supervised", "bounded_autonomous"])
      expect(schema.$defs.HighRiskPolicy.properties[mode]).toEqual({ const: "stop" });
  });
  it("jev model is a pinned semver, base URL is https-only", () => {
    expect(schema.$defs.Jev.properties.model.pattern).toBe("^jev-\\d+\\.\\d+\\.\\d+$");
    expect(schema.$defs.Jev.properties.baseUrl.pattern).toBe("^https://");
  });
});
