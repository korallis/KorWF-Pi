/**
 * Credential resolution (issue #22).
 *
 * AC2: "Missing key yields a disabled-Jev config, not an exception."
 * AC3: "`Secret` cannot be serialised by accident (JSON.stringify, template
 *       literal, console.log)."
 */
import { describe, it, expect, beforeEach } from "vitest";
import { inspect } from "node:util";
import {
  Secret,
  resolveJevKey,
  applyKeyResolution,
  keyDiagnostics,
  authorizationHeader,
  DEFAULT_KEY_ENV_VAR,
  FALLBACK_KEY_ENV_VARS,
  clearRegisteredSecrets,
  REDACTED,
} from "../../../src/security/index.ts";
import { defaultConfig } from "../../../src/config/index.ts";
import type { KorwfConfig } from "../../../src/config/types.ts";
import type { SecretsPort } from "../../../src/security/index.ts";

/**
 * A fake key that is obviously not real but has a credential shape, so the
 * redaction assertions are meaningful. Not a real credential.
 */
const FAKE_KEY = "apikey_ZZZZfakefakefake0123456789abcdef"; // check-secrets:allow

/** Config with Jev on and a named env source, built from the shipped defaults. */
function jevConfig(overrides: Partial<KorwfConfig["jev"]> = {}): KorwfConfig {
  const base = defaultConfig();
  return { ...base, jev: { ...base.jev, enabled: true, ...overrides } } as KorwfConfig;
}

beforeEach(() => {
  clearRegisteredSecrets();
});

describe("AC3: a Secret cannot be serialised by accident", () => {
  const secret = () => new Secret(FAKE_KEY, "TypeSafe API key", { kind: "env", name: DEFAULT_KEY_ENV_VAR, viaFallbackName: false });

  it("JSON.stringify of the secret yields [redacted]", () => {
    expect(JSON.stringify(secret())).toBe(`"${REDACTED}"`);
  });

  it("JSON.stringify of a record containing the secret yields [redacted]", () => {
    const json = JSON.stringify({ config: { key: secret() }, list: [secret()] });
    expect(json).not.toContain(FAKE_KEY);
    expect(json).toContain(REDACTED);
  });

  it("a template literal yields [redacted]", () => {
    expect(`${secret()}`).toBe(REDACTED);
  });

  it("string concatenation and String() yield [redacted]", () => {
    expect(`key=${String(secret())}`).toBe(`key=${REDACTED}`);
    expect("" + String(secret())).toBe(REDACTED);
  });

  it("util.inspect (what console.log prints) yields [redacted]", () => {
    const shown = inspect({ secret: secret() }, { depth: 5 });
    expect(shown).not.toContain(FAKE_KEY);
    expect(shown).toContain(REDACTED);
  });

  it("valueOf and toPrimitive yield [redacted] so arithmetic/coercion cannot leak it", () => {
    const s = secret();
    expect(s.valueOf()).toBe(REDACTED);
    expect(`${s as unknown as string}`).toBe(REDACTED);
  });

  it("expose() is the only way to the value, and withValue scopes it", () => {
    expect(secret().expose()).toBe(FAKE_KEY);
    expect(secret().withValue((v) => v.length)).toBe(FAKE_KEY.length);
  });

  it("is frozen, so no caller can attach the value to it", () => {
    const s = secret();
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.values(s).join(" ")).not.toContain(FAKE_KEY);
  });

  it("fingerprint is stable, non-reversible, and shorter than the key", () => {
    const a = secret().fingerprint();
    expect(a).toBe(secret().fingerprint());
    expect(a).not.toContain(FAKE_KEY);
    expect(a.length).toBe(16);
    const other = new Secret(`${FAKE_KEY}x`, "k", { kind: "env", name: "X", viaFallbackName: false });
    expect(other.fingerprint()).not.toBe(a);
  });

  it("equals compares without exposing either side", () => {
    expect(secret().equals(secret())).toBe(true);
    expect(secret().equals(new Secret("different-value-entirely", "k", { kind: "env", name: "X", viaFallbackName: false }))).toBe(false);
    expect(secret().equals(null)).toBe(false);
  });
});

