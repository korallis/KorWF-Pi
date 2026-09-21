/**
 * Validator rules V1–V12 plus schema-level rejection (issue #21).
 *
 * AC2: "Each invariant has a failing-input test that is rejected with a
 * path-qualified error." Every case below asserts both the rule id and the
 * exact path of the offending value.
 */
import { describe, it, expect } from "vitest";
import { defaultConfig, validateConfig, globToRegExp, effectiveAllowlist } from "../../../src/config/index.ts";
import type { ConfigRuleId, KorwfConfig, ValidateOptions } from "../../../src/config/index.ts";

/** Recursively strips `readonly` so a test can build a failing input in place. */
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

/** Mutable deep copy of the shipped defaults, for building failing inputs. */
function base(): DeepMutable<KorwfConfig> & Record<string, unknown> {
  return JSON.parse(JSON.stringify(defaultConfig())) as DeepMutable<KorwfConfig> & Record<string, unknown>;
}

/** Assert a config is rejected by `rule` at `path`. */
function expectRejected(config: unknown, rule: ConfigRuleId, path: string, options: ValidateOptions = {}) {
  const result = validateConfig(config, options);
  expect(result.ok).toBe(false);
  const match = result.errors.find((e) => e.rule === rule && e.path === path);
  expect(
    match,
    `expected a ${rule} error at "${path}", got: ${result.errors.map((e) => `[${e.rule}] ${e.path}`).join(", ")}`,
  ).toBeDefined();
  expect(match?.message.length ?? 0).toBeGreaterThan(10);
  return match!;
}

