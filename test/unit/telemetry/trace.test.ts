/**
 * Decision traces (issue #31).
 *
 * Acceptance criteria exercised here:
 *   AC3 "Every trace has all five version fields populated."
 * plus the PLAN §3.I invariant that an explanation is reconstructed from
 * recorded fields and never fabricated.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  MemoryTraceSink,
  TraceRecorder,
  TraceVersionError,
  assertTraceVersions,
  explainDecision,
  missingTraceVersions,
  requestHashOf,
  summariseRequest,
} from "../../../src/telemetry/trace.ts";
import { REQUIRED_TRACE_VERSIONS } from "../../../src/telemetry/trace-types.ts";
import { clearRegisteredSecrets, registerSecretValue } from "../../../src/security/redact.ts";
import { makeDecision } from "../../helpers/records.ts";
import { makeTrace, makeVersions } from "../../helpers/trace.ts";

afterEach(() => {
  clearRegisteredSecrets();
});

function recorder(overrides: Partial<Parameters<typeof TraceRecorder.prototype.record>[0]> = {}): {
  sink: MemoryTraceSink;
  record: () => ReturnType<TraceRecorder["record"]>;
} {
  const sink = new MemoryTraceSink();
  const rec = new TraceRecorder({
    sink,
    workflowId: "wf-1",
    versions: { package: "0.1.0", schema: "1", policy: "1", questionSet: "q-hash" },
    now: () => "2025-01-01T00:00:00.000Z",
    newId: () => "tr-1",
  });
  const base = makeTrace();
  return {
    sink,
    record: () =>
      rec.record({
        decisionId: "dc-1",
        question: base.question,
        outcome: "jev",
        detail: base.detail,
        request: base.request,
        latencyMs: 42,
        jevModelVersion: "jev-1",
        ...overrides,
      }),
  };
}

describe("AC3: every trace has all five version fields populated", () => {
  it("records package, schema, policy, questionSet and jevModel", () => {
    const { record } = recorder();
    const trace = record();
    expect(trace.versions.package).toBe("0.1.0");
    expect(trace.versions.schema).toBe("1");
    expect(trace.versions.policy).toBe("1");
    expect(trace.versions.questionSet).toBe("q-hash");
    expect(trace.versions.jevModel).toBe("jev-1");
    expect(Object.keys(trace.versions).sort()).toEqual(
      ["jevModel", "package", "policy", "questionSet", "schema"].sort(),
    );
  });

  it.each([...REQUIRED_TRACE_VERSIONS])("rejects a trace missing %s", (field) => {
    const versions = { ...makeVersions(), [field]: "" };
    expect(missingTraceVersions(versions)).toContain(field);
    expect(() => assertTraceVersions(versions)).toThrow(TraceVersionError);
  });

  it("rejects a whitespace-only version, not just an empty one", () => {
    expect(() => assertTraceVersions(makeVersions({ policy: "   " }))).toThrow(/policy/);
  });

  it("fails at construction time, not at the first decision", () => {
    expect(
      () =>
        new TraceRecorder({
          sink: new MemoryTraceSink(),
          workflowId: "wf-1",
          versions: { package: "0.1.0", schema: "1", policy: "", questionSet: "q" },
        }),
    ).toThrow(TraceVersionError);
  });

  it("jevModel null is a recorded fact, not a missing field", () => {
    const { record } = recorder({ jevModelVersion: null, outcome: "fallback" });
    const trace = record();
    expect(trace.versions.jevModel).toBeNull();
    expect(missingTraceVersions(trace.versions)).toEqual([]);
  });

  it("a fallback trace still carries the other four versions", () => {
    const { record } = recorder({ jevModelVersion: null, outcome: "disabled" });
    const trace = record();
    for (const field of REQUIRED_TRACE_VERSIONS) {
      expect(trace.versions[field], field).not.toBe("");
    }
  });
});

describe("a trace never carries an unredacted secret (PLAN §7)", () => {
  it("redacts the policy rule, action and fallback reason", () => {
    registerSecretValue("hunter2hunter2");
    const { record } = recorder({
      detail: {
        ...makeTrace().detail,
        policyRule: "rule using hunter2hunter2",
        action: "proceed with hunter2hunter2",
        fallbackReason: "failed: hunter2hunter2",
      },
    });
    const trace = record();
    const serialised = JSON.stringify(trace);
    expect(serialised).not.toContain("hunter2hunter2");
    expect(trace.detail.policyRule).toContain("[redacted]");
    expect(trace.detail.action).toContain("[redacted]");
    expect(trace.detail.fallbackReason).toContain("[redacted]");
  });

  it("redacts distribution label keys as well as values", () => {
    registerSecretValue("sekretsekret");
    const { record } = recorder({
      detail: { ...makeTrace().detail, distribution: { "label-sekretsekret": 1 } },
    });
    expect(JSON.stringify(record())).not.toContain("sekretsekret");
  });

  it("has no free-text rationale field at all (PLAN §3.I)", () => {
    const trace = makeTrace();
    const keys = new Set(Object.keys(trace).concat(Object.keys(trace.detail)));
    for (const forbidden of ["rationale", "reasoning", "explanation", "summaryText", "why"]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
  });
});

describe("summariseRequest carries counts and paths, never content", () => {
  const report = {
    purpose: "jev.decision" as const,
    removed: [
      { kind: "path" as const, what: ".env", reason: "denied" as const, glob: ".env*", rule: "deny" as const, bytes: 120 },
      { kind: "field" as const, what: "state.blob", reason: "over_budget" as const, glob: null, rule: null, bytes: 40 },
    ],
    truncated: [{ kind: "snippet" as const, what: "src/a.ts", keptBytes: 100, droppedBytes: 900 }],
    redactedStrings: 2,
    sentBytes: 512,
    droppedBytes: 1060,
    snippetsKept: 1,
    snippetsOffered: 2,
    clean: false,
  };

  it("summarises the #28 report without copying removed content", () => {
    const summary = summariseRequest({ report, request: { a: 1 }, state: { goal: "x", revision: "y" } });
    expect(summary.deniedPaths).toEqual([".env"]);
    expect(summary.removedCount).toBe(2);
    expect(summary.truncatedCount).toBe(1);
    expect(summary.redactedStrings).toBe(2);
    expect(summary.sentBytes).toBe(512);
    expect(summary.stateKeys).toEqual(["goal", "revision"]);
    expect(summary.clean).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("blob-content");
  });

  it("hashes the request so a trace correlates with a raw payload", () => {
    const a = summariseRequest({ report, request: { x: 1, y: 2 } });
    const b = summariseRequest({ report, request: { y: 2, x: 1 } });
    expect(a.requestHash).toBe(b.requestHash);
    expect(a.requestHash).toBe(requestHashOf({ x: 1, y: 2 }));
    expect(summariseRequest({ report, request: { x: 2 } }).requestHash).not.toBe(a.requestHash);
  });
});

describe("explainDecision reconstructs from recorded fields only (PLAN §3.I)", () => {
  it("every line names the artefact and field it was read from", () => {
    const explanation = explainDecision(makeDecision(), makeTrace());
    expect(explanation.lines.length).toBeGreaterThan(0);
    for (const line of explanation.lines) {
      expect(["decision", "trace"]).toContain(line.source);
      expect(line.field).not.toBe("");
    }
  });

  it("reports the raw distribution and policy rule that were recorded", () => {
    const explanation = explainDecision(
      makeDecision({ rawDistribution: { yes: 0.9, no: 0.1 }, policyRule: "noul_above_threshold", action: "proceed" }),
      makeTrace(),
    );
    expect(explanation.text).toContain("yes=0.9000");
    expect(explanation.text).toContain("noul_above_threshold");
    expect(explanation.text).toContain("proceed");
  });

  it("states a missing trace as a gap instead of inventing versions", () => {
    const explanation = explainDecision(makeDecision(), null);
    expect(explanation.unknown.join(" ")).toMatch(/versions, latency, retries, breaker state/);
    expect(explanation.text).toContain("Not recorded:");
    expect(explanation.lines.every((l) => l.source === "decision")).toBe(true);
  });

  it("states a missing decision as a gap instead of inventing a distribution", () => {
    const explanation = explainDecision(null, makeTrace({ decisionId: null }));
    expect(explanation.unknown.join(" ")).toMatch(/raw distribution, policy rule, action and override/);
    expect(explanation.decisionId).toBeNull();
  });

  it("says so when nothing at all was recorded", () => {
    const explanation = explainDecision(null, null);
    expect(explanation.lines).toEqual([]);
    expect(explanation.text).toMatch(/nothing is known about it/);
  });

  it("says the deterministic fallback answered, not that a model did", () => {
    const explanation = explainDecision(
      makeDecision({ jevModelVersion: null, policyRule: "fallback" }),
      makeTrace({ outcome: "fallback", versions: makeVersions({ jevModel: null }) }),
    );
    expect(explanation.text).toContain("the deterministic fallback produced this answer");
    expect(explanation.text).toContain("Jev model none (fallback)");
  });

  it("reports an override verbatim from the record", () => {
    const explanation = explainDecision(
      makeDecision({
        override: { actor: "user", action: "halt", reason: "manual stop", at: "2025-01-02T00:00:00.000Z" },
      }),
      makeTrace(),
    );
    expect(explanation.text).toContain("user overrode the action to \"halt\"");
    expect(explanation.text).toContain("manual stop");
  });

  it("says nothing left the machine when no request was recorded", () => {
    const explanation = explainDecision(makeDecision(), makeTrace({ request: null, outcome: "disabled" }));
    expect(explanation.text).toContain("nothing — no request left this machine");
  });

  it("reports the default raw-payload posture as off", () => {
    expect(explainDecision(makeDecision(), makeTrace()).text).toContain(
      "not stored (privacy.rawLogging.enabled is off)",
    );
  });

  it("redacts a secret that reached a recorded field", () => {
    registerSecretValue("leakedleaked12");
    const explanation = explainDecision(makeDecision({ action: "run leakedleaked12" }), makeTrace());
    expect(explanation.text).not.toContain("leakedleaked12");
  });
});
