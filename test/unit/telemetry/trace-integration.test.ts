/**
 * Traces produced by the real `ask()` path, and by the store (issue #31).
 *
 * Acceptance criteria exercised here:
 *   AC3 "Every trace has all five version fields populated" — for traces
 *       produced by `ask()` rather than hand-built.
 * plus the PLAN §3.I requirement that `/korwf why <decision>` reconstructs
 * what happened from recorded inputs alone.
 */
import { describe, it, expect, afterEach } from "vitest";
import { ask, askAll } from "../../../src/decisions/ask.ts";
import { defineNoul } from "../../../src/decisions/question.ts";
import { DecisionRecorder, MemoryDecisionSink } from "../../../src/decisions/record.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import { DisabledJevTransport } from "../../../src/jev/disabled.ts";
import { MemoryTraceSink, TraceRecorder, explainDecision } from "../../../src/telemetry/trace.ts";
import { REQUIRED_TRACE_VERSIONS } from "../../../src/telemetry/trace-types.ts";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { GitSha, WorkflowId } from "../../../src/storage/records.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makeDecision, makeWorkflow } from "../../helpers/records.ts";
import { makeTrace } from "../../helpers/trace.ts";

const SHA = "f".repeat(40) as GitSha;

interface Goal {
  readonly goal: string;
}

const readyQuestion = defineNoul<Goal, boolean>({
  id: "example.trace_ready",
  version: "1",
  prompt: "Is the task ready to start?",
  state: (input) => ({ goal: input.goal }),
  decide: (noul) => ({
    value: noul >= 0.6,
    rule: noul >= 0.6 ? "noul_above_threshold" : "noul_below_threshold",
    action: noul >= 0.6 ? "proceed" : "block",
  }),
  fallback: () => ({ value: false, action: "block" }),
  replay: (action) => (action === "proceed" ? true : action === "block" ? false : null),
  boundaries: [{ name: "any goal", state: { goal: "x" }, expectFallback: false }],
});

function harness(options: { readonly tracer?: TraceRecorder } = {}): {
  sink: MemoryDecisionSink;
  traces: MemoryTraceSink;
  tracer: TraceRecorder;
  recorder: DecisionRecorder;
} {
  const sink = new MemoryDecisionSink();
  const traces = new MemoryTraceSink();
  const tracer =
    options.tracer ??
    new TraceRecorder({
      sink: traces,
      workflowId: "wf-1",
      versions: { package: "0.1.0", schema: "1", policy: "1", questionSet: "q-hash" },
      attemptId: "at-1",
      now: () => "2025-01-01T00:00:00.000Z",
    });
  const recorder = new DecisionRecorder({
    sink,
    workflowId: "wf-1" as WorkflowId,
    revision: SHA,
    subject: null,
  });
  return { sink, traces, tracer, recorder };
}

function okTransport(noul: number): MockJevTransport {
  return new MockJevTransport({
    responder: (request) => ({
      kind: "ok",
      response: {
        model: "jev-test-1",
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [key, { type: "noul", noul }]),
        ),
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      requestId: "mock-1",
      attempts: 1,
      elapsedMs: 5,
    }),
  });
}

describe("AC3: ask() writes a fully versioned trace on every path", () => {
  it("a Jev-answered decision produces one trace with all five versions", async () => {
    const { traces, tracer, recorder } = harness();
    const result = await ask(
      { transport: okTransport(0.9), recorder, tracer, model: "jev-test-1" },
      readyQuestion,
      { goal: "ship" },
    );
    expect(traces.traces).toHaveLength(1);
    const trace = traces.traces[0];
    expect(trace?.versions.jevModel).toBe("jev-test-1");
    for (const field of REQUIRED_TRACE_VERSIONS) expect(trace?.versions[field], field).toBeTruthy();
    expect(trace?.decisionId).toBe(result.decisionId);
    expect(trace?.outcome).toBe("jev");
  });

  it("a disabled transport still produces a fully versioned trace", async () => {
    const { traces, tracer, recorder } = harness();
    await ask(
      { transport: new DisabledJevTransport("no key"), recorder, tracer, model: "jev-test-1" },
      readyQuestion,
      { goal: "ship" },
    );
    const trace = traces.traces[0];
    expect(trace?.outcome).toBe("disabled");
    expect(trace?.versions.jevModel).toBeNull();
    for (const field of REQUIRED_TRACE_VERSIONS) expect(trace?.versions[field], field).toBeTruthy();
  });

  it("records nothing outbound in disabled mode", async () => {
    const { traces, tracer, recorder } = harness();
    await ask(
      { transport: new DisabledJevTransport("no key"), recorder, tracer, model: "jev-test-1" },
      readyQuestion,
      { goal: "ship" },
    );
    expect(traces.traces[0]?.request).toBeNull();
    expect(traces.traces[0]?.latencyMs).toBeNull();
  });

  it("one trace per question in a batched request", async () => {
    const { traces, tracer, recorder } = harness();
    await askAll({ transport: okTransport(0.9), recorder, tracer, model: "jev-test-1" }, [
      { question: readyQuestion, input: { goal: "a" } },
      { question: readyQuestion, input: { goal: "b" } },
    ]);
    expect(traces.traces).toHaveLength(2);
  });

  it("records the sanitised outbound summary, not the payload", async () => {
    const { traces, tracer, recorder } = harness();
    await ask({ transport: okTransport(0.9), recorder, tracer, model: "jev-test-1" }, readyQuestion, {
      goal: "ship the thing",
    });
    const request = traces.traces[0]?.request;
    expect(request).not.toBeNull();
    expect(request?.purpose).toBe("jev.decision");
    expect(request?.sentBytes).toBeGreaterThan(0);
    expect(request?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(traces.traces[0])).not.toContain("ship the thing");
  });

  it("no raw payload is stored without opt-in, even on the happy path", async () => {
    const { traces, tracer, recorder } = harness();
    await ask({ transport: okTransport(0.9), recorder, tracer, model: "jev-test-1" }, readyQuestion, {
      goal: "ship",
    });
    expect(tracer.rawLoggingEnabled).toBe(false);
    expect(traces.traces[0]?.rawPayload).toBeNull();
  });

  it("traces a replayed decision as cached, with nothing sent", async () => {
    const { traces, tracer, recorder } = harness();
    const ctx = { transport: okTransport(0.9), recorder, tracer, model: "jev-test-1" };
    await ask(ctx, readyQuestion, { goal: "ship" }, { reuse: true });
    await ask(ctx, readyQuestion, { goal: "ship" }, { reuse: true });
    expect(traces.traces).toHaveLength(2);
    expect(traces.traces[1]?.outcome).toBe("cached");
    expect(traces.traces[1]?.detail.reused).toBe(true);
    expect(traces.traces[1]?.request).toBeNull();
  });

  it("ask() behaves identically with no tracer attached", async () => {
    const { sink, recorder } = harness();
    const result = await ask(
      { transport: okTransport(0.9), recorder, model: "jev-test-1" },
      readyQuestion,
      { goal: "ship" },
    );
    expect(result.value).toBe(true);
    expect(sink.rows).toHaveLength(1);
  });
});

