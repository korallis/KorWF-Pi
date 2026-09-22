/**
 * Issue #71 — progress capture comes from the ADR 0004 RPC event stream, and
 * usage that the registry does not price stays `unknown`, never 0.
 *
 * Deliberately no process here: these are the pure classification rules, and
 * a test that needed a subprocess to check them would be slower and prove
 * less. The process-level assertions live in `lifecycle.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { ProgressTimeline, usageFromRpc, usagePayloadOf } from "../../src/workers/progress.ts";

const at = (): string => "2026-03-03T00:00:00.000Z";

describe("AC: progress events come from tool_execution_* and bash_execution_update (ADR 0004)", () => {
  it("classifies tool_execution_start/end into the timeline with the tool name", () => {
    const timeline = new ProgressTimeline({ now: at });
    timeline.observe({ type: "tool_execution_start", data: { toolName: "bash" } });
    timeline.observe({ type: "tool_execution_end", data: { toolName: "bash" } });
    const snap = timeline.snapshot();
    expect(snap.toolsStarted).toBe(1);
    expect(snap.toolsFinished).toBe(1);
    expect(snap.activeTools).toEqual([]);
    expect(snap.events.map((e) => e.kind)).toEqual(["tool_started", "tool_finished"]);
    expect(snap.events[0]?.tool).toBe("bash");
    expect(snap.events[0]?.source).toBe("tool_execution_start");
  });

  it("reports an outstanding tool call as active until its end event arrives", () => {
    const timeline = new ProgressTimeline({ now: at });
    timeline.observe({ type: "tool_execution_start", data: { toolName: "edit" } });
    expect(timeline.snapshot().activeTools).toEqual(["edit"]);
    timeline.observe({ type: "tool_execution_end", data: { toolName: "edit" } });
    expect(timeline.snapshot().activeTools).toEqual([]);
  });

  it("counts bash_execution_update as progress without copying its output", () => {
    const timeline = new ProgressTimeline({ now: at });
    timeline.observe({ type: "bash_execution_update", data: { output: "secret-looking payload" } });
    const snap = timeline.snapshot();
    expect(snap.bashUpdates).toBe(1);
    expect(snap.events[0]?.detail).toBe("bash output");
    expect(JSON.stringify(snap.events)).not.toContain("secret-looking payload");
  });

  it("ignores correlated command responses: they are the handle's business, not the board's", () => {
    const timeline = new ProgressTimeline({ now: at });
    expect(timeline.observe({ type: "response", id: "x", success: true })).toBeNull();
    expect(timeline.snapshot().events).toEqual([]);
  });

  it("bounds the timeline and says how many events it dropped", () => {
    const timeline = new ProgressTimeline({ now: at, maxEvents: 3 });
    for (let i = 0; i < 10; i += 1) timeline.observe({ type: "bash_execution_update" });
    const snap = timeline.snapshot();
    expect(snap.events).toHaveLength(3);
    expect(snap.dropped).toBe(7);
    expect(snap.bashUpdates).toBe(10);
  });
});

describe("AC: usage is captured from message_update.usage and get_session_stats", () => {
  it("reads a message_update usage payload", () => {
    const usage = usageFromRpc({ inputTokens: 100, outputTokens: 20, costUsd: 0.5 });
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(20);
    expect(usage.spendUsd).toBe(0.5);
    expect(usage.costBasis).toBe("known");
  });

  it("accepts snake_case token fields, which Pi also emits", () => {
    const usage = usageFromRpc({ input_tokens: 7, output_tokens: 11 });
    expect(usage.inputTokens).toBe(7);
    expect(usage.outputTokens).toBe(11);
  });

  it("finds the usage object whether it sits on data.usage or the message root", () => {
    expect(usagePayloadOf({ type: "message_update", data: { usage: { inputTokens: 1 } } })).toEqual({ inputTokens: 1 });
    expect(usagePayloadOf({ type: "message_update", usage: { inputTokens: 2 } })).toEqual({ inputTokens: 2 });
    expect(usagePayloadOf({ type: "message_update" })).toBeUndefined();
  });
});

describe("AC (#56 rule): cost the registry does not state is unknown, never 0", () => {
  it("treats costUsd: 0 with no price metadata as unknown, not free", () => {
    const usage = usageFromRpc({ inputTokens: 500, outputTokens: 500, costUsd: 0 });
    expect(usage.spendUsd).toBeNull();
    expect(usage.costBasis).toBe("unknown");
    expect(usage.inputTokens).toBe(500);
  });

  it("treats an absent cost field with no price metadata as unknown", () => {
    const usage = usageFromRpc({ inputTokens: 10, outputTokens: 10 });
    expect(usage.spendUsd).toBeNull();
    expect(usage.costBasis).toBe("unknown");
  });

  it("prices tokens when the catalog does state a price", () => {
    const usage = usageFromRpc(
      { inputTokens: 1_000, outputTokens: 1_000 },
      { inputPerToken: 0.000_001, outputPerToken: 0.000_002 },
    );
    expect(usage.spendUsd).toBeCloseTo(0.003, 10);
    expect(usage.costBasis).toBe("known");
  });

  it("returns unknown usage for a malformed payload rather than inventing zeroes", () => {
    const usage = usageFromRpc("not an object");
    expect(usage.spendUsd).toBeNull();
    expect(usage.costBasis).toBe("unknown");
    expect(usage.requests).toBe(1);
  });
});
