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
  pick,
  registerSecretValue,
  truncateToBytes,
} from "../../../src/security/index.ts";
import { SHIPPED_DENY_PATHS } from "../../../src/config/defaults.ts";
import { defaultConfig } from "../../../src/config/index.ts";
import type { KorwfConfig } from "../../../src/config/types.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import type { JevEvaluateResult, SystemOneRequest } from "../../../src/jev/transport.ts";
import { ask, defineNoul } from "../../../src/decisions/index.ts";

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

describe("AC1: denied paths, node_modules and secrets never survive the filter", () => {
  it("drops a .env snippet, a node_modules snippet and redacts a fake key", () => {
    const policy = policyWith();
    const filtered = policy.filter(
      {
        state: { task: "review", note: `use ${FAKE_KEY} for auth` },
        snippets: [
          { path: ".env", text: ENV_FILE },
          { path: "node_modules/left-pad/index.js", text: "module.exports = () => {};" },
          { path: "src/index.ts", text: "export const answer = 42;" },
        ],
      },
      { purpose: "jev.decision" },
    );

    const wire = JSON.stringify(filtered);
    expect(wire).not.toContain("DATABASE_URL");
    expect(wire).not.toContain("hunter2hunter2");
    expect(wire).not.toContain(FAKE_KEY);
    expect(wire).toContain("export const answer = 42;");

    expect(filtered.report.snippetsOffered).toBe(3);
    expect(filtered.report.snippetsKept).toBe(1);
    expect(filtered.report.removed.map((r) => r.what)).toEqual([".env", "node_modules/left-pad/index.js"]);
    expect(filtered.report.removed.every((r) => r.reason === "denied")).toBe(true);
    expect(filtered.report.removed.map((r) => r.glob)).toEqual(["**/.env", "**/node_modules/**"]);
    expect(filtered.report.redactedStrings).toBeGreaterThan(0);
    expect(filtered.report.clean).toBe(false);
  });

  it("redacts a registered literal secret that never had a credential shape", () => {
    registerSecretValue("plain-but-secret-value");
    const policy = policyWith();
    const filtered = policy.filter({ state: { note: "token is plain-but-secret-value" } }, { purpose: "jev.decision" });
    expect(JSON.stringify(filtered.state)).not.toContain("plain-but-secret-value");
    expect(JSON.stringify(filtered.state)).toContain(REDACTED);
  });

  it("applies the deny list to a path carried in a state field, not just to snippets", () => {
    const policy = policyWith();
    const filtered = policy.filter(
      { state: { file: "apps/api/.env.production", other: "src/app.ts" } },
      { purpose: "jev.decision" },
    );
    expect(JSON.stringify(filtered.state)).not.toContain(".env.production");
    expect(filtered.report.removed.some((r) => r.kind === "field" && r.reason === "denied")).toBe(true);
  });

  it("refuses bare denied paths and absolute paths", () => {
    const policy = policyWith();
    const filtered = policy.filter(
      { paths: ["src/a.ts", ".ssh/id_ed25519", "/home/someone/project/src/b.ts"] },
      { purpose: "jev.decision" },
    );
    expect(filtered.paths).toEqual(["src/a.ts"]);
    expect(filtered.report.removed.map((r) => r.rule)).toEqual(["shipped", "absolute"]);
  });

  it("drops paths entirely when privacy.outbound.sendFilePaths is false", () => {
    const policy = policyWith((base) => ({
      ...base,
      privacy: { ...base.privacy, outbound: { ...base.privacy.outbound, sendFilePaths: false } },
    }));
    const filtered = policy.filter(
      { paths: ["src/a.ts"], snippets: [{ path: "src/a.ts", text: "ok" }] },
      { purpose: "jev.decision" },
    );
    expect(filtered.paths).toEqual([]);
    expect(filtered.snippets[0]?.path).toBe("");
    expect(filtered.snippets[0]?.text).toBe("ok");
  });

  it("never throws on hostile input (cycles, getters that throw, BigInt)", () => {
    const policy = policyWith();
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic["self"] = cyclic;
    const hostile = {
      cyclic,
      big: BigInt(7),
      fn: () => "nope",
      get boom(): string {
        throw new Error("getter exploded");
      },
    };
    expect(() => policy.filter({ state: hostile }, { purpose: "jev.decision" })).not.toThrow();
  });
});

