/**
 * Global redaction (issue #22).
 *
 * AC1: "Test writes a known fake key through every log/error/export path and
 *       asserts it is absent from all outputs."
 */
import { describe, it, expect, beforeEach } from "vitest";
import { inspect } from "node:util";
import {
  REDACTED,
  redactString,
  redactValue,
  redactedStringify,
  redactError,
  formatError,
  redactingSink,
  memorySink,
  createLogger,
  containsSecret,
  assertRedacted,
  registerSecretValue,
  clearRegisteredSecrets,
  redactedValues,
  resolveJevKey,
  DEFAULT_KEY_ENV_VAR,
} from "../../../src/security/index.ts";
import { defaultConfig } from "../../../src/config/index.ts";
import type { KorwfConfig } from "../../../src/config/types.ts";

/** A fake key with a credential shape. Not a real credential. */
const FAKE_KEY = "apikey_YYYYfakefakefake9876543210zyxwvu"; // check-secrets:allow

function jevOnConfig(): KorwfConfig {
  const base = defaultConfig();
  return { ...base, jev: { ...base.jev, enabled: true } } as KorwfConfig;
}

beforeEach(() => {
  clearRegisteredSecrets();
});

describe("AC1: a resolved key never reaches any log, error or export path", () => {
  /** Resolve the fake key exactly as production does, registering it globally. */
  function resolveFake() {
    return resolveJevKey(jevOnConfig(), { env: { [DEFAULT_KEY_ENV_VAR]: FAKE_KEY } });
  }

  it("is absent from logger output at every level, message and fields", () => {
    resolveFake();
    const sink = memorySink();
    const log = createLogger(sink);
    log.debug(`sending with key ${FAKE_KEY}`);
    log.info("request", { Authorization: `Bearer ${FAKE_KEY}`, key: FAKE_KEY });
    log.warn("retrying", { nested: { deep: [{ apiKey: FAKE_KEY }] } });
    log.error(`failed: ${FAKE_KEY}`);
    const dumped = JSON.stringify(sink.records);
    expect(dumped).not.toContain(FAKE_KEY);
    expect(dumped).toContain(REDACTED);
    expect(sink.records).toHaveLength(4);
  });

  it("is absent from a thrown error's message, stack and own properties", () => {
    resolveFake();
    const error = Object.assign(new Error(`POST /v1/systemone failed with Authorization: Bearer ${FAKE_KEY}`), {
      requestHeaders: { Authorization: `Bearer ${FAKE_KEY}` },
      apiKey: FAKE_KEY,
      note: `key was ${FAKE_KEY}`,
    });
    redactError(error);
    expect(error.message).not.toContain(FAKE_KEY);
    expect(String(error.stack)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(error.requestHeaders)).not.toContain(FAKE_KEY);
    expect(error.apiKey).toBe(REDACTED);
    expect(error.note).not.toContain(FAKE_KEY);
    // The error keeps its identity so callers can still branch on it.
    expect(error).toBeInstanceOf(Error);
  });

  it("is absent from a chained error cause", () => {
    resolveFake();
    const inner = new Error(`upstream rejected ${FAKE_KEY}`);
    const outer = new Error("jev.unavailable", { cause: inner });
    redactError(outer);
    expect(String((outer.cause as Error).message)).not.toContain(FAKE_KEY);
    expect(formatError(outer)).not.toContain(FAKE_KEY);
  });

  it("is absent from logger.exception for errors and for non-Error throws", () => {
    resolveFake();
    const sink = memorySink();
    const log = createLogger(sink);
    log.exception(new Error(`boom ${FAKE_KEY}`));
    log.exception(`string throw ${FAKE_KEY}`);
    log.exception({ code: "E", detail: FAKE_KEY });
    expect(JSON.stringify(sink.records)).not.toContain(FAKE_KEY);
  });

  it("is absent from JSON.stringify of any record via redactedStringify (export path)", () => {
    resolveFake();
    const record = {
      trace: { request: { headers: { authorization: `Bearer ${FAKE_KEY}` } }, env: { TYPESAFE_API_KEY: FAKE_KEY } }, // check-secrets:allow
      artifacts: [`--key ${FAKE_KEY}`],
    };
    const exported = redactedStringify(record, 2);
    expect(exported).not.toContain(FAKE_KEY);
    expect(exported).toContain(REDACTED);
  });

  it("is absent from a simulated crash dump (inspect of a deep, cyclic object)", () => {
    resolveFake();
    const state: Record<string, unknown> = { key: FAKE_KEY, headers: new Map([["authorization", `Bearer ${FAKE_KEY}`]]) };
    state["self"] = state;
    const dump = inspect(redactValue(state, 12), { depth: null });
    expect(dump).not.toContain(FAKE_KEY);
  });

  it("is absent from percent-encoded, JSON-escaped and base64 forms", () => {
    resolveFake();
    const encoded = [
      encodeURIComponent(FAKE_KEY),
      JSON.stringify(FAKE_KEY).slice(1, -1),
      Buffer.from(FAKE_KEY, "utf8").toString("base64"),
    ];
    for (const form of encoded) {
      expect(redactString(`payload=${form}`)).not.toContain(form);
    }
  });

  it("assertRedacted refuses to let credential-shaped text be emitted", () => {
    expect(() => assertRedacted(`Bearer ${FAKE_KEY}`, "an export")).toThrow(/refused to emit an export/);
    expect(() => assertRedacted(redactString(`Bearer ${FAKE_KEY}`), "an export")).not.toThrow();
  });
});

