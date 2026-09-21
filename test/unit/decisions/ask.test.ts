/**
 * `ask` / `askAll` / `askStaged` (issue #27).
 *
 * AC: "Every `ask` writes a Decision record even in disabled mode
 * (rule = 'fallback')."
 * AC: "`askAll` with the mock transport issues calls concurrently up to the
 * cap."
 *
 * The mock transport (#24) is the only transport used here; no network, no
 * key, no live call.
 */
import { describe, it, expect } from "vitest";
import { DisabledJevTransport } from "../../../src/jev/disabled.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import { JevTransportError, type JevEvaluateResult, type SystemOneRequest } from "../../../src/jev/transport.ts";
import { ask, askAll, askStaged, type AskContext, type AskItem } from "../../../src/decisions/ask.ts";
import { DecisionRecorder, MemoryDecisionSink } from "../../../src/decisions/record.ts";
import { classifyQuestion, echoQuestion, lengthQuestion } from "../../../src/decisions/examples.ts";
import type { WorkflowId } from "../../../src/storage/records.ts";

const MODEL = "jev-test";

function recorderWith(sink: MemoryDecisionSink): DecisionRecorder {
  let n = 0;
  return new DecisionRecorder({
    sink,
    workflowId: "wf-1" as WorkflowId,
    revision: "a".repeat(40),
    subject: null,
    now: () => "2026-01-01T00:00:00.000Z",
    newId: () => `dc-${(n += 1)}`,
  });
}

/** Answer every requested question with the given per-type payloads. */
function respondAll(build: (key: string, request: SystemOneRequest) => unknown): (r: SystemOneRequest) => JevEvaluateResult {
  return (request) => ({
    kind: "ok",
    response: {
      model: MODEL,
      answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, build(key, request)])),
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    requestId: "req-1",
    attempts: 1,
    elapsedMs: 1,
  });
}

const noulTrue = { type: "noul", noul: 0.9 };

