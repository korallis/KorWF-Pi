/**
 * Raw-payload logging, retention and deletion (issue #31).
 *
 * Acceptance criteria exercised here:
 *   AC1 "Default config stores no raw payloads (test asserts absence on disk)."
 *   AC2 "With opt-in, raw payloads are stored and purged after retention
 *        (fake clock test)."
 *
 * Both assert against the real filesystem under a temp storage root, because
 * "nothing was written" is only provable by looking on disk.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { loadConfig } from "../../../src/config/load.ts";
import type { KorwfConfig } from "../../../src/config/types.ts";
import { TraceRecorder } from "../../../src/telemetry/trace.ts";
import {
  ArtifactRawPayloadSink,
  RAW_LOG_ATTEMPT_DIR,
  RawPayloadRefusedError,
  createRawPayloadSink,
  expiryOf,
  purgeExpiredRawPayloads,
  purgeRawPayloadsNow,
  retentionSummary,
  prepareRawPayload,
  runRetentionSweep,
  wouldRefusePayload,
} from "../../../src/telemetry/retention.ts";
import { OutboundPolicy } from "../../../src/security/outbound.ts";
import { clearRegisteredSecrets, registerSecretValue } from "../../../src/security/redact.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makeTrace } from "../../helpers/trace.ts";
import { makeDecision, makeWorkflow } from "../../helpers/records.ts";

const open: { dir: TempDir; store: Store }[] = [];

function freshStore(): { store: Store; root: string } {
  const dir = makeTempDir("korwf-trace-");
  const { store } = openStore({ storageRoot: dir.path });
  open.push({ dir, store });
  return { store, root: dir.path };
}

/** The shipped defaults, loaded exactly as the product loads them (#21). */
function defaultConfig(projectRoot: string): KorwfConfig {
  const result = loadConfig(projectRoot, { env: {} });
  if (!result.ok) throw new Error(`default config failed to load: ${result.message}`);
  return result.config;
}

/** The same config with the user's opt-in applied. */
function optedInConfig(projectRoot: string, retentionDays = 7): KorwfConfig {
  const base = defaultConfig(projectRoot);
  return {
    ...base,
    privacy: {
      ...base.privacy,
      rawLogging: { enabled: true, retentionDays, redactBeforeWrite: true },
    },
  };
}

/**
 * A policy whose `redact` reintroduces a credential shape — a stand-in for a
 * future regression in #22/#28. The sink runs the project policy *after* the
 * global redactor, so this is the shape such a regression would take, and
 * the sink must still refuse to write: that refusal is the last line of
 * defence and has to be exercised by something. Only `redact` is ever called
 * on the policy by the sink.
 */
function brokenPolicy(): OutboundPolicy {
  // A synthetic AWS-style key id, never a real one.
  const shape = "AKIA" + "0123456789ABCDEF"; // check-secrets:allow
  return { redact: (text: string) => `${text}\n${shape}` } as unknown as OutboundPolicy;
}

function rawFilesIn(root: string): string[] {
  const dir = join(root, "artifacts", RAW_LOG_ATTEMPT_DIR);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f !== "manifest.json") : [];
}

function recorderFor(store: Store, config: KorwfConfig, clock: () => string): TraceRecorder {
  const sink = createRawPayloadSink({ artifacts: store.artifacts, config });
  return new TraceRecorder({
    sink: store.decisionTraces,
    workflowId: "wf-1",
    versions: { package: "0.1.0", schema: "1", policy: "1", questionSet: "q-hash" },
    rawPayloads: sink,
    now: clock,
    newId: (() => {
      let n = 0;
      return () => `tr-${(n += 1)}`;
    })(),
  });
}

const DRAFT = {
  decisionId: null,
  question: makeTrace().question,
  outcome: "jev" as const,
  detail: makeTrace().detail,
  request: makeTrace().request,
  latencyMs: 42,
  jevModelVersion: "jev-1",
  raw: { request: { state: { goal: "ship it" } }, response: { answers: { q0: { noul: 0.9 } } } },
};

