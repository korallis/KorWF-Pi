/**
 * `/korwf jev` message builder (issue #22).
 *
 * AC2: "Missing key yields a disabled-Jev config, not an exception" — the
 * user-visible half of that criterion: one clear message, never an error.
 */
import { describe, it, expect } from "vitest";
import { jevStatusMessage } from "../../../src/extension/commands/jev-status.ts";
import { defaultConfig } from "../../../src/config/index.ts";
import { DEFAULT_KEY_ENV_VAR } from "../../../src/security/index.ts";
import type { ConfigLoadResult } from "../../../src/config/index.ts";
import type { KorwfConfig } from "../../../src/config/types.ts";

/** A successful load result wrapping a config, without touching the filesystem. */
function loaded(jev: Partial<KorwfConfig["jev"]> = {}): ConfigLoadResult {
  const base = defaultConfig();
  return {
    ok: true,
    config: { ...base, jev: { ...base.jev, ...jev } } as KorwfConfig,
    layers: [{ layer: "defaults", path: null, present: true }],
    warnings: [],
  };
}

describe("AC2: /korwf jev reports the no-key state as a state, not an error", () => {
  it("shipped defaults (Jev off) explain that the deterministic workflow is unaffected", () => {
    const message = jevStatusMessage(loaded(), { env: {} });
    expect(message).toContain("disabled");
    expect(message).toContain("deterministic fallback");
    expect(message).not.toContain("Error");
  });

  it("Jev on with no key names the variable to set and stays disabled", () => {
    const message = jevStatusMessage(loaded({ enabled: true }), { env: {} });
    expect(message).toContain("Jev credential status: disabled");
    expect(message).toContain(DEFAULT_KEY_ENV_VAR);
    expect(message).toContain("jev.enabled to true");
  });

  it("pi_secrets with no facility says so rather than failing", () => {
    const message = jevStatusMessage(
      loaded({ enabled: true, keySource: { kind: "pi_secrets", name: "TYPESAFE_API_KEY" } }),
      {},
    );
    expect(message).toContain("secrets facility is not available");
  });

  it("an invalid config degrades to an explanation, never a throw", () => {
    const failed: ConfigLoadResult = {
      ok: false,
      errors: [{ rule: "V1", path: "fallback.staticOrder[0]", message: "is not in the allowlist", severity: "error" }],
      warnings: [],
      layers: [],
      message: "KorWF-Pi configuration is invalid (1 problem(s)):",
    };
    expect(() => jevStatusMessage(failed)).not.toThrow();
    expect(jevStatusMessage(failed)).toContain("unavailable until the configuration loads");
  });
});