describe("AC: every ask writes a Decision record even in disabled mode", () => {
  it("records with policyRule exactly 'fallback' and no Jev model version", async () => {
    const sink = new MemoryDecisionSink();
    const ctx: AskContext = {
      transport: new DisabledJevTransport("Jev is disabled: no key configured."),
      recorder: recorderWith(sink),
      model: MODEL,
    };
    const result = await ask(ctx, echoQuestion, { text: "hello" });

    expect(result.source).toBe("fallback");
    expect(result.reason).toBe("disabled");
    expect(result.value).toBe(true);
    expect(sink.rows).toHaveLength(1);
    const row = sink.rows[0]!;
    expect(row.policyRule).toBe("fallback");
    expect(row.questionId).toBe("example.echo");
    expect(row.questionVersion).toBe("1");
    expect(row.jevModelVersion).toBeNull();
    expect(row.rawDistribution).toEqual({});
    expect(row.confidence).toBeNull();
    expect(row.action).toBe("present");
    expect(row.usage.requests).toBe(0);
  });

  it("records one row per question in a disabled batch", async () => {
    const sink = new MemoryDecisionSink();
    const ctx: AskContext = {
      transport: new DisabledJevTransport("disabled"),
      recorder: recorderWith(sink),
      model: MODEL,
    };
    const items = [
      { question: echoQuestion, input: { text: "a?" } },
      { question: classifyQuestion, input: { text: "a?" } },
      { question: lengthQuestion, input: { text: "a?" } },
    ] as unknown as AskItem<unknown, unknown>[];
    const results = await askAll(ctx, items);

    expect(results.map((r) => r.source)).toEqual(["fallback", "fallback", "fallback"]);
    expect(sink.rows.map((r) => r.questionId)).toEqual(["example.echo", "example.classify", "example.length"]);
    expect(new Set(sink.rows.map((r) => r.policyRule))).toEqual(new Set(["fallback", "fallback:word_count"]));
  });

  it("records a row when Jev answers, preserving the raw distribution", async () => {
    const sink = new MemoryDecisionSink();
    const ctx: AskContext = {
      transport: new MockJevTransport({ responder: respondAll(() => noulTrue) }),
      recorder: recorderWith(sink),
      model: MODEL,
      nowMs: (() => {
        let t = 0;
        return () => (t += 7);
      })(),
    };
    const result = await ask(ctx, echoQuestion, { text: "" });

    expect(result.source).toBe("jev");
    expect(result.value).toBe(true); // Jev overrides the deterministic fallback
    expect(result.distribution).toEqual({ true: 0.9, false: expect.closeTo(0.1, 10) });
    const row = sink.rows[0]!;
    expect(row.rawDistribution).toEqual(result.distribution);
    expect(row.jevModelVersion).toBe(MODEL);
    expect(row.policyRule).toBe("echo:present");
    expect(row.latencyMs).toBe(7);
    expect(row.usage.costBasis).toBe("unknown");
  });

  it("records a fallback row for a transport error", async () => {
    const sink = new MemoryDecisionSink();
    const ctx: AskContext = {
      transport: new MockJevTransport({
        responses: [
          { kind: "error", error: new JevTransportError("jev.unavailable", "boom"), attempts: 3, elapsedMs: 5 },
        ],
      }),
      recorder: recorderWith(sink),
      model: MODEL,
    };
    const result = await ask(ctx, echoQuestion, { text: "hi" });
    expect(result.source).toBe("fallback");
    expect(result.reason).toBe("transport_error");
    expect(sink.rows[0]!.policyRule).toBe("fallback");
  });

  it("records a fallback row for a cancelled call", async () => {
    const sink = new MemoryDecisionSink();
    const ctx: AskContext = {
      transport: new MockJevTransport({
        responses: [
          { kind: "error", error: new JevTransportError("jev.cancelled", "cancelled"), attempts: 1, elapsedMs: 1 },
        ],
      }),
      recorder: recorderWith(sink),
      model: MODEL,
    };
    expect((await ask(ctx, echoQuestion, { text: "hi" })).reason).toBe("cancelled");
    expect(sink.rows).toHaveLength(1);
  });

  it("records a fallback row for a malformed answer", async () => {
    const sink = new MemoryDecisionSink();
    const ctx: AskContext = {
      transport: new MockJevTransport({ responder: respondAll(() => ({ type: "noul", noul: 42 })) }),
      recorder: recorderWith(sink),
      model: MODEL,
    };
    const result = await ask(ctx, echoQuestion, { text: "" });
    expect(result.reason).toBe("invalid_response");
    expect(result.value).toBe(false);
    expect(sink.rows[0]!.policyRule).toBe("fallback");
  });

  it("records a fallback row for an abstention, keeping the raw distribution", async () => {
    const sink = new MemoryDecisionSink();
    const ctx: AskContext = {
      transport: new MockJevTransport({ responder: respondAll(() => ({ type: "noul", noul: 0.5 })) }),
      recorder: recorderWith(sink),
      model: MODEL,
    };
    const result = await ask(ctx, echoQuestion, { text: "hi" });
    expect(result.reason).toBe("abstained");
    expect(result.source).toBe("fallback");
    expect(sink.rows[0]!.rawDistribution).toEqual({ true: 0.5, false: 0.5 });
    expect(sink.rows[0]!.jevModelVersion).toBeNull();
  });
});