afterEach(() => {
  clearRegisteredSecrets();
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

describe("AC1: default config stores no raw payloads", () => {
  it("createRawPayloadSink returns null under the shipped defaults", () => {
    const { store, root } = freshStore();
    const config = defaultConfig(root);
    expect(config.privacy.rawLogging.enabled).toBe(false);
    expect(createRawPayloadSink({ artifacts: store.artifacts, config })).toBeNull();
  });

  it("no raw payload file exists on disk after a traced decision", () => {
    const { store, root } = freshStore();
    const rec = recorderFor(store, defaultConfig(root), () => "2025-01-01T00:00:00.000Z");
    expect(rec.rawLoggingEnabled).toBe(false);
    rec.record(DRAFT);
    expect(rawFilesIn(root)).toEqual([]);
    expect(existsSync(join(root, "artifacts", RAW_LOG_ATTEMPT_DIR))).toBe(false);
  });

  it("the recorded trace says no raw payload was stored", () => {
    const { store, root } = freshStore();
    const trace = recorderFor(store, defaultConfig(root), () => "2025-01-01T00:00:00.000Z").record(DRAFT);
    expect(trace.rawPayload).toBeNull();
    expect(store.decisionTraces.withRawPayload()).toEqual([]);
  });

  it("the raw request never reaches the stored trace row either", () => {
    const { store, root } = freshStore();
    recorderFor(store, defaultConfig(root), () => "2025-01-01T00:00:00.000Z").record(DRAFT);
    expect(JSON.stringify(store.decisionTraces.all())).not.toContain("ship it");
  });
});

describe("AC2: with opt-in, raw payloads are stored and purged after retention", () => {
  it("writes the payload under the artifact store when opted in", () => {
    const { store, root } = freshStore();
    const trace = recorderFor(store, optedInConfig(root), () => "2025-01-01T00:00:00.000Z").record(DRAFT);
    expect(trace.rawPayload).not.toBeNull();
    expect(rawFilesIn(root)).toEqual(["tr-1.json"]);
    const body = readFileSync(join(root, "artifacts", trace.rawPayload?.relativePath ?? ""), "utf8");
    expect(body).toContain("ship it");
  });

  it("stamps expiresAt from privacy.rawLogging.retentionDays", () => {
    const { store, root } = freshStore();
    const trace = recorderFor(store, optedInConfig(root, 3), () => "2025-01-01T00:00:00.000Z").record(DRAFT);
    expect(trace.rawPayload?.expiresAt).toBe("2025-01-04T00:00:00.000Z");
  });

  it("purges the bytes once the fake clock passes the retention window", () => {
    const { store, root } = freshStore();
    const trace = recorderFor(store, optedInConfig(root, 7), () => "2025-01-01T00:00:00.000Z").record(DRAFT);
    const path = join(root, "artifacts", trace.rawPayload?.relativePath ?? "");
    expect(existsSync(path)).toBe(true);

    // One day before expiry: nothing is due.
    const early = purgeExpiredRawPayloads({
      traces: store.decisionTraces,
      artifacts: store.artifacts,
      now: () => "2025-01-07T00:00:00.000Z",
    });
    expect(early.rawPayloadsPurged).toEqual([]);
    expect(existsSync(path)).toBe(true);

    // One day after: the bytes go.
    const late = purgeExpiredRawPayloads({
      traces: store.decisionTraces,
      artifacts: store.artifacts,
      now: () => "2025-01-09T00:00:00.000Z",
    });
    expect(late.rawPayloadsPurged).toEqual([trace.rawPayload?.relativePath]);
    expect(late.bytesReclaimed).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(false);
  });

  it("keeps the trace row after the purge, with the pointer cleared", () => {
    const { store, root } = freshStore();
    const trace = recorderFor(store, optedInConfig(root, 1), () => "2025-01-01T00:00:00.000Z").record(DRAFT);
    purgeExpiredRawPayloads({
      traces: store.decisionTraces,
      artifacts: store.artifacts,
      now: () => "2025-02-01T00:00:00.000Z",
    });
    const after = store.decisionTraces.get(trace.traceId);
    expect(after).toBeDefined();
    expect(after?.rawPayload).toBeNull();
    expect(after?.versions).toEqual(trace.versions);
  });

  it("is idempotent: a second sweep finds nothing to do", () => {
    const { store, root } = freshStore();
    recorderFor(store, optedInConfig(root, 1), () => "2025-01-01T00:00:00.000Z").record(DRAFT);
    const deps = {
      traces: store.decisionTraces,
      artifacts: store.artifacts,
      now: () => "2025-03-01T00:00:00.000Z",
    };
    expect(purgeExpiredRawPayloads(deps).rawPayloadsPurged).toHaveLength(1);
    expect(purgeExpiredRawPayloads(deps).rawPayloadsPurged).toHaveLength(0);
  });

  it("purgeRawPayloadsNow deletes unexpired payloads too (the deletion control)", () => {
    const { store, root } = freshStore();
    const trace = recorderFor(store, optedInConfig(root, 365), () => "2025-01-01T00:00:00.000Z").record(DRAFT);
    const path = join(root, "artifacts", trace.rawPayload?.relativePath ?? "");
    const report = purgeRawPayloadsNow({
      traces: store.decisionTraces,
      artifacts: store.artifacts,
      now: () => "2025-01-02T00:00:00.000Z",
    });
    expect(report.rawPayloadsPurged).toHaveLength(1);
    expect(existsSync(path)).toBe(false);
    expect(rawFilesIn(root)).toEqual([]);
  });

  it("clears the pointer even when the file was already gone", () => {
    const { store } = freshStore();
    store.decisionTraces.insert(
      makeTrace({
        traceId: "tr-orphan",
        decisionId: null,
        rawPayload: {
          relativePath: `${RAW_LOG_ATTEMPT_DIR}/tr-orphan.json`,
          contentHash: "d".repeat(64),
          sizeBytes: 10,
          expiresAt: "2025-01-01T00:00:00.000Z",
        },
      }),
    );
    const report = purgeExpiredRawPayloads({
      traces: store.decisionTraces,
      artifacts: store.artifacts,
      now: () => "2025-06-01T00:00:00.000Z",
    });
    expect(report.alreadyMissing).toHaveLength(1);
    expect(store.decisionTraces.get("tr-orphan")?.rawPayload).toBeNull();
  });
});

describe("raw payloads are redacted before write (redactBeforeWrite is fixed true)", () => {
  it("redacts a registered secret in the request", () => {
    const { store, root } = freshStore();
    registerSecretValue("supersecretvalue");
    const trace = recorderFor(store, optedInConfig(root), () => "2025-01-01T00:00:00.000Z").record({
      ...DRAFT,
      raw: { request: { state: { key: "supersecretvalue" } }, response: {} },
    });
    const body = readFileSync(join(root, "artifacts", trace.rawPayload?.relativePath ?? ""), "utf8");
    expect(body).not.toContain("supersecretvalue");
    expect(body).toContain("[redacted]");
  });

  it("recognises a surviving credential shape as a refusal", () => {
    // A synthetic AWS-style key id, never a real one.
    expect(wouldRefusePayload("AKIA" + "0123456789ABCDEF")).toBe(true); // check-secrets:allow
    expect(wouldRefusePayload('{"state":{"goal":"ship it"}}')).toBe(false);
  });

  it("prepareRawPayload refuses when the redactor is a no-op", () => {
    const body = { key: "AKIA" + "0123456789ABCDEF" }; // check-secrets:allow
    expect(prepareRawPayload(body, (t) => t).ok).toBe(false);
    expect(prepareRawPayload({ goal: "ship it" }, (t) => t)).toEqual({
      ok: true,
      text: JSON.stringify({ goal: "ship it" }, null, 2),
    });
  });

  it("refuses the write outright if redaction ever regressed", () => {
    const { store, root } = freshStore();
    const sink = new ArtifactRawPayloadSink({
      artifacts: store.artifacts,
      config: optedInConfig(root),
      policy: brokenPolicy(),
    });
    expect(() =>
      sink.write({
        traceId: "tr-x",
        request: { state: { goal: "ship it" } },
        response: {},
        writtenAt: "2025-01-01T00:00:00.000Z",
      }),
    ).toThrow(RawPayloadRefusedError);
    expect(rawFilesIn(root)).toEqual([]);
  });

  it("reports a refusal instead of throwing when a handler is given", () => {
    const { store, root } = freshStore();
    const seen: RawPayloadRefusedError[] = [];
    const sink = new ArtifactRawPayloadSink({
      artifacts: store.artifacts,
      config: optedInConfig(root),
      policy: brokenPolicy(),
      onRefused: (e) => seen.push(e),
    });
    const ref = sink.write({
      traceId: "tr-y",
      request: { state: { goal: "ship it" } },
      response: {},
      writtenAt: "2025-01-01T00:00:00.000Z",
    });
    expect(ref).toBeNull();
    expect(seen).toHaveLength(1);
    expect(rawFilesIn(root)).toEqual([]);
  });
});

describe("trace retention and reporting", () => {
  it("runRetentionSweep deletes traces older than storage.artifactRetentionDays", () => {
    const { store, root } = freshStore();
    const config = optedInConfig(root, 1);
    recorderFor(store, config, () => "2025-01-01T00:00:00.000Z").record(DRAFT);
    expect(store.decisionTraces.count()).toBe(1);
    const report = runRetentionSweep({
      traces: store.decisionTraces,
      artifacts: store.artifacts,
      config,
      now: () => "2025-06-01T00:00:00.000Z",
    });
    expect(report.tracesDeleted).toBe(1);
    expect(store.decisionTraces.count()).toBe(0);
    expect(rawFilesIn(root)).toEqual([]);
  });

  it("keeps a trace that is still inside the trace retention window", () => {
    const { store, root } = freshStore();
    const config = optedInConfig(root, 1);
    recorderFor(store, config, () => "2025-01-01T00:00:00.000Z").record(DRAFT);
    const report = runRetentionSweep({
      traces: store.decisionTraces,
      artifacts: store.artifacts,
      config,
      now: () => "2025-01-03T00:00:00.000Z",
    });
    expect(report.tracesDeleted).toBe(0);
    expect(store.decisionTraces.count()).toBe(1);
  });

  it("never deletes the Decision row a trace pointed at", () => {
    const { store, root } = freshStore();
    const config = optedInConfig(root, 1);
    store.workflows.insert(makeWorkflow());
    const decision = store.decisions.insert(makeDecision({ subject: null }));
    const rec = recorderFor(store, config, () => "2025-01-01T00:00:00.000Z");
    rec.record({ ...DRAFT, decisionId: decision.id });
    runRetentionSweep({
      traces: store.decisionTraces,
      artifacts: store.artifacts,
      config,
      now: () => "2025-06-01T00:00:00.000Z",
    });
    expect(store.decisionTraces.count()).toBe(0);
    expect(store.decisions.get(decision.id)).toBeDefined();
  });

  it("summarises a sweep in one line", () => {
    expect(
      retentionSummary({ at: "t", rawPayloadsPurged: [], bytesReclaimed: 0, tracesDeleted: 0, alreadyMissing: [] }),
    ).toMatch(/Nothing to purge/);
    expect(
      retentionSummary({ at: "t", rawPayloadsPurged: ["a"], bytesReclaimed: 5, tracesDeleted: 2, alreadyMissing: [] }),
    ).toMatch(/1 raw payload file\(s\) deleted \(5 bytes\); 2 trace row\(s\) deleted/);
  });

  it("expiryOf adds whole days and accepts a negative span for cutoffs", () => {
    expect(expiryOf("2025-01-01T00:00:00.000Z", 7)).toBe("2025-01-08T00:00:00.000Z");
    expect(expiryOf("2025-01-08T00:00:00.000Z", -7)).toBe("2025-01-01T00:00:00.000Z");
  });
});
