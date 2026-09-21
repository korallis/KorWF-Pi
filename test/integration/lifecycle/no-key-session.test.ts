/**
 * Stage 2 exit criterion, part 2: "works with no Jev key"
 * (issue #32 Scope test 2; PLAN §8 Stage 2 Exit; ADR 0007).
 *
 * The same isolated session as `isolated-session.test.ts`, but with no
 * `TYPESAFE_API_KEY` and no `JEV_API_KEY` anywhere in the environment (see
 * `CREDENTIAL_ENV_VARS` in `pi-session.ts`: the session environment is built
 * from scratch, so absence is guaranteed rather than hoped for).
 *
 * What must hold:
 *  - the package still loads and every `/korwf` command still answers;
 *  - Jev reports itself *disabled* with the documented sentence, not an error;
 *  - nothing throws — no error notification, no non-zero exit, no stack trace;
 *  - no outbound attempt is made (asserted in-process below, where the
 *    transport can be observed).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/index.ts";
import { createJev } from "../../../src/jev/index.ts";
import { filterForTest } from "../../../src/jev/mock.ts";
import { noulQuestion } from "../../../src/jev/transport.ts";
import { makeTempDir } from "../../helpers/temp-dir.ts";
import {
  CREDENTIAL_ENV_VARS,
  installPackage,
  makeIsolatedPi,
  piCliAvailable,
  runKorwf,
  sessionEnv,
  type IsolatedPi,
} from "./pi-session.ts";

const available = piCliAvailable();

describe.skipIf(!available)("M2 exit: the package works with no Jev key", () => {
  let pi: IsolatedPi;

  beforeAll(() => {
    pi = makeIsolatedPi("korwf-nokey-");
    const install = installPackage(pi);
    expect(install.status, `pi install failed: ${install.stderr}`).toBe(0);
  });

  afterAll(() => {
    pi.cleanup();
  });

  it("builds a session environment with no credential variable at all", () => {
    const env = sessionEnv(pi);
    for (const name of CREDENTIAL_ENV_VARS) {
      expect(Object.prototype.hasOwnProperty.call(env, name), `${name} leaked into the session`).toBe(false);
    }
  });

  it("loads and answers /korwf version with no key present", () => {
    const run = runKorwf(pi, ["/korwf version"]);
    expect(run.stderr).not.toMatch(/Failed to load extension/);
    expect(run.transcript).toContain("korwf-pi v");
    expect(run.status).toBe(0);
  });

  it("reports Jev disabled with the documented message, not an error", () => {
    const run = runKorwf(pi, ["/korwf jev", "/korwf status", "/korwf config"]);
    expect(run.transcript).toContain("Jev credential status: disabled");
    expect(run.transcript).toContain("deterministic fallback");
    expect(run.transcript).toContain("The workflow is unaffected.");
    expect(run.transcript).toContain("jev: disabled — deterministic workflow only");

    const errors = run.events.filter(
      (e) => e.type === "extension_ui_request" && e.method === "notify" && e["notifyType"] === "error",
    );
    expect(errors).toEqual([]);
    expect(run.events.filter((e) => e.type === "response" && e.success === false)).toEqual([]);
  });

  it("never throws: no stack trace or unhandled rejection reaches the session", () => {
    const run = runKorwf(pi, ["/korwf jev", "/korwf config", "/korwf status", "/korwf why"]);
    const output = `${run.stdout}\n${run.stderr}`;
    expect(output).not.toMatch(/UnhandledPromiseRejection|Unhandled error|\bat .*\(.*:\d+:\d+\)/);
    expect(run.status).toBe(0);
    expect(run.signal).toBeNull();
  });

  it("downgrades jev.enabled=true to optional mode instead of failing to load", () => {
    // The hostile case: a project that *asks* for Jev, in a session that has
    // no key. V9 must downgrade with a warning, and the session must still
    // load (config-reference V9; src/config/validate.ts).
    mkdirSync(join(pi.project, ".korwf"), { recursive: true });
    writeFileSync(
      join(pi.project, ".korwf", "config.json"),
      JSON.stringify({ configVersion: 1, jev: { enabled: true } }, null, 2),
    );
    try {
      const run = runKorwf(pi, ["/korwf config", "/korwf jev"]);
      expect(run.transcript).toContain("jev: disabled — deterministic workflow only");
      expect(run.transcript).toContain("V9");
      expect(run.transcript).toContain("Jev credential status: disabled");
      expect(run.status).toBe(0);
    } finally {
      writeFileSync(join(pi.project, ".korwf", "config.json"), JSON.stringify({ configVersion: 1 }));
    }
  });
});

describe("M2 exit: with no key, nothing goes outbound", () => {
  it("createJev returns the disabled transport and never calls fetch", async () => {
    // In-process, because the assertion is about the *absence* of a network
    // call: a stub `fetch` that fails the test if it is ever invoked.
    const calls: string[] = [];
    const fetchStub: typeof fetch = (input) => {
      calls.push(String(input));
      return Promise.reject(new Error("outbound request attempted with no key"));
    };

    const dir = makeTempDir("korwf-nokey-cfg-");
    try {
      const loaded = loadConfig(dir.path, { env: {}, userConfigDir: null });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;

      // `jev.enabled: true` forced on, so "disabled" can only come from the
      // absent key rather than from the shipped default being off.
      const transport = createJev(
        { jev: { ...loaded.config.jev, enabled: true } },
        { env: {}, fetchImpl: fetchStub },
      );
      const result = await transport.evaluate(
        filterForTest({
          model: loaded.config.jev.model,
          state: {},
          questions: { q: noulQuestion("is this offline?") },
        }),
      );

      expect(result.kind).toBe("disabled");
      expect(calls).toEqual([]);
    } finally {
      dir.cleanup();
    }
  });
});
