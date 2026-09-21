/**
 * Minimal-state construction, outbound size limits, default-deny path and
 * data filtering (issue #28; PLAN §7 "Data policy", §6 "minimal relevant
 * state per evaluation").
 *
 * Acceptance criteria exercised here:
 *  AC1 "A payload containing `.env` content, a `node_modules` file, and a
 *       fake key is filtered so none reach the mock transport."
 *  AC2 "Truncation keeps a marker and the report says how many bytes were
 *       dropped."
 *  AC3 "Filter cannot be bypassed: the transport interface only accepts
 *       `FilteredPayload` (branded type)."
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  DenyMatcher,
  OutboundPolicy,
  REDACTED,
  SHIPPED_DENY_PATH_NOTES,
  TRUNCATION_MARKER,
  assertDenyListDocumented,
  byteLength,
  clearRegisteredSecrets,
  defaultOutboundPolicy,
  globToRegExp,
  normalisePath,
  outboundReportOf,
  registerSecretValue,
  truncateToBytes,
} from "../../../src/security/index.ts";
import { SHIPPED_DENY_PATHS } from "../../../src/config/defaults.ts";
import { defaultConfig } from "../../../src/config/index.ts";
import type { KorwfConfig } from "../../../src/config/types.ts";

/** A credential-shaped string that is not a real credential. */
const FAKE_KEY = "apikey_ZZZZfakefakefake1234567890abcdef"; // check-secrets:allow

/** `.env` content as it would be read off disk. */
const ENV_FILE = `PORT=3000\nDATABASE_URL=postgres://user:hunter2hunter2@db.internal/app\n`;

function policyWith(mutate: (base: KorwfConfig) => KorwfConfig = (c) => c): OutboundPolicy {
  return new OutboundPolicy(mutate(defaultConfig()));
}

beforeEach(() => {
  clearRegisteredSecrets();
});

describe("shipped deny list", () => {
  it("documents every shipped entry and matches the schema minimum", () => {
    expect(() => assertDenyListDocumented()).not.toThrow();
    expect(Object.keys(SHIPPED_DENY_PATH_NOTES).sort()).toEqual([...SHIPPED_DENY_PATHS].sort());
    for (const note of Object.values(SHIPPED_DENY_PATH_NOTES)) expect(note.length).toBeGreaterThan(20);
  });

  it("rejects a deny list that grew an undocumented entry", () => {
    expect(() => assertDenyListDocumented([...SHIPPED_DENY_PATHS, "**/*.newsecret"])).toThrow(/undocumented/);
  });

  it("rejects a deny list that dropped a documented entry (floor weakened)", () => {
    const weakened = SHIPPED_DENY_PATHS.filter((g) => g !== "**/.env");
    expect(() => assertDenyListDocumented(weakened)).toThrow(/documented but not shipped/);
  });
});

describe("glob matching and path normalisation", () => {
  it("normalises separators, ./ segments and duplicate slashes", () => {
    expect(normalisePath("src\\a//b/./c/")).toBe("src/a/b/c");
    expect(normalisePath("./src/a")).toBe("src/a");
    expect(normalisePath("C:\\Users\\x")).toBe("c:/Users/x");
  });

  it("compiles the glob subset the deny list uses", () => {
    expect(globToRegExp("**/.env").test("a/b/.env")).toBe(true);
    expect(globToRegExp("**/.env").test(".env")).toBe(true);
    expect(globToRegExp("**/*.pem").test("certs/server.pem")).toBe(true);
    expect(globToRegExp("**/*.pem").test("certs/server.pem.txt")).toBe(false);
    expect(globToRegExp("**/node_modules/**").test("node_modules/a/index.js")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("src/{a,b}.ts").test("src/b.ts")).toBe(true);
  });

  it("never throws on malformed glob syntax (fails closed, not open)", () => {
    expect(() => globToRegExp("src/[unclosed")).not.toThrow();
    expect(() => globToRegExp("src/{unclosed")).not.toThrow();
  });

  it("AC1: denies shipped-minimum paths, absolute paths and traversal", () => {
    const matcher = new DenyMatcher();
    expect(matcher.denies(".env")).toBe(true);
    expect(matcher.denies("apps/web/.env.production")).toBe(true);
    expect(matcher.denies("node_modules/lodash/index.js")).toBe(true);
    expect(matcher.denies("deploy/id_rsa")).toBe(true);
    expect(matcher.denies("/etc/passwd")).toBe(true);
    expect(matcher.denies("../../outside/file.ts")).toBe(true);
    expect(matcher.denies("src/index.ts")).toBe(false);
  });

  it("allowPaths cannot re-open a shipped deny entry", () => {
    const matcher = new DenyMatcher({ denyPaths: SHIPPED_DENY_PATHS, allowPaths: ["**/.env", "docs/**"] });
    const verdict = matcher.verdict("apps/web/.env");
    expect(verdict.denied).toBe(true);
    expect(verdict.rule).toBe("shipped");
  });

  it("allowPaths does carve out a user-added deny entry", () => {
    const matcher = new DenyMatcher({
      denyPaths: [...SHIPPED_DENY_PATHS, "docs/**"],
      allowPaths: ["docs/public/**"],
    });
    expect(matcher.denies("docs/internal/notes.md")).toBe(true);
    expect(matcher.denies("docs/public/readme.md")).toBe(false);
  });
});
