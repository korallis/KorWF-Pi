/**
 * First-use data disclosure (issue #21).
 *
 * AC3: "Disclosure shown once per project per disclosure version."
 * AC4: "No outbound call is possible before disclosure is accepted (test with
 *       a stub transport that throws if called)."
 */
import { describe, it, expect } from "vitest";
import {
  ensureDisclosureAccepted,
  DISCLOSURE_VERSION,
  DisclosureRequiredError,
  acceptDisclosure,
  assertOutboundAllowed,
  buildDisclosure,
  createMemoryDisclosureStore,
  disclosureStatus,
  guardOutbound,
  type DisclosureStore,
  type OutboundEdge,
} from "../../../src/extension/disclosure.ts";
import { createFileDisclosureStore, disclosureRecordPath } from "../../../src/extension/disclosure.ts";
import { defaultConfig } from "../../../src/config/index.ts";
import type { KorwfConfig } from "../../../src/config/index.ts";
import { makeTempDir } from "../../helpers/temp-dir.ts";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const PROJECT = "/tmp/project-a";
const OTHER = "/tmp/project-b";
const PKG = "0.1.0";

/** A transport that fails the test if it is ever reached. */
function stubTransport() {
  let calls = 0;
  const send = () => {
    calls += 1;
    throw new Error("outbound transport was called");
  };
  return { send, get calls() { return calls; } };
}

/** Counts how many times the disclosure would be presented to the user. */
function showTimes(config: KorwfConfig, store: DisclosureStore, projects: readonly string[]): number {
  let shown = 0;
  for (const p of projects) {
    if (disclosureStatus(config, p, store).required) {
      shown += 1;
      acceptDisclosure(p, store, { packageVersion: PKG });
    }
  }
  return shown;
}