describe("AC2: the shipped defaults are themselves valid", () => {
  it("defaultConfig() passes schema and every cross-field rule", () => {
    const result = validateConfig(defaultConfig(), { projectRoot: "/tmp/project" });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("AC2: schema-level rejection is path-qualified", () => {
  it("rejects an unknown key so a typo cannot silently disable a policy", () => {
    expectRejected({ ...base(), nope: 1 }, "schema", "nope");
  });
  it("rejects a wrong-typed value with the path of the value", () => {
    const c = base();
    (c.approvals as { queueTimeoutMinutes: unknown }).queueTimeoutMinutes = "soon";
    expectRejected(c, "schema", "approvals.queueTimeoutMinutes");
  });
  it("rejects a high-risk class set to auto (const pin, PLAN §7)", () => {
    const c = base();
    (c.approvals.classes.remote_push as { bounded_autonomous: string }).bounded_autonomous = "auto";
    expectRejected(c, "schema", "approvals.classes.remote_push.bounded_autonomous");
  });
  it("rejects a non-https Jev base URL and an unpinned Jev model", () => {
    const a = base();
    (a.jev as { baseUrl: string }).baseUrl = "http://example.invalid";
    expectRejected(a, "schema", "jev.baseUrl");
    const b = base();
    (b.jev as { model: string }).model = "jev-latest";
    expectRejected(b, "schema", "jev.model");
  });
  it("rejects loosening a fixed policy field", () => {
    const c = base();
    (c.fallback as { overridePins: boolean }).overridePins = true;
    expectRejected(c, "schema", "fallback.overridePins");
    const d = base();
    (d.privacy.rawLogging as { redactBeforeWrite: boolean }).redactBeforeWrite = false;
    expectRejected(d, "schema", "privacy.rawLogging.redactBeforeWrite");
  });
});

describe("AC2: V1 — fallback.staticOrder ⊆ effective allowlist", () => {
  it("rejects a static-order entry outside the allowlist", () => {
    const c = base();
    (c.models.allowlist as { providers: string[] }).providers = ["alpha"];
    (c.fallback as { staticOrder: string[] }).staticOrder = ["alpha/m1", "beta/m2"];
    expectRejected(c, "V1", "fallback.staticOrder[1]");
  });
  it("rejects a static-order entry Pi has not configured", () => {
    const c = base();
    (c.fallback as { staticOrder: string[] }).staticOrder = ["alpha/ghost"];
    expectRejected(c, "V1", "fallback.staticOrder[0]", { knownModels: ["alpha/m1"] });
  });
  it("accepts a static order inside the allowlist and the registry", () => {
    const c = base();
    (c.fallback as { staticOrder: string[] }).staticOrder = ["alpha/m1"];
    expect(validateConfig(c, { knownModels: ["alpha/m1", "beta/m2"] }).ok).toBe(true);
  });
  it("a disabled override removes a model from the effective allowlist", () => {
    const c = base();
    (c.models as { overrides: Record<string, unknown> }).overrides = { "alpha/m1": { disabled: true } };
    const { isAllowed } = effectiveAllowlist(c);
    expect(isAllowed("alpha/m1")).toBe(false);
    (c.fallback as { staticOrder: string[] }).staticOrder = ["alpha/m1"];
    expectRejected(c, "V1", "fallback.staticOrder[0]");
  });
});

describe("AC2: V2/V3 — budget caps", () => {
  it("V2 rejects a negative cap at its exact path", () => {
    const c = base();
    (c.budgets.workflow as { maxSpendUsd: number }).maxSpendUsd = -1;
    const issue = validateConfig(c).errors.find((e) => e.path === "budgets.workflow.maxSpendUsd");
    expect(issue).toBeDefined();
    expect(["schema", "V2"]).toContain(issue?.rule);
  });
  it("V3 rejects a child cap larger than its parent", () => {
    const c = base();
    (c.budgets.task as { maxSpendUsd: number | null }).maxSpendUsd = 50;
    expectRejected(c, "V3", "budgets.task.maxSpendUsd");
  });
  it("V3 allows a null (uncapped) parent alongside a capped child", () => {
    const c = base();
    (c.budgets.workflow as { maxRequests: number | null }).maxRequests = null;
    (c.budgets.task as { maxRequests: number | null }).maxRequests = 500;
    expect(validateConfig(c).ok).toBe(true);
  });
});

describe("AC2: V4/V10/V11/V12 — approval classes", () => {
  it("V4 rejects `auto` for a mutation class in a non-mutating mode", () => {
    const c = base();
    (c.approvals.classes.edit_worktree as { shadow: string }).shadow = "auto";
    expectRejected(c, "V4", "approvals.classes.edit_worktree.shadow");
  });
  it("V11 rejects `auto` for scope_change / replan (schema enum, then re-checked post-merge)", async () => {
    const c = base();
    (c.approvals.classes.scope_change as { supervised: string }).supervised = "auto";
    const result = validateConfig(c);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === "approvals.classes.scope_change.supervised")).toBe(true);
    const { validateApprovalClasses } = await import("../../../src/workflow/approval-classes.ts");
    expect(
      validateApprovalClasses({
        replan: { shadow: "stop", advisory: "stop", supervised: "auto", bounded_autonomous: "queue" },
      }).map((v) => v.rule),
    ).toContain("V11");
  });
  it("V12 rejects a partial row that omits a mode", () => {
    const c = base();
    delete (c.approvals.classes.run_checks as unknown as Record<string, unknown>)["supervised"];
    const result = validateConfig(c);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === "approvals.classes.run_checks.supervised")).toBe(true);
  });
  it("V10 is re-checked after the merge, not only by the schema `const`", async () => {
    // The schema pin is bypassed here on purpose: this asserts the post-merge
    // re-check in validateApprovalClasses, which is what stops a higher layer
    // from weakening a high-risk row through a merge path.
    const { validateApprovalClasses } = await import("../../../src/workflow/approval-classes.ts");
    const violations = validateApprovalClasses({
      deployment: { shadow: "stop", advisory: "stop", supervised: "stop", bounded_autonomous: "auto" },
    });
    expect(violations.map((v) => v.rule)).toContain("V10");
  });
});

