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
import { ask } from "../../../src/decisions/ask.ts";
import { DecisionRecorder } from "../../../src/decisions/record.ts";
import { echoQuestion } from "../../../src/decisions/examples.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import { loadConfig } from "../../../src/config/load.ts";
import type { KorwfConfig } from "../../../src/config/types.ts";
import { Secret } from "../../../src/security/secrets.ts";
import { clearRegisteredSecrets } from "../../../src/security/redact.ts";
import { openStore } from "../../../src/storage/db.ts";
import type { WorkflowId } from "../../../src/storage/records.ts";
import { TraceRecorder } from "../../../src/telemetry/trace.ts";
import { createRawPayloadSink } from "../../../src/telemetry/retention.ts";
import { makeTempDir } from "../../helpers/temp-dir.ts";
import { makeWorkflow } from "../../helpers/records.ts";
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

describe("M2 exit: a mock decision with a fake key writes no key to disk", () => {
  it("stores the Decision, the trace and the raw payload without the key", async () => {
    const KEY = makeFakeKey();
    const dir = makeTempDir("korwf-decision-leak-");
    try {
      // Raw-payload logging turned *on* — the most exposed configuration the
      // product offers (#31) — so the assertion is not trivially satisfied
      // by writing nothing.
      const loaded = loadConfig(dir.path, { env: {}, userConfigDir: null });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      const config: KorwfConfig = {
        ...loaded.config,
        privacy: {
          ...loaded.config.privacy,
          rawLogging: { enabled: true, retentionDays: 7, redactBeforeWrite: true },
        },
      };

      const { store } = openStore({ storageRoot: dir.path });
      try {
        store.workflows.insert(makeWorkflow());

        // Registering the value is what resolving a real key does (#22).
        const secret = new Secret(KEY, "TypeSafe API key", {
          kind: "env",
          name: "TYPESAFE_API_KEY",
          viaFallbackName: false,
        });
        expect(secret.expose()).toBe(KEY);

        let n = 0;
        const recorder = new DecisionRecorder({
          sink: store.decisions,
          workflowId: "wf-1" as WorkflowId,
          revision: "a".repeat(40),
          subject: null,
          newId: () => `dc-${String((n += 1))}`,
        });
        const rawSink = createRawPayloadSink({ config, artifacts: store.artifacts });
        expect(rawSink).not.toBeNull();
        const tracer = new TraceRecorder({
          sink: store.decisionTraces,
          workflowId: "wf-1",
          versions: { package: "0.1.0", schema: "1", policy: "1", questionSet: "b".repeat(64) },
          ...(rawSink === null ? {} : { rawPayloads: rawSink }),
        });

        // A mock transport that both receives and echoes the key: the worst
        // case for a naive raw-payload log.
        const transport = new MockJevTransport({
          responder: () => ({
            kind: "ok",
            response: {
              model: "jev-test",
              answers: { "q0:example.echo@1": { type: "noul", noul: 0.9 } },
              usage: { input_tokens: 1, output_tokens: 1 },
            },
            requestId: `req-${KEY}`,
            attempts: 1,
            elapsedMs: 1,
          }),
        });

        const result = await ask({ transport, recorder, tracer, model: "jev-test" }, echoQuestion, {
          text: `token ${KEY}`,
        });
        expect(result.decisionId).not.toBeNull();
        // The assertion below is only meaningful if bytes were actually
        // written: raw logging is on, so a payload file must exist.
        const traces = store.decisionTraces.all();
        expect(traces).toHaveLength(1);
        expect(traces[0]?.rawPayload).not.toBeNull();
      } finally {
        store.close();
      }

      // Scope test 4: the key appears nowhere on disk under the temp dir.
      expect(allFiles(dir.path).length).toBeGreaterThan(1);
      expect(filesContaining(dir.path, KEY)).toEqual([]);
    } finally {
      clearRegisteredSecrets();
      dir.cleanup();
    }
  });
});