describe("AC3: the disclosure is shown once per project per disclosure version", () => {
  it("is required on first use and not again after acceptance", () => {
    const config = defaultConfig();
    const store = createMemoryDisclosureStore();
    expect(disclosureStatus(config, PROJECT, store)).toEqual({ required: true, reason: "never_shown" });
    const acceptance = acceptDisclosure(PROJECT, store, { packageVersion: PKG, now: () => new Date("2026-01-02T03:04:05Z") });
    expect(acceptance.disclosureAcceptedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(acceptance.disclosureVersion).toBe(DISCLOSURE_VERSION);
    expect(acceptance.packageVersion).toBe(PKG);
    const after = disclosureStatus(config, PROJECT, store);
    expect(after.required).toBe(false);
    expect(after.reason).toBe("accepted");
  });

  it("is shown exactly once across repeated sessions in the same project", () => {
    const config = defaultConfig();
    const store = createMemoryDisclosureStore();
    expect(showTimes(config, store, [PROJECT, PROJECT, PROJECT, PROJECT])).toBe(1);
  });

  it("is per project: accepting in one project does not cover another", () => {
    const config = defaultConfig();
    const store = createMemoryDisclosureStore();
    acceptDisclosure(PROJECT, store, { packageVersion: PKG });
    expect(disclosureStatus(config, OTHER, store)).toEqual({ required: true, reason: "never_shown" });
  });

  it("is re-shown when the disclosure text version changes", () => {
    const config = defaultConfig();
    const store = createMemoryDisclosureStore({
      [PROJECT]: {
        disclosureAcceptedAt: "2025-01-01T00:00:00.000Z",
        disclosureVersion: DISCLOSURE_VERSION - 1,
        packageVersion: "0.0.1",
      },
    });
    const status = disclosureStatus(config, PROJECT, store);
    expect(status).toEqual({ required: true, reason: "version_changed", acceptedVersion: DISCLOSURE_VERSION - 1 });
  });

  it("`privacy.firstUseDisclosure: false` is an explicit opt-out, not a silent skip", () => {
    const config = { ...defaultConfig(), privacy: { ...defaultConfig().privacy, firstUseDisclosure: false } } as KorwfConfig;
    const store = createMemoryDisclosureStore();
    expect(disclosureStatus(config, PROJECT, store)).toEqual({ required: false, reason: "disabled_by_config" });
  });
});

const EDGES: readonly OutboundEdge[] = ["typesafe", "model_provider", "notification"];

describe("AC4: no outbound call is possible before the disclosure is accepted", () => {
  it("a guarded stub transport is never invoked while the disclosure is pending", () => {
    const config = defaultConfig();
    const store = createMemoryDisclosureStore();
    for (const edge of EDGES) {
      const transport = stubTransport();
      const guarded = guardOutbound(config, PROJECT, store, edge, transport.send);
      expect(() => guarded()).toThrow(DisclosureRequiredError);
      expect(transport.calls).toBe(0);
    }
  });

  it("the same transport runs once the disclosure is accepted", () => {
    const config = defaultConfig();
    const store = createMemoryDisclosureStore();
    let calls = 0;
    const guarded = guardOutbound(config, PROJECT, store, "typesafe", () => {
      calls += 1;
      return "sent";
    });
    expect(() => guarded()).toThrow(DisclosureRequiredError);
    acceptDisclosure(PROJECT, store, { packageVersion: PKG });
    expect(guarded()).toBe("sent");
    expect(calls).toBe(1);
  });

  it("a disclosure version bump re-closes the gate on an already-accepted project", () => {
    const config = defaultConfig();
    const store = createMemoryDisclosureStore({
      [PROJECT]: { disclosureAcceptedAt: "2025-01-01T00:00:00.000Z", disclosureVersion: DISCLOSURE_VERSION - 1, packageVersion: "0.0.1" },
    });
    const transport = stubTransport();
    const guarded = guardOutbound(config, PROJECT, store, "typesafe", transport.send);
    expect(() => guarded()).toThrow(/changed/);
    expect(transport.calls).toBe(0);
  });

  it("the gate throws rather than returning a falsy value a caller could ignore", () => {
    const config = defaultConfig();
    const store = createMemoryDisclosureStore();
    expect(() => assertOutboundAllowed(config, PROJECT, store, "model_provider")).toThrow(DisclosureRequiredError);
    acceptDisclosure(PROJECT, store, { packageVersion: PKG });
    expect(() => assertOutboundAllowed(config, PROJECT, store, "model_provider")).not.toThrow();
  });
});

describe("AC3: the disclosure text names every data class and reflects the effective config", () => {
  it("covers all three outbound edges and the never-leaves list", () => {
    const text = buildDisclosure(defaultConfig());
    expect(text.version).toBe(DISCLOSURE_VERSION);
    expect(text.dataClasses.map((d) => d.edge)).toEqual([...EDGES]);
    expect(text.neverLeaves.length).toBeGreaterThanOrEqual(6);
    expect(text.lines.join("\n")).toContain("what leaves this machine");
  });

  it("says nothing goes to TypeSafe when Jev is disabled (the default)", () => {
    const text = buildDisclosure(defaultConfig());
    const typesafe = text.dataClasses.find((d) => d.edge === "typesafe");
    expect(typesafe?.when).toContain("disabled");
    expect(typesafe?.when).toContain("deterministic fallback");
    expect(text.lines.join("\n")).toContain("notification channels are disabled");
  });

  it("names the key source but never a key value", () => {
    const d = defaultConfig();
    const config = { ...d, jev: { ...d.jev, enabled: true } } as KorwfConfig;
    const text = buildDisclosure(config);
    const joined = text.lines.join("\n");
    expect(joined).toContain("env:TYPESAFE_API_KEY");
    expect(joined).toContain("never stored or logged");
  });

  it("reports the user's own deny-list sizes so a tightened config is visible", () => {
    const d = defaultConfig();
    const config = { ...d, privacy: { ...d.privacy, denyPaths: [...d.privacy.denyPaths, "docs/private/**"] } } as KorwfConfig;
    expect(buildDisclosure(config).neverLeaves[0]).toContain("41 deny globs");
  });
});

describe("AC3/AC4: the interactive flow shows once, records acceptance, and honours a decline", () => {
  it("prompts on first use only, and the gate opens after acceptance", async () => {
    const config = defaultConfig();
    const store = createMemoryDisclosureStore();
    let prompts = 0;
    const ui = {
      confirm: () => {
        prompts += 1;
        return true;
      },
    };
    const first = await ensureDisclosureAccepted(config, PROJECT, store, ui, { packageVersion: PKG });
    expect(first).toEqual({ shown: true, accepted: true, reason: "never_shown" });
    const second = await ensureDisclosureAccepted(config, PROJECT, store, ui, { packageVersion: PKG });
    expect(second).toEqual({ shown: false, accepted: true, reason: "accepted" });
    expect(prompts).toBe(1);
    expect(() => assertOutboundAllowed(config, PROJECT, store, "typesafe")).not.toThrow();
  });

  it("a decline records nothing and leaves the outbound gate shut", async () => {
    const config = defaultConfig();
    const store = createMemoryDisclosureStore();
    const transport = stubTransport();
    const outcome = await ensureDisclosureAccepted(config, PROJECT, store, { confirm: () => false }, { packageVersion: PKG });
    expect(outcome).toEqual({ shown: true, accepted: false, reason: "declined" });
    expect(store.get(PROJECT)).toBeNull();
    expect(() => guardOutbound(config, PROJECT, store, "typesafe", transport.send)()).toThrow(DisclosureRequiredError);
    expect(transport.calls).toBe(0);
  });

  it("with no UI (print/RPC mode) nothing is auto-accepted on the user's behalf", async () => {
    const config = defaultConfig();
    const store = createMemoryDisclosureStore();
    const outcome = await ensureDisclosureAccepted(
      config,
      PROJECT,
      store,
      { confirm: () => true, hasUI: false },
      { packageVersion: PKG },
    );
    expect(outcome).toEqual({ shown: false, accepted: false, reason: "no_ui" });
    expect(store.get(PROJECT)).toBeNull();
  });
});

describe("AC3: acceptance is recorded in the project's storage root and survives a restart", () => {
  it("writes disclosureAcceptedAt and the package version, then reads them back", () => {
    const dir = makeTempDir();
    try {
      const config = defaultConfig();
      const store = createFileDisclosureStore(config);
      expect(disclosureStatus(config, dir.path, store).required).toBe(true);
      acceptDisclosure(dir.path, store, { packageVersion: PKG, now: () => new Date("2026-03-04T05:06:07Z") });
      expect(existsSync(disclosureRecordPath(dir.path, config))).toBe(true);

      // A fresh store stands in for a new session.
      const reopened = createFileDisclosureStore(config);
      const status = disclosureStatus(config, dir.path, reopened);
      expect(status.required).toBe(false);
      expect(status.reason === "accepted" && status.acceptance.disclosureAcceptedAt).toBe("2026-03-04T05:06:07.000Z");
      expect(status.reason === "accepted" && status.acceptance.packageVersion).toBe(PKG);
    } finally {
      dir.cleanup();
    }
  });

  it("treats a corrupt record as not accepted, so the gate stays closed", () => {
    const dir = makeTempDir();
    try {
      const config = defaultConfig();
      const file = disclosureRecordPath(dir.path, config);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "{ not json");
      const store = createFileDisclosureStore(config);
      expect(disclosureStatus(config, dir.path, store)).toEqual({ required: true, reason: "never_shown" });
      const transport = stubTransport();
      expect(() => guardOutbound(config, dir.path, store, "typesafe", transport.send)()).toThrow(DisclosureRequiredError);
      expect(transport.calls).toBe(0);
    } finally {
      dir.cleanup();
    }
  });
});
