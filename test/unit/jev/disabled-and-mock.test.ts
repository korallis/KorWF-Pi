/**
 * Disabled and mock transports (issue #24).
 *
 * AC2: "Disabled transport returns within 1 ms and records nothing sensitive."
 */
import { describe, it, expect } from "vitest";
import { DisabledJevTransport, MockJevTransport } from "../../../src/jev/index.ts";
import type { SystemOneRequest } from "../../../src/jev/index.ts";

const REQUEST: SystemOneRequest = {
  state: "hello",
  model: "jev-1.13.0",
  questions: { q: { type: "noul", instructions: "Is this a test?" } },
};

describe("DisabledJevTransport", () => {
  it("AC2: evaluate resolves within 1ms with kind: disabled", async () => {
    const t = new DisabledJevTransport("Jev is off for this test.");
    const start = performance.now();
    const result = await t.evaluate(REQUEST);
    const elapsed = performance.now() - start;
    expect(result.kind).toBe("disabled");
    expect(elapsed).toBeLessThan(1);
  });

  it("AC2: ping resolves within 1ms with kind: disabled", async () => {
    const t = new DisabledJevTransport();
    const start = performance.now();
    const result = await t.ping();
    const elapsed = performance.now() - start;
    expect(result.kind).toBe("disabled");
    expect(elapsed).toBeLessThan(1);
  });

  it("AC2: records nothing sensitive — message never contains a credential shape", async () => {
    const t = new DisabledJevTransport("Jev assistance is off: no key configured.");
    const result = await t.evaluate(REQUEST);
    if (result.kind === "disabled") {
      expect(result.message).not.toMatch(/apikey_|sk-|Bearer /i);
    }
  });

  it("kind is 'disabled' as a literal", () => {
    expect(new DisabledJevTransport().kind).toBe("disabled");
  });
});

describe("MockJevTransport", () => {
  it("returns scripted responses in order and records calls", async () => {
    const ok = {
      kind: "ok" as const,
      response: { model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.7 } }, usage: { input_tokens: 5, output_tokens: 0 } },
      requestId: "r1",
      attempts: 1,
      elapsedMs: 1,
    };
    const t = new MockJevTransport({ responses: [ok] });
    const result = await t.evaluate(REQUEST);
    expect(result).toEqual(ok);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.request).toBe(REQUEST);
  });

  it("throws a clear error when the response queue is exhausted", async () => {
    const t = new MockJevTransport();
    await expect(t.evaluate(REQUEST)).rejects.toThrow(/no scripted response/);
  });

  it("supports a computed responder", async () => {
    const t = new MockJevTransport({
      responder: (req) => ({
        kind: "ok",
        response: { model: "jev-1.13.0", answers: {}, usage: { input_tokens: req.questions.q ? 1 : 0, output_tokens: 0 } },
        requestId: "computed",
        attempts: 1,
        elapsedMs: 0,
      }),
    });
    const result = await t.evaluate(REQUEST);
    expect(result.kind).toBe("ok");
  });

  it("ping records separately from evaluate and defaults to ok", async () => {
    const t = new MockJevTransport();
    const result = await t.ping();
    expect(result.kind).toBe("ok");
    expect(t.pingCalls).toHaveLength(1);
    expect(t.calls).toHaveLength(0);
  });

  it("kind is 'mock' as a literal", () => {
    expect(new MockJevTransport().kind).toBe("mock");
  });
});
