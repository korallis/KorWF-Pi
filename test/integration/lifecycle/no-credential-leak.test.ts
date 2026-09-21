/**
 * Stage 2 exit criterion, part 4: "failures cannot hang Pi or leak
 * credentials" (issue #32 Scope test 4; PLAN §8 Stage 2 Exit; ADR 0003
 * rule 3; docs/threat-model.md).
 *
 * A fake key is put in the environment of an isolated session, a decision is
 * run against a mock transport, and then every byte the session wrote under
 * its temp dir — the SQLite store, the WAL, traces, artifacts, the session
 * log, Pi's own settings — is searched for that value. It must appear
 * nowhere, and it must appear nowhere in the session's stdout or stderr
 * either.
 *
 * The key used here is generated at runtime from random bytes, so nothing
 * credential-shaped is committed and the search string cannot accidentally
 * match unrelated content.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  installPackage,
  makeIsolatedPi,
  piCliAvailable,
  runKorwf,
  type IsolatedPi,
} from "./pi-session.ts";

const available = piCliAvailable();

/** A distinctive, disposable, runtime-only value that stands in for a key. */
function makeFakeKey(): string {
  return `korwffake-${randomBytes(24).toString("hex")}`;
}

/** Every regular file under `dir`, recursively. */
function allFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Files under `dir` whose raw bytes contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const file of allFiles(dir)) {
    if (statSync(file).size > 32 * 1024 * 1024) continue;
    if (readFileSync(file).includes(needle)) hits.push(file);
  }
  return hits;
}

describe.skipIf(!available)("M2 exit: a key in the environment never reaches disk or output", () => {
  const KEY = makeFakeKey();
  let pi: IsolatedPi;

  beforeAll(() => {
    pi = makeIsolatedPi("korwf-leak-");
    expect(installPackage(pi).status).toBe(0);
  });

  afterAll(() => {
    pi.cleanup();
  });

  it("/korwf jev reports the key's source and fingerprint, never the key", () => {
    const run = runKorwf(pi, ["/korwf jev", "/korwf config", "/korwf why"], {
      env: { TYPESAFE_API_KEY: KEY, KORWF_JEV_ENABLED: "true" },
    });
    expect(run.status).toBe(0);
    expect(run.transcript).toContain("key source: env:TYPESAFE_API_KEY");
    expect(run.transcript).toContain(`key length: ${String(KEY.length)} characters`);

    // The whole session output, protocol lines included.
    expect(run.stdout).not.toContain(KEY);
    expect(run.stderr).not.toContain(KEY);
  });

  it("no file the session wrote under its temp root contains the key", () => {
    runKorwf(pi, ["/korwf jev", "/korwf config", "/korwf why", "/korwf status"], {
      env: { TYPESAFE_API_KEY: KEY, KORWF_JEV_ENABLED: "true" },
    });
    // Covers the SQLite store and its WAL, artifacts, traces, Pi's settings
    // and session logs — everything below the isolated root.
    expect(filesContaining(pi.root, KEY)).toEqual([]);
  });

  it("the key is not written even when the session is asked to fail", () => {
    // An unreachable base URL forces the transport's error path, which is
    // where a naive implementation logs the request it was making.
    const run = runKorwf(pi, ["/korwf jev", "/korwf why"], {
      env: {
        TYPESAFE_API_KEY: KEY,
        KORWF_JEV_ENABLED: "true",
        KORWF_JEV_BASE_URL: "https://127.0.0.1:1",
      },
    });
    expect(run.stdout).not.toContain(KEY);
    expect(run.stderr).not.toContain(KEY);
    expect(filesContaining(pi.root, KEY)).toEqual([]);
  });
});
