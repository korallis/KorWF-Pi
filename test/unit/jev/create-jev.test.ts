/**
 * `createJev` factory (issue #24). PLAN §3.J: works with no Jev key, never
 * throws, no live network request is ever attempted.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createJev, DisabledJevTransport, filterForTest } from "../../../src/jev/index.ts";
import { defaultConfig } from "../../../src/config/index.ts";
import { clearRegisteredSecrets } from "../../../src/security/redact.ts";
import type { KorwfConfig } from "../../../src/config/types.ts";

beforeEach(() => {
  clearRegisteredSecrets();
});

function failingFetch(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    throw new Error(`network request attempted to ${String(input)}`);
  }) as typeof fetch;
}

describe("createJev: no key => DisabledJevTransport, never throws", () => {
  it("jev.enabled false yields DisabledJevTransport", () => {
    const base = defaultConfig();
    const config = { ...base, jev: { ...base.jev, enabled: false } } as KorwfConfig;
    const jev = createJev(config, { env: {} });
    expect(jev).toBeInstanceOf(DisabledJevTransport);
    expect(jev.kind).toBe("disabled");
  });

  it("keySource.kind 'none' yields DisabledJevTransport even when enabled", () => {
    const base = defaultConfig();
    const config = {
      ...base,
      jev: { ...base.jev, enabled: true, keySource: { kind: "none" as const, name: "" } },
    } as KorwfConfig;
    const jev = createJev(config, { env: {} });
    expect(jev).toBeInstanceOf(DisabledJevTransport);
  });

  it("env source with no matching variable yields DisabledJevTransport (no throw)", () => {
    const base = defaultConfig();
    const config = {
      ...base,
      jev: { ...base.jev, enabled: true, keySource: { kind: "env" as const, name: "TYPESAFE_API_KEY" } },
    } as KorwfConfig;
    expect(() => createJev(config, { env: {}, fetchImpl: failingFetch() })).not.toThrow();
    const jev = createJev(config, { env: {}, fetchImpl: failingFetch() });
    expect(jev.kind).toBe("disabled");
  });

  it("never makes a network request when no key is present", async () => {
    const base = defaultConfig();
    const config = { ...base, jev: { ...base.jev, enabled: true } } as KorwfConfig;
    const jev = createJev(config, { env: {}, fetchImpl: failingFetch() });
    const result = await jev.evaluate(filterForTest({ state: "x", model: "jev-1.13.0", questions: {} }));
    expect(result.kind).toBe("disabled");
  });
});

describe("createJev: key present => HttpJevTransport with the configured base URL", () => {
  it("builds an HttpJevTransport", () => {
    const base = defaultConfig();
    const config = {
      ...base,
      jev: { ...base.jev, enabled: true, baseUrl: "https://proxy.example.internal" },
    } as KorwfConfig;
    const jev = createJev(config, { env: { TYPESAFE_API_KEY: "apikey_ZZZZfakefakefake0123456789abcdef" } }); // check-secrets:allow
    // createJev now wraps the transport in the resilience layer (#26); the
    // wrapper still reports kind "http", forwarding the underlying transport's.
    expect(jev.kind).toBe("http");
  });
});