describe("AC1: credential shapes are redacted even when this process never resolved them", () => {
  /**
   * Every pattern `scripts/check-secrets.sh` scans for, plus the shipped
   * `privacy.denyPatterns` minimum. The redactor must be at least as strict as
   * the repository's own scanner, so nothing it would reject can be logged.
   */
  const shapes: readonly [string, string][] = [
    ["typesafe apikey_", "apikey_AAAAfakefakefake0011223344556677"], // check-secrets:allow
    ["sk- prefixed", "sk-FAKEfake0123456789abcdefFAKE"], // check-secrets:allow
    ["github token", "ghp_FAKEfake0123456789abcdefFAKE01"], // check-secrets:allow
    ["aws access key id", "AKIAFAKEFAKEFAKE1234"],
    ["slack token", "xoxb-1234567890-FAKEfakefake"],
    ["google api key", "AIzaFAKEfake0123456789abcdefghijklmnopq"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKEfakeSignature00"],
    ["pem header", "-----BEGIN RSA PRIVATE KEY-----"],
    ["bearer token", "Bearer FAKEfake0123456789abcdefFAKE"],
    ["authorization header", "authorization: Basic ZmFrZTpmYWtlcGFzc3dvcmQ="],
    ["x-api-key header", "x-api-key: FAKEfake0123456789abcdef"],
    ["credential assignment", "client_secret = FAKEfake0123456789abcdef"],
    ["env-file assignment", "TYPESAFE_API_KEY=FAKEfake0123456789abcdef"], // check-secrets:allow
    ["url userinfo", "https://user:FAKEfakepassword@example.invalid/path"],
  ];

  for (const [name, sample] of shapes) {
    it(`redacts a ${name} that was never registered`, () => {
      expect(redactedValues()).toBe(0);
      const line = `log line containing ${sample} and nothing else`;
      const out = redactString(line);
      expect(out).not.toContain(sample);
      expect(out).toContain(REDACTED);
      expect(containsSecret(line)).toBe(true);
    });
  }

  it("leaves ordinary prose untouched", () => {
    const prose = "Resolved the model route for task t-12 in 42ms; 3 checks passed at /src/config/load.ts:118.";
    expect(redactString(prose)).toBe(prose);
    expect(containsSecret(prose)).toBe(false);
  });

  it("is idempotent: redacting output again changes nothing", () => {
    for (const [, sample] of shapes) {
      const once = redactString(`value: ${sample}`);
      expect(redactString(once)).toBe(once);
    }
  });
});

describe("the redactor is total: it never throws and never becomes the failure", () => {
  it("handles cycles, depth, getters that throw, and exotic primitives", () => {
    const cyclic: Record<string, unknown> = { name: "a" };
    cyclic["self"] = cyclic;
    const hostile = {
      get boom(): string {
        throw new Error("getter exploded");
      },
      big: 10n,
      sym: Symbol("s"),
      fn: function named() {},
      when: new Date(0),
      re: /abc/g,
      set: new Set([1, 2]),
      cyclic,
    };
    expect(() => redactValue(hostile)).not.toThrow();
    const out = redactValue(hostile) as Record<string, unknown>;
    expect(out["boom"]).toBe("[unreadable]");
    expect(out["when"]).toBe(new Date(0).toISOString());
  });

  it("bounds depth rather than recursing forever", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 50; i++) deep = { next: deep };
    expect(JSON.stringify(redactValue(deep, 5))).toContain("[truncated]");
  });

  it("redactedStringify falls back to [redacted] rather than throwing on BigInt", () => {
    expect(redactedStringify({ n: 1n })).toContain("1n");
  });

  it("registerSecretValue ignores values too short to redact safely", () => {
    registerSecretValue("abc");
    expect(redactedValues()).toBe(0);
    registerSecretValue("a-long-enough-secret-value");
    expect(redactedValues()).toBeGreaterThan(0);
    expect(redactString("abc is fine")).toBe("abc is fine");
  });

  it("redactingSink is composable: wrapping twice is harmless", () => {
    registerSecretValue(FAKE_KEY);
    const sink = memorySink();
    const doubled = redactingSink(redactingSink(sink));
    doubled.write("info", `key ${FAKE_KEY}`, { k: FAKE_KEY });
    expect(JSON.stringify(sink.records)).not.toContain(FAKE_KEY);
  });

  it("child loggers keep redacting their inherited fields", () => {
    registerSecretValue(FAKE_KEY);
    const sink = memorySink();
    createLogger(sink).child({ key: FAKE_KEY, task: "t-1" }).info("hello");
    const dumped = JSON.stringify(sink.records);
    expect(dumped).not.toContain(FAKE_KEY);
    expect(dumped).toContain("t-1");
  });
});