/** A transport that blocks until released, so overlap is observable. */
function gatedTransport(): {
  transport: MockJevTransport;
  inFlight: () => number;
  peak: () => number;
  releaseAll: () => void;
} {
  let current = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  const transport = new MockJevTransport({
    responder: async (request) => {
      current += 1;
      peak = Math.max(peak, current);
      await new Promise<void>((resolve) => releases.push(resolve));
      current -= 1;
      return respondAll(() => noulTrue)(request);
    },
  });
  return {
    transport,
    inFlight: () => current,
    peak: () => peak,
    releaseAll: () => {
      while (releases.length > 0) releases.shift()?.();
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("AC: askAll issues calls concurrently up to the cap", () => {
  it("runs exactly `concurrency` requests in flight, no more", async () => {
    const gate = gatedTransport();
    const sink = new MemoryDecisionSink();
    const ctx: AskContext = { transport: gate.transport, recorder: recorderWith(sink), model: MODEL };
    const items = Array.from({ length: 9 }, (_, i) => ({
      question: echoQuestion,
      input: { text: `state-${i}` },
    })) as unknown as AskItem<unknown, unknown>[];

    const pending = askAll(ctx, items, { concurrency: 3 });
    await tick();
    expect(gate.inFlight()).toBe(3);
    expect(gate.transport.calls).toHaveLength(3);

    gate.releaseAll();
    await tick();
    expect(gate.transport.calls.length).toBeGreaterThan(3);

    // Drain the rest.
    for (let i = 0; i < 10 && gate.transport.calls.length < 9; i += 1) {
      gate.releaseAll();
      await tick();
    }
    gate.releaseAll();
    const results = await pending;

    expect(results).toHaveLength(9);
    expect(gate.transport.calls).toHaveLength(9);
    expect(gate.peak()).toBe(3);
    expect(sink.rows).toHaveLength(9);
  });

  it("defaults the cap and never exceeds the number of groups", async () => {
    const gate = gatedTransport();
    const ctx: AskContext = { transport: gate.transport, model: MODEL };
    const items = Array.from({ length: 2 }, (_, i) => ({
      question: echoQuestion,
      input: { text: `s${i}` },
    })) as unknown as AskItem<unknown, unknown>[];
    const pending = askAll(ctx, items);
    await tick();
    expect(gate.inFlight()).toBe(2);
    gate.releaseAll();
    await pending;
    expect(gate.peak()).toBe(2);
  });

  it("questions sharing one state are one request, not several", async () => {
    const transport = new MockJevTransport({ responder: respondAll((key) => (key.includes("example.echo") ? noulTrue : { type: "noul", noul: 0.1 })) });
    const ctx: AskContext = { transport, model: MODEL };
    const items = [
      { question: echoQuestion, input: { text: "same" } },
      { question: echoQuestion, input: { text: "same" } },
    ] as unknown as AskItem<unknown, unknown>[];
    const results = await askAll(ctx, items);

    expect(transport.calls).toHaveLength(1);
    expect(Object.keys(transport.calls[0]!.request.questions)).toHaveLength(2);
    expect(results.every((r) => r.source === "jev")).toBe(true);
  });

  it("results keep the order of the items, not of completion", async () => {
    const order: string[] = [];
    let resolveB!: () => void;
    const bCompleted = new Promise<void>((resolve) => { resolveB = resolve; });
    const transport = new MockJevTransport({
      responder: async (request) => {
        const text = (request.state as { text: string }).text;
        // "b" must complete strictly before "a" for this test to mean anything.
        // A 0ms-vs-5ms timer race does not guarantee that on a loaded CI runner —
        // it failed there with ['a','b'] while passing locally. Gate "a" on a
        // promise that only "b" resolves, so the completion order is deterministic.
        if (text === "b") {
          order.push(text);
          resolveB();
          return respondAll(() => noulTrue)(request);
        }
        await bCompleted;
        order.push(text);
        return respondAll(() => noulTrue)(request);
      },
    });
    const ctx: AskContext = { transport, model: MODEL };
    const items = [
      { question: classifyQuestion, input: { text: "a" } },
      { question: classifyQuestion, input: { text: "b" } },
    ] as unknown as AskItem<unknown, unknown>[];
    const results = await askAll(ctx, items, { concurrency: 2 });

    expect(order).toEqual(["b", "a"]);
    expect(results.map((r) => r.stateHash)).toHaveLength(2);
    expect(results[0]!.key).toBe("example.classify@1");
  });
});

describe("PLAN §6: staging dependent questions", () => {
  it("a later stage sees the earlier stage's answers", async () => {
    const transport = new MockJevTransport({ responder: respondAll(() => noulTrue) });
    const sink = new MemoryDecisionSink();
    const ctx: AskContext = { transport, recorder: recorderWith(sink), model: MODEL };

    const run = await askStaged<{ text: string; present: boolean | null; kind: string | null }>(
      ctx,
      { text: "is it?", present: null, kind: null },
      [
        {
          name: "presence",
          items: (carry) => [{ question: echoQuestion, input: { text: carry.text } }] as unknown as AskItem<unknown, unknown>[],
          reduce: (carry, results) => ({ ...carry, present: results[0]!.value as boolean }),
        },
        {
          name: "kind",
          // Only asked because the first stage said there is text at all.
          items: (carry) => [{ question: classifyQuestion, input: { text: carry.text } }] as unknown as AskItem<unknown, unknown>[],
          reduce: (carry, results) => ({ ...carry, kind: String(results[0]!.action) }),
          stopWhen: (carry) => carry.present !== true,
        },
      ],
    );

    expect(run.stoppedAt).toBeNull();
    expect(run.stages.map((s) => s.name)).toEqual(["presence", "kind"]);
    expect(run.carry.present).toBe(true);
    expect(transport.calls).toHaveLength(2);
    expect(sink.rows).toHaveLength(2);
  });

  it("a stage whose stopWhen fires halts the chain and asks nothing further", async () => {
    const transport = new MockJevTransport({ responder: respondAll(() => ({ type: "noul", noul: 0.05 })) });
    const sink = new MemoryDecisionSink();
    const ctx: AskContext = { transport, recorder: recorderWith(sink), model: MODEL };

    const run = await askStaged<{ present: boolean | null }>(ctx, { present: null }, [
      {
        name: "presence",
        items: () => [{ question: echoQuestion, input: { text: "" } }] as unknown as AskItem<unknown, unknown>[],
        reduce: (carry, results) => ({ ...carry, present: results[0]!.value as boolean }),
      },
      {
        name: "kind",
        items: () => [{ question: classifyQuestion, input: { text: "" } }] as unknown as AskItem<unknown, unknown>[],
        reduce: (carry) => carry,
        stopWhen: (carry) => carry.present !== true,
      },
    ]);

    expect(run.stoppedAt).toBe("kind");
    expect(run.stages.map((s) => s.name)).toEqual(["presence"]);
    expect(transport.calls).toHaveLength(1);
    expect(sink.rows).toHaveLength(1);
  });

  it("staging still works with no Jev at all", async () => {
    const sink = new MemoryDecisionSink();
    const ctx: AskContext = { transport: new DisabledJevTransport("no key"), recorder: recorderWith(sink), model: MODEL };
    const run = await askStaged<{ present: boolean | null }>(ctx, { present: null }, [
      {
        name: "presence",
        items: () => [{ question: echoQuestion, input: { text: "hello" } }] as unknown as AskItem<unknown, unknown>[],
        reduce: (carry, results) => ({ ...carry, present: results[0]!.value as boolean }),
      },
    ]);
    expect(run.carry.present).toBe(true);
    expect(sink.rows[0]!.policyRule).toBe("fallback");
  });
});

describe("PLAN §6: cache only with complete versioned keys", () => {
  it("a recorded decision with the same state hash is replayed, not re-asked", async () => {
    const transport = new MockJevTransport({ responder: respondAll(() => noulTrue) });
    const sink = new MemoryDecisionSink();
    const ctx: AskContext = { transport, recorder: recorderWith(sink), model: MODEL };

    const first = await ask(ctx, echoQuestion, { text: "hello" }, { reuse: true });
    const second = await ask(ctx, echoQuestion, { text: "hello" }, { reuse: true });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.value).toBe(first.value);
    expect(second.decisionId).toBe(first.decisionId);
    expect(transport.calls).toHaveLength(1);
    expect(sink.rows).toHaveLength(1);
  });

  it("a different state, question version, or model is a different key", async () => {
    const transport = new MockJevTransport({ responder: respondAll(() => noulTrue) });
    const sink = new MemoryDecisionSink();
    const ctx: AskContext = { transport, recorder: recorderWith(sink), model: MODEL };

    await ask(ctx, echoQuestion, { text: "hello" }, { reuse: true });
    const other = await ask(ctx, echoQuestion, { text: "goodbye" }, { reuse: true });
    const otherModel = await ask({ ...ctx, model: "jev-other" }, echoQuestion, { text: "hello" }, { reuse: true });

    expect(other.reused).toBe(false);
    expect(otherModel.reused).toBe(false);
    expect(transport.calls).toHaveLength(3);
  });

  it("reuse is off by default", async () => {
    const transport = new MockJevTransport({ responder: respondAll(() => noulTrue) });
    const ctx: AskContext = { transport, recorder: recorderWith(new MemoryDecisionSink()), model: MODEL };
    await ask(ctx, echoQuestion, { text: "hello" });
    await ask(ctx, echoQuestion, { text: "hello" });
    expect(transport.calls).toHaveLength(2);
  });
});