describe("minimal-state construction (PLAN §6)", () => {
  it("pick() sends only the named fields, never the rest of the input", () => {
    const input = { id: "t-1", title: "Add cache", diff: "@@ huge", secret: FAKE_KEY, env: ENV_FILE };
    const state = pick(input, ["id", "title"]);
    expect(state).toEqual({ id: "t-1", title: "Add cache" });
    expect(JSON.stringify(state)).not.toContain(FAKE_KEY);
    expect(Object.keys(state)).toEqual(["id", "title"]);
  });

  it("pick() omits undefined fields so the state hashes stably", () => {
    type Input = { id: string; note?: string | undefined };
    const a = pick<Input, keyof Input>({ id: "t-1", note: undefined }, ["id", "note"]);
    const b = pick<Input, keyof Input>({ id: "t-1" }, ["id", "note"]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("AC2: truncation keeps a marker and reports dropped bytes", () => {
  it("truncateToBytes keeps a marker, stays within the cap and counts dropped bytes", () => {
    const text = "x".repeat(1000);
    const { kept, droppedBytes } = truncateToBytes(text, 100);
    expect(kept.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(byteLength(kept)).toBeLessThanOrEqual(100);
    expect(droppedBytes).toBe(1000 - (100 - TRUNCATION_MARKER.length));
    expect(byteLength(kept) - TRUNCATION_MARKER.length + droppedBytes).toBe(1000);
  });

  it("never splits a multi-byte character", () => {
    const text = "€".repeat(50); // 3 bytes each
    const { kept } = truncateToBytes(text, TRUNCATION_MARKER.length + 7);
    expect(kept).not.toContain("\uFFFD");
    expect(kept).toBe(`€€${TRUNCATION_MARKER}`);
  });

  it("caps a snippet at privacy.outbound.maxSnippetBytes and reports the drop", () => {
    const policy = policyWith((base) => ({
      ...base,
      privacy: { ...base.privacy, outbound: { ...base.privacy.outbound, maxSnippetBytes: 64 } },
    }));
    const filtered = policy.filter(
      { snippets: [{ path: "src/big.ts", text: "a".repeat(5000) }] },
      { purpose: "jev.decision" },
    );
    const snippet = filtered.snippets[0];
    expect(snippet).toBeDefined();
    expect(snippet?.text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(byteLength(snippet?.text ?? "")).toBeLessThanOrEqual(64);
    const truncation = filtered.report.truncated[0];
    expect(truncation?.kind).toBe("snippet");
    expect(truncation?.what).toBe("src/big.ts");
    expect(truncation?.droppedBytes).toBe(5000 - (64 - TRUNCATION_MARKER.length));
    expect(filtered.report.droppedBytes).toBe(truncation?.droppedBytes);
  });

  it("enforces maxSnippetsPerRequest, reporting the excess as over_budget", () => {
    const policy = policyWith((base) => ({
      ...base,
      privacy: { ...base.privacy, outbound: { ...base.privacy.outbound, maxSnippetsPerRequest: 2 } },
    }));
    const filtered = policy.filter(
      {
        snippets: [
          { path: "src/a.ts", text: "a" },
          { path: "src/b.ts", text: "bb" },
          { path: "src/c.ts", text: "ccc" },
        ],
      },
      { purpose: "jev.decision" },
    );
    expect(filtered.report.snippetsKept).toBe(2);
    expect(filtered.report.removed).toEqual([
      { kind: "snippet", what: "src/c.ts", reason: "over_budget", glob: null, rule: null, bytes: 3 },
    ]);
    expect(filtered.report.droppedBytes).toBe(3);
  });

  it("enforces maxRequestBytes by dropping whole snippets from the end", () => {
    const policy = policyWith((base) => ({
      ...base,
      privacy: { ...base.privacy, outbound: { ...base.privacy.outbound, maxRequestBytes: 220 } },
    }));
    const filtered = policy.filter(
      {
        state: { q: "which file?" },
        snippets: [
          { path: "src/a.ts", text: "a".repeat(60) },
          { path: "src/b.ts", text: "b".repeat(60) },
          { path: "src/c.ts", text: "c".repeat(60) },
        ],
      },
      { purpose: "jev.decision" },
    );
    expect(filtered.report.sentBytes).toBeLessThanOrEqual(220);
    expect(filtered.report.snippetsKept).toBeLessThan(3);
    expect(filtered.report.removed.some((r) => r.reason === "over_budget")).toBe(true);
    expect(filtered.report.droppedBytes).toBeGreaterThan(0);
  });

  it("honours a per-purpose request cap override", () => {
    const policy = new OutboundPolicy(defaultConfig(), { maxRequestBytesByPurpose: { "jev.ping": 32 } });
    expect(policy.maxRequestBytes("jev.ping")).toBe(32);
    expect(policy.maxRequestBytes("jev.decision")).toBe(defaultConfig().privacy.outbound.maxRequestBytes);
  });

  it("reports clean: true when nothing was removed, truncated or redacted", () => {
    const policy = policyWith();
    const filtered = policy.filter(
      { state: { q: "ok?" }, snippets: [{ path: "src/a.ts", text: "const a = 1;" }] },
      { purpose: "jev.decision" },
    );
    expect(filtered.report.clean).toBe(true);
    expect(filtered.report.droppedBytes).toBe(0);
    expect(filtered.report.sentBytes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC3: the filter cannot be bypassed
// ---------------------------------------------------------------------------

/** A question whose state deliberately carries hostile content. */
const leakyQuestion = defineNoul({
  id: "outbound.leak_check",
  version: "1",
  prompt: "Does the snippet compile?",
  state: (input: { readonly file: string; readonly text: string; readonly note: string }) => ({
    file: input.file,
    text: input.text,
    note: input.note,
  }),
  decide: (noul) => ({ value: noul >= 0.5, rule: "threshold", action: noul >= 0.5 ? "yes" : "no" }),
  fallback: () => ({ value: false, action: "no" }),
  boundaries: [
    { name: "fallback is deterministic", state: { file: "src/a.ts", text: "", note: "" }, expectFallback: false },
  ],
});

function okResponder(): (request: SystemOneRequest) => JevEvaluateResult {
  return (request) => ({
    kind: "ok",
    response: {
      model: "jev-test",
      answers: Object.fromEntries(Object.keys(request.questions).map((k) => [k, { type: "noul", noul: 0.9 }])),
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    requestId: "req-test",
    attempts: 1,
    elapsedMs: 1,
  });
}

describe("AC3: the transport only accepts a FilteredPayload", () => {
  it("nothing denied or secret-shaped reaches the mock transport through ask()", async () => {
    const transport = new MockJevTransport({ responder: okResponder() });
    const result = await ask(
      { transport, model: "jev-test", outbound: defaultOutboundPolicy() },
      leakyQuestion,
      { file: "apps/web/.env", text: ENV_FILE, note: `key is ${FAKE_KEY}` },
    );

    expect(result.value).toBe(true);
    expect(transport.calls).toHaveLength(1);
    const sent = JSON.stringify(transport.calls[0]?.request);
    expect(sent).not.toContain(FAKE_KEY);
    expect(sent).not.toContain("hunter2hunter2");
    expect(sent).not.toContain("apps/web/.env");
    expect(sent).not.toContain("DATABASE_URL=");
  });

  it("ask() filters even when the caller passes no policy (shipped defaults apply)", async () => {
    const transport = new MockJevTransport({ responder: okResponder() });
    await ask({ transport, model: "jev-test" }, leakyQuestion, {
      file: "node_modules/x/index.js",
      text: `const k = "${FAKE_KEY}";`,
      note: "fine",
    });
    const sent = JSON.stringify(transport.calls[0]?.request);
    expect(sent).not.toContain(FAKE_KEY);
    expect(sent).not.toContain("node_modules/x/index.js");
  });

  it("a filtered request carries a retrievable report and keeps the wire shape", () => {
    const policy = defaultOutboundPolicy();
    const filtered = policy.filterRequest({
      state: { note: `token ${FAKE_KEY}`, file: ".env" },
      model: "jev-test",
      questions: { q: { type: "noul", instructions: "Is it fine?" } },
    });
    expect(Object.keys(filtered).sort()).toEqual(["model", "questions", "state"]);
    expect(filtered.questions["q"]).toEqual({ type: "noul", instructions: "Is it fine?" });
    const report = outboundReportOf(filtered);
    expect(report?.purpose).toBe("jev.decision");
    expect(report?.clean).toBe(false);
    expect(JSON.stringify(filtered)).not.toContain(FAKE_KEY);
  });

  it("an unfiltered SystemOneRequest is not assignable to evaluate() (compile-time proof)", async () => {
    const transport = new MockJevTransport({ responder: okResponder() });
    const raw: SystemOneRequest = { state: "x", model: "jev-test", questions: {} };
    // @ts-expect-error evaluate() takes a FilteredRequest; the brand can only
    // be minted by OutboundPolicy.filterRequest, so skipping the filter is a
    // type error rather than a leak.
    await transport.evaluate(raw);
    // The call still ran (the brand is erased at runtime); the point is that
    // the line above does not typecheck, which `npm run typecheck` enforces.
    expect(transport.calls).toHaveLength(1);
  });
});