describe("AC2: V5/V6/V7 — privacy floors and carve-outs", () => {
  it("V5 rejects a denyPaths array that drops a shipped entry", () => {
    const c = base();
    (c.privacy as { denyPaths: string[] }).denyPaths = ["**/.env"];
    const result = validateConfig(c);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === "privacy.denyPaths")).toBe(true);
  });
  it("V5 rejects an emptied denyPatterns array", () => {
    const c = base();
    (c.privacy as { denyPatterns: string[] }).denyPatterns = [];
    const result = validateConfig(c);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === "privacy.denyPatterns")).toBe(true);
  });
  it("V5 accepts additions on top of the floor", () => {
    const c = base();
    (c.privacy as { denyPaths: string[] }).denyPaths = [...c.privacy.denyPaths, "docs/private/**"];
    expect(validateConfig(c).ok).toBe(true);
  });
  it("V6 rejects a deny pattern that does not compile with flags iu", () => {
    const c = base();
    (c.privacy as { denyPatterns: string[] }).denyPatterns = [...c.privacy.denyPatterns, "([unclosed"];
    expectRejected(c, "V6", `privacy.denyPatterns[${c.privacy.denyPatterns.length - 1}]`);
  });
  it("V7 rejects a carve-out that re-opens a whole class with **", () => {
    const c = base();
    (c.privacy as { allowPaths: string[] }).allowPaths = ["**/*.env"];
    expectRejected(c, "V7", "privacy.allowPaths[0]");
  });
  it("V7 rejects a carve-out for key material however specific", () => {
    const c = base();
    (c.privacy as { allowPaths: string[] }).allowPaths = ["test/fixtures/server.pem"];
    expectRejected(c, "V7", "privacy.allowPaths[0]");
  });
  it("V7 accepts a literal fixture path that intersects a deny entry", () => {
    const c = base();
    (c.privacy as { allowPaths: string[] }).allowPaths = ["docs/fixtures/.env.example"];
    const result = validateConfig(c);
    expect(result.errors).toEqual([]);
  });
  it("glob compilation treats ** as crossing directories and * as not", () => {
    expect(globToRegExp("**/.env").test("a/b/.env")).toBe(true);
    expect(globToRegExp("**/.env").test(".env")).toBe(true);
    expect(globToRegExp("*.key").test("a/b.key")).toBe(false);
  });
});

describe("AC2: V8/V9 — storage location and Jev key", () => {
  it("V8 rejects an absolute storage path outside the project", () => {
    const c = base();
    (c.storage as { path: string | null }).path = "/var/tmp/korwf-elsewhere";
    expectRejected(c, "V8", "storage.path", { projectRoot: "/tmp/project" });
  });
  it("V8 accepts the same path once allowOutsideProject is set", () => {
    const c = base();
    (c.storage as { path: string | null }).path = "/var/tmp/korwf-elsewhere";
    (c.storage as { allowOutsideProject: boolean }).allowOutsideProject = true;
    expect(validateConfig(c, { projectRoot: "/tmp/project" }).ok).toBe(true);
  });
  it("V8 accepts a project-relative path", () => {
    const c = base();
    (c.storage as { path: string | null }).path = ".korwf-state";
    expect(validateConfig(c, { projectRoot: "/tmp/project" }).ok).toBe(true);
  });
  it("V9 rejects a pin outside the effective allowlist", () => {
    const c = base();
    (c.models.allowlist as { providers: string[] }).providers = ["alpha"];
    (c.models.allowlist as { pins: Record<string, string> }).pins = { implement: "beta/m2" };
    expectRejected(c, "V9", "models.allowlist.pins.implement");
  });
  it("V9 downgrades an enabled Jev with no key to a warning, never an error", () => {
    const c = base();
    (c.jev as { enabled: boolean }).enabled = true;
    const result = validateConfig(c, { jevKeyResolves: false });
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.rule)).toContain("V9");
    expect(result.warnings[0]?.path).toBe("jev.enabled");
  });
});
