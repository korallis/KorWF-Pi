/**
 * `/korwf config` and `/korwf disclosure` message builders (issue #21).
 */
import { describe, it, expect } from "vitest";
import { configMessage, disclosureMessage } from "../../../src/extension/commands/config.ts";
import { createMemoryDisclosureStore, acceptDisclosure } from "../../../src/extension/disclosure.ts";
import { defaultConfig, loadConfig } from "../../../src/config/index.ts";

const PROJECT = "/tmp/project-a";

describe("AC1: `/korwf config` summarises the effective config and its layers", () => {
  it("reports shadow mode, disabled Jev and the layers that contributed", () => {
    const result = loadConfig(PROJECT, { userConfigDir: null, env: {}, readFile: () => null });
    const text = configMessage(result);
    expect(text).toContain("mode: shadow");
    expect(text).toContain("jev: disabled");
    expect(text).toContain("deterministic workflow only");
    expect(text).toContain("✓ defaults");
    expect(text).toContain("every model Pi has configured");
  });

  it("an invalid config prints every error and refuses rather than degrading", () => {
    const result = loadConfig(PROJECT, {
      userConfigDir: null,
      env: {},
      readFile: () => JSON.stringify({ mode: "turbo" }),
    });
    const text = configMessage(result);
    expect(result.ok).toBe(false);
    expect(text).toContain("[schema] mode");
    expect(text).toContain("will not start a workflow with an invalid configuration");
  });

  it("surfaces a V9 Jev downgrade as a warning, not an error", () => {
    const result = loadConfig(PROJECT, {
      userConfigDir: null,
      env: { KORWF_JEV_ENABLED: "true" },
      readFile: () => null,
    });
    expect(result.ok).toBe(true);
    expect(configMessage(result)).toContain("[V9] jev.enabled");
  });
});

describe("AC3: `/korwf disclosure` shows the text and the acceptance state", () => {
  it("says the disclosure is outstanding before acceptance", () => {
    const store = createMemoryDisclosureStore();
    const text = disclosureMessage(defaultConfig(), PROJECT, store);
    expect(text).toContain("what leaves this machine");
    expect(text).toContain("Not yet accepted in this project");
  });

  it("shows when and at which version it was accepted", () => {
    const store = createMemoryDisclosureStore();
    acceptDisclosure(PROJECT, store, { packageVersion: "0.1.0", now: () => new Date("2026-05-06T07:08:09Z") });
    const text = disclosureMessage(defaultConfig(), PROJECT, store);
    expect(text).toContain("Accepted on 2026-05-06T07:08:09.000Z");
    expect(text).toContain("package 0.1.0");
  });
});
