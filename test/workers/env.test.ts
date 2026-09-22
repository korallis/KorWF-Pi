/**
 * #68 AC1: "Worker env does not contain the Jev key variable."
 *
 * Asserted twice, deliberately: once against the pure builder, and once
 * against a **real spawned subprocess** that reports back the environment it
 * actually received (`spawn-env.test.ts`). The unit test alone would pass even
 * if `spawnWorker` forgot to use the builder.
 */
import { describe, it, expect } from "vitest";
import {
  CREDENTIAL_NAME_PATTERNS,
  DEPTH_ENV_VAR,
  INHERITED_ENV_NAMES,
  buildWorkerEnv,
  canSpawnWorker,
  isCredentialName,
  readWorkerDepth,
  scrubbedNames,
} from "../../src/workers/env.ts";
import { DEFAULT_KEY_ENV_VAR, FALLBACK_KEY_ENV_VARS } from "../../src/security/secrets.ts";

const parentEnv: Record<string, string> = {
  PATH: "/usr/bin",
  HOME: "/home/example",
  [DEFAULT_KEY_ENV_VAR]: "value-not-a-real-key",
  JEV_API_KEY: "value-not-a-real-key", // check-secrets:allow
  OPENAI_API_KEY: "value-not-a-real-key",
  GITHUB_TOKEN: "value-not-a-real-key",
  AWS_SECRET_ACCESS_KEY: "value-not-a-real-key",
  DB_PASSWORD: "value-not-a-real-key",
  SOME_CREDENTIAL_FILE: "/x/y",
  PROJECT_NAME: "korwf",
};

describe("AC1: a worker never receives credentials", () => {
  it("drops the product's own key variables", () => {
    const env = buildWorkerEnv({ parentEnv, workerId: "w1", role: "scout", depth: 1 });
    expect(env[DEFAULT_KEY_ENV_VAR]).toBeUndefined();
    for (const name of FALLBACK_KEY_ENV_VARS) expect(env[name]).toBeUndefined();
  });

  it("drops every credential-shaped variable, not only the ones we know about", () => {
    const env = buildWorkerEnv({ parentEnv, workerId: "w1", role: "scout", depth: 1 });
    for (const name of Object.keys(parentEnv)) {
      if (isCredentialName(name)) expect(env[name], `${name} leaked`).toBeUndefined();
    }
    expect(Object.values(env)).not.toContain("value-not-a-real-key");
  });

  it("classifies each documented credential pattern as a credential", () => {
    for (const pattern of CREDENTIAL_NAME_PATTERNS) {
      expect(isCredentialName(`MY_${pattern}_VALUE`)).toBe(true);
      expect(isCredentialName(`my_${pattern.toLowerCase()}_value`)).toBe(true);
    }
  });

  it("inherits by allowlist, so an unrelated variable is dropped too", () => {
    const env = buildWorkerEnv({ parentEnv, workerId: "w1", role: "scout", depth: 1 });
    expect(env.PROJECT_NAME).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(scrubbedNames(parentEnv)).toContain("PROJECT_NAME");
    expect(scrubbedNames(parentEnv)).toContain(DEFAULT_KEY_ENV_VAR);
  });

  it("refuses a credential-shaped extra variable rather than passing it", () => {
    expect(() =>
      buildWorkerEnv({
        parentEnv,
        workerId: "w1",
        role: "scout",
        depth: 1,
        extra: { MY_API_KEY: "value-not-a-real-key" },
      }),
    ).toThrow(/refusing to pass credential-shaped variable/);
  });

  it("never lists a credential-shaped name among the inherited names", () => {
    for (const name of INHERITED_ENV_NAMES) expect(isCredentialName(name), name).toBe(false);
  });
});

describe("ADR 0004 guard 2: KORWF_WORKER_DEPTH", () => {
  it("marks the worker with its depth, id and role", () => {
    const env = buildWorkerEnv({ parentEnv, workerId: "w7", role: "verifier", depth: 1 });
    expect(env[DEPTH_ENV_VAR]).toBe("1");
    expect(env.KORWF_WORKER).toBe("1");
    expect(env.KORWF_WORKER_ID).toBe("w7");
    expect(env.KORWF_WORKER_ROLE).toBe("verifier");
  });

  it("lets an orchestrator (no marker) spawn and refuses a worker (depth 1)", () => {
    expect(canSpawnWorker({}).allowed).toBe(true);
    expect(canSpawnWorker({ [DEPTH_ENV_VAR]: "1" }).allowed).toBe(false);
    expect(canSpawnWorker({ [DEPTH_ENV_VAR]: "2" }).allowed).toBe(false);
  });

  it("permits depth 1 spawning only when maxDepth is explicitly raised", () => {
    expect(canSpawnWorker({ [DEPTH_ENV_VAR]: "1" }, 2).allowed).toBe(true);
  });

  it("treats a malformed depth as the ceiling, never as room to spawn", () => {
    expect(readWorkerDepth({ [DEPTH_ENV_VAR]: "not-a-number" })).toBe(Number.MAX_SAFE_INTEGER);
    expect(readWorkerDepth({ [DEPTH_ENV_VAR]: "-3" })).toBe(Number.MAX_SAFE_INTEGER);
    expect(canSpawnWorker({ [DEPTH_ENV_VAR]: "not-a-number" }).allowed).toBe(false);
    expect(canSpawnWorker({ [DEPTH_ENV_VAR]: "" }).allowed).toBe(true);
  });

  it("explains the refusal instead of failing silently", () => {
    const refusal = canSpawnWorker({ [DEPTH_ENV_VAR]: "1" });
    expect(refusal.allowed).toBe(false);
    if (refusal.allowed) throw new Error("unreachable");
    expect(refusal.reason).toContain("workers may not spawn workers");
  });

  it("sets PI_OFFLINE only when the contract asks for it", () => {
    expect(buildWorkerEnv({ parentEnv, workerId: "w1", role: "scout", depth: 1 }).PI_OFFLINE).toBeUndefined();
    expect(
      buildWorkerEnv({ parentEnv, workerId: "w1", role: "scout", depth: 1, offline: true }).PI_OFFLINE,
    ).toBe("1");
  });
});
