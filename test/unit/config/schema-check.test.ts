/**
 * The dependency-free schema checker (issue #21).
 *
 * The important property is the *negative* one: a schema keyword the checker
 * does not implement must fail loudly, so a future schema edit cannot silently
 * become unenforced policy.
 */
import { describe, it, expect } from "vitest";
import { checkAgainstSchema, CONFIG_SCHEMA, materialiseDefaults } from "../../../src/config/index.ts";
import { assertSupportedKeywords } from "../../../src/config/schema-check.ts";
import type { SchemaNode } from "../../../src/config/index.ts";

describe("the checker enforces every keyword the shipped schema uses", () => {
  it("accepts the shipped schema's keyword set", () => {
    expect(() => assertSupportedKeywords(CONFIG_SCHEMA)).not.toThrow();
  });

  it("refuses a schema that uses a keyword it cannot enforce", () => {
    const root = { type: "object", properties: { a: { oneOf: [{ type: "string" }] } } } as unknown as SchemaNode;
    expect(() => assertSupportedKeywords(root)).toThrow(/unsupported keyword "oneOf"/);
  });

  it("validates the shipped defaults against the shipped schema with no issues", () => {
    expect(checkAgainstSchema(materialiseDefaults(CONFIG_SCHEMA))).toEqual([]);
    expect(checkAgainstSchema({})).toEqual([]);
  });
});

describe("issue paths are precise enough to fix the file by hand", () => {
  it("indexes array elements", () => {
    const issues = checkAgainstSchema({ models: { allowlist: { providers: ["ok", 7] } } });
    expect(issues[0]?.path).toBe("models.allowlist.providers[1]");
  });

  it("names a duplicate in a uniqueItems array", () => {
    const issues = checkAgainstSchema({ models: { allowlist: { providers: ["a", "a"] } } });
    expect(issues[0]?.path).toBe("models.allowlist.providers[1]");
    expect(issues[0]?.message).toContain("unique");
  });

  it("quotes a non-identifier key rather than producing an ambiguous dotted path", () => {
    const issues = checkAgainstSchema({ models: { overrides: { "prov/model-1": { nope: true } } } });
    expect(issues[0]?.path).toBe('models.overrides["prov/model-1"].nope');
  });

  it("explains a floor violation in terms of policy, not JSON Schema jargon", () => {
    const issues = checkAgainstSchema({ privacy: { denyPaths: ["docs/private/**"] } });
    expect(issues[0]?.message).toContain("cannot be reduced");
  });
});