describe("the trace table is write-once and prunable (#23 store)", () => {
  const open: { dir: TempDir; store: Store }[] = [];

  function freshStore(): Store {
    const dir = makeTempDir("korwf-trace-store-");
    const { store } = openStore({ storageRoot: dir.path });
    open.push({ dir, store });
    return store;
  }

  afterEach(() => {
    while (open.length > 0) {
      const entry = open.pop();
      entry?.store.close();
      entry?.dir.cleanup();
    }
  });

  it("round-trips a trace through SQLite unchanged", () => {
    const store = freshStore();
    const trace = makeTrace({ decisionId: null });
    store.decisionTraces.insert(trace);
    expect(store.decisionTraces.get(trace.traceId)).toEqual(trace);
  });

  it("rejects UPDATE from any connection", () => {
    const store = freshStore();
    store.decisionTraces.insert(makeTrace({ decisionId: null }));
    expect(() => store.connection.exec("UPDATE decision_trace SET outcome = 'error'")).toThrow(/write-once/);
  });

  it("indexes traces by decision and by attempt", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow());
    const decision = store.decisions.insert(makeDecision({ subject: null }));
    store.decisionTraces.insert(makeTrace({ traceId: "tr-a", decisionId: decision.id, attemptId: "at-9" }));
    expect(store.decisionTraces.forDecision(decision.id)).toHaveLength(1);
    expect(store.decisionTraces.forAttempt("at-9")).toHaveLength(1);
  });

  it("deleting a trace leaves the Decision row untouched", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow());
    const decision = store.decisions.insert(makeDecision({ subject: null }));
    store.decisionTraces.insert(makeTrace({ traceId: "tr-b", decisionId: decision.id }));
    store.decisionTraces.delete("tr-b");
    expect(store.decisionTraces.count()).toBe(0);
    expect(store.decisions.get(decision.id)).toBeDefined();
  });
});

describe("/korwf why reconstructs an ask() from the recorded rows", () => {
  it("explains a real decision without inventing anything", async () => {
    const { sink, traces, tracer, recorder } = harness();
    await ask({ transport: okTransport(0.95), recorder, tracer, model: "jev-test-1" }, readyQuestion, {
      goal: "ship",
    });
    const decision = sink.rows[0];
    const trace = traces.traces[0];
    expect(decision).toBeDefined();
    const explanation = explainDecision(decision ?? null, trace ?? null);
    expect(explanation.unknown).toEqual([]);
    expect(explanation.text).toContain("example.trace_ready@1");
    expect(explanation.text).toContain("true=0.9500");
    expect(explanation.text).toContain("noul_above_threshold");
    expect(explanation.text).toContain("proceed");
    expect(explanation.text).toContain("jev-test-1");
  });

  it("explains a fallback as a fallback, with the recorded reason", async () => {
    const { sink, traces, tracer, recorder } = harness();
    await ask(
      { transport: new DisabledJevTransport("no key"), recorder, tracer, model: "jev-test-1" },
      readyQuestion,
      { goal: "ship" },
    );
    const explanation = explainDecision(sink.rows[0] ?? null, traces.traces[0] ?? null);
    expect(explanation.text).toContain("the deterministic fallback produced this answer");
    expect(explanation.text).toContain("Fallback reason: disabled");
    expect(explanation.text).toContain("nothing — no request left this machine");
  });
});