describe("AC2: a missing key yields a disabled-Jev config, not an exception", () => {
  it("an empty environment resolves to key_absent with Jev disabled", () => {
    const resolution = resolveJevKey(jevConfig(), { env: {} });
    expect(resolution.status).toBe("key_absent");
    expect(resolution.secret).toBeNull();
    expect(resolution.jevEnabled).toBe(false);
  });

  it("never throws for any keySource shape, including hostile input", () => {
    const shapes = [
      jevConfig(),
      jevConfig({ keySource: { kind: "none", name: "TYPESAFE_API_KEY" } }),
      jevConfig({ keySource: { kind: "pi_secrets", name: "TYPESAFE_API_KEY" } }),
      jevConfig({ keySource: { kind: "env", name: "" } as never }),
    ];
    for (const config of shapes) {
      expect(() => resolveJevKey(config, { env: {} })).not.toThrow();
      expect(resolveJevKey(config, { env: {} }).jevEnabled).toBe(false);
    }
  });

  it("a secrets facility that throws is treated as 'no key', not as an error", () => {
    const exploding: SecretsPort = {
      get: () => {
        throw new Error(`vault read failed for ${FAKE_KEY}`);
      },
    };
    const config = jevConfig({ keySource: { kind: "pi_secrets", name: "TYPESAFE_API_KEY" } });
    const resolution = resolveJevKey(config, { secrets: exploding });
    expect(resolution.status).toBe("key_absent");
    expect(resolution.jevEnabled).toBe(false);
    expect(resolution.message).not.toContain(FAKE_KEY);
  });

  it("produces exactly one clear message that names the fix and no value", () => {
    const { message } = resolveJevKey(jevConfig(), { env: {} });
    expect(message).toContain("Jev assistance is disabled");
    expect(message).toContain(DEFAULT_KEY_ENV_VAR);
    expect(message).toContain("deterministic");
    expect(message).not.toContain(FAKE_KEY);
    expect(message.split("\n")).toHaveLength(1);
  });

  it("applyKeyResolution turns jev.enabled off and can never turn it on", () => {
    const on = jevConfig();
    const absent = resolveJevKey(on, { env: {} });
    expect(applyKeyResolution(on, absent).config.jev.enabled).toBe(false);

    // A resolution claiming success cannot enable Jev that config has off.
    const off = defaultConfig();
    const resolved = resolveJevKey(jevConfig(), { env: { [DEFAULT_KEY_ENV_VAR]: FAKE_KEY } });
    expect(resolved.jevEnabled).toBe(true);
    expect(applyKeyResolution(off, resolved).config.jev.enabled).toBe(false);
  });

  it("jev.enabled: false short-circuits before the environment is read at all", () => {
    let reads = 0;
    const env = new Proxy({} as Record<string, string | undefined>, {
      get: () => {
        reads++;
        return FAKE_KEY;
      },
    });
    const resolution = resolveJevKey(defaultConfig(), { env });
    expect(resolution.status).toBe("jev_disabled");
    expect(reads).toBe(0);
  });

  it("keySource.kind 'none' looks for nothing and says so", () => {
    const config = jevConfig({ keySource: { kind: "none", name: DEFAULT_KEY_ENV_VAR } });
    const resolution = resolveJevKey(config, { env: { [DEFAULT_KEY_ENV_VAR]: FAKE_KEY } });
    expect(resolution.status).toBe("no_key_source");
    expect(resolution.secret).toBeNull();
  });

  it("pi_secrets with no facility supplied is 'secrets_unavailable', not a crash", () => {
    const config = jevConfig({ keySource: { kind: "pi_secrets", name: DEFAULT_KEY_ENV_VAR } });
    const resolution = resolveJevKey(config);
    expect(resolution.status).toBe("secrets_unavailable");
    expect(resolution.jevEnabled).toBe(false);
  });

  it("a blank or whitespace-only value counts as absent", () => {
    for (const value of ["", "   ", "\n\t"]) {
      expect(resolveJevKey(jevConfig(), { env: { [DEFAULT_KEY_ENV_VAR]: value } }).status).toBe("key_absent");
    }
  });
});

describe("resolveJevKey reads the source named by config, never a hardcoded one", () => {
  it("resolves from the shipped default env var name", () => {
    const resolution = resolveJevKey(jevConfig(), { env: { [DEFAULT_KEY_ENV_VAR]: FAKE_KEY } });
    expect(resolution.status).toBe("resolved");
    expect(resolution.jevEnabled).toBe(true);
    expect(resolution.secret?.expose()).toBe(FAKE_KEY);
    expect(resolution.secret?.origin.name).toBe(DEFAULT_KEY_ENV_VAR);
  });

  it("resolves from a user-configured env var name in preference to the fallback", () => {
    const config = jevConfig({ keySource: { kind: "env", name: "MY_OWN_KEY_VAR" } });
    const resolution = resolveJevKey(config, {
      env: { MY_OWN_KEY_VAR: FAKE_KEY, [FALLBACK_KEY_ENV_VARS[0] as string]: "other-value-entirely" },
    });
    expect(resolution.secret?.origin.name).toBe("MY_OWN_KEY_VAR");
    expect(resolution.secret?.origin.viaFallbackName).toBe(false);
  });

  it("accepts the documented development fallback name only when the configured one is unset", () => {
    const resolution = resolveJevKey(jevConfig(), { env: { [FALLBACK_KEY_ENV_VARS[0] as string]: FAKE_KEY } });
    expect(resolution.status).toBe("resolved");
    expect(resolution.secret?.origin.viaFallbackName).toBe(true);
    expect(resolveJevKey(jevConfig(), { env: { [FALLBACK_KEY_ENV_VARS[0] as string]: FAKE_KEY }, allowFallbackNames: false }).status).toBe("key_absent");
  });

  it("resolves from Pi's secrets facility when keySource.kind is pi_secrets", () => {
    const facility: SecretsPort = { get: (name) => (name === "TYPESAFE_API_KEY" ? FAKE_KEY : null) };
    const config = jevConfig({ keySource: { kind: "pi_secrets", name: "TYPESAFE_API_KEY" } });
    const resolution = resolveJevKey(config, { secrets: facility });
    expect(resolution.status).toBe("resolved");
    expect(resolution.secret?.origin.kind).toBe("pi_secrets");
  });

  it("keyDiagnostics carries everything except the credential", () => {
    const diagnostics = keyDiagnostics(resolveJevKey(jevConfig(), { env: { [DEFAULT_KEY_ENV_VAR]: FAKE_KEY } }));
    const json = JSON.stringify(diagnostics);
    expect(json).not.toContain(FAKE_KEY);
    expect(diagnostics.keyLength).toBe(FAKE_KEY.length);
    expect(diagnostics.keyFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(diagnostics.sourceName).toBe(DEFAULT_KEY_ENV_VAR);
  });

  it("authorizationHeader is the only place the value becomes a plain string", () => {
    const resolution = resolveJevKey(jevConfig(), { env: { [DEFAULT_KEY_ENV_VAR]: FAKE_KEY } });
    const header = authorizationHeader(resolution.secret as Secret);
    expect(header["Authorization"]).toBe(`Bearer ${FAKE_KEY}`);
    expect(Object.isFrozen(header)).toBe(true);
  });
});
