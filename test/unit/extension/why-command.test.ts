/**
 * `/korwf why` and `/korwf purge` (issue #31).
 *
 * `why` must reconstruct a decision from recorded rows and say "not
 * recorded" for anything absent (PLAN §3.I); `purge` is the deletion
 * control PLAN §7 requires beside opt-in raw payload logging.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { loadConfig } from "../../../src/config/load.ts";
import type { KorwfConfig } from "../../../src/config/types.ts";
import { purgeMessage, rawLoggingStatusLine, whyMessage } from "../../../src/extension/commands/why.ts";
import { RAW_LOG_ATTEMPT_DIR, createRawPayloadSink } from "../../../src/telemetry/retention.ts";
import { TraceRecorder } from "../../../src/telemetry/trace.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makeDecision, makeWorkflow } from "../../helpers/records.ts";
import { makeTrace } from "../../helpers/trace.ts";

const open: { dir: TempDir; store: Store }[] = [];

function freshStore(): { store: Store; root: string } {
  const dir = makeTempDir("korwf-why-");
  const { store } = openStore({ storageRoot: dir.path });
  open.push({ dir, store });
  return { store, root: dir.path };
}

function configFor(root: string, rawLogging: boolean, retentionDays = 7): KorwfConfig {
  const result = loadConfig(root, { env: {} });
  if (!result.ok) throw new Error(result.message);
  if (!rawLogging) return result.config;
  return {
    ...result.config,
    privacy: {
      ...result.config.privacy,
      rawLogging: { enabled: true, retentionDays, redactBeforeWrite: true },
    },
  };
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

describe("/korwf why", () => {
  it("explains a decision from its recorded row and trace", () => {
    const { store } = freshStore();
    store.workflows.insert(makeWorkflow());
    const decision = store.decisions.insert(makeDecision({ subject: null, action: "proceed" }));
    store.decisionTraces.insert(makeTrace({ decisionId: decision.id }));
    const text = whyMessage(store, decision.id);
    expect(text).toContain(`Decision ${decision.id}`);
    expect(text).toContain("proceed");
    expect(text).toContain("[decision.policyRule]");
    expect(text).toContain("[trace.versions]");
  });

  it("accepts a trace id as well as a decision id", () => {
    const { store } = freshStore();
    store.decisionTraces.insert(makeTrace({ traceId: "tr-z", decisionId: null }));
    expect(whyMessage(store, "tr-z")).toContain("no Decision row");
  });

  it("names the gap when only the Decision row exists", () => {
    const { store } = freshStore();
    store.workflows.insert(makeWorkflow());
    const decision = store.decisions.insert(makeDecision({ subject: null }));
    expect(whyMessage(store, decision.id)).toContain("Not recorded:");
  });

  it("says nothing is known for an unknown id, rather than guessing", () => {
    const { store } = freshStore();
    expect(whyMessage(store, "dc-missing")).toMatch(/nothing is known about it/);
  });

  it("prints usage when given no id", () => {
    const { store } = freshStore();
    expect(whyMessage(store, "  ")).toMatch(/^Usage:/);
  });
});

describe("/korwf purge", () => {
  const DRAFT = {
    decisionId: null,
    question: makeTrace().question,
    outcome: "jev" as const,
    detail: makeTrace().detail,
    request: makeTrace().request,
    latencyMs: 1,
    jevModelVersion: "jev-1",
    raw: { request: { state: { goal: "ship" } }, response: {} },
  };

  function writeOne(store: Store, config: KorwfConfig, at: string): string | null {
    const rec = new TraceRecorder({
      sink: store.decisionTraces,
      workflowId: "wf-1",
      versions: { package: "0.1.0", schema: "1", policy: "1", questionSet: "q" },
      rawPayloads: createRawPayloadSink({ artifacts: store.artifacts, config }),
      now: () => at,
      newId: () => `tr-${at}`,
    });
    return rec.record(DRAFT).rawPayload?.relativePath ?? null;
  }

  it("says raw logging is off and purges nothing under the defaults", () => {
    const { store, root } = freshStore();
    const config = configFor(root, false);
    writeOne(store, config, "2025-01-01T00:00:00.000Z");
    const text = purgeMessage(store, config, { now: () => "2025-02-01T00:00:00.000Z" });
    expect(text).toContain("privacy.rawLogging.enabled is off");
    expect(text).toMatch(/Nothing to purge/);
  });

  it("expires due payloads when raw logging is on", () => {
    const { store, root } = freshStore();
    const config = configFor(root, true, 1);
    const path = writeOne(store, config, "2025-01-01T00:00:00.000Z");
    expect(existsSync(join(root, "artifacts", path ?? ""))).toBe(true);
    const text = purgeMessage(store, config, { now: () => "2025-01-05T00:00:00.000Z" });
    expect(text).toMatch(/1 raw payload file\(s\) deleted/);
    expect(existsSync(join(root, "artifacts", path ?? ""))).toBe(false);
  });

  it("--all deletes payloads that have not expired yet", () => {
    const { store, root } = freshStore();
    const config = configFor(root, true, 365);
    const path = writeOne(store, config, "2025-01-01T00:00:00.000Z");
    const text = purgeMessage(store, config, { all: true, now: () => "2025-01-02T00:00:00.000Z" });
    expect(text).toMatch(/1 raw payload file\(s\) deleted/);
    expect(existsSync(join(root, "artifacts", path ?? ""))).toBe(false);
  });

  it("points at --all when payloads survive an earlier opt-in period", () => {
    const { store, root } = freshStore();
    // Written while opted in with a long retention, then the user opted out.
    writeOne(store, configFor(root, true, 365), "2025-01-01T00:00:00.000Z");
    const text = purgeMessage(store, configFor(root, false), { now: () => "2025-01-02T00:00:00.000Z" });
    expect(text).toContain("`/korwf purge --all`");
    expect(existsSync(join(root, "artifacts", RAW_LOG_ATTEMPT_DIR))).toBe(true);
  });
});

describe("rawLoggingStatusLine", () => {
  it("reports the shipped default as off", () => {
    const { root } = freshStore();
    expect(rawLoggingStatusLine(configFor(root, false))).toContain("off (default)");
  });

  it("reports the retention window when on", () => {
    const { root } = freshStore();
    expect(rawLoggingStatusLine(configFor(root, true, 3))).toContain("kept 3 day(s)");
  });
});
