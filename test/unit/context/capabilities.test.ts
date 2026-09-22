/**
 * AC: "A skill whose description says REQUIRED for a matching trigger is
 * marked required regardless of Jev score (mock test)."
 * AC: "Zero suggestions is a valid outcome."
 */
import { describe, expect, it } from "vitest";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import { DisabledJevTransport } from "../../../src/jev/disabled.ts";
import type { AskContext } from "../../../src/decisions/ask.ts";
import {
  DEFAULT_SUGGEST_THRESHOLD,
  detectMandatoryTrigger,
  rankCapabilities,
  type Capability,
} from "../../../src/context/capabilities.ts";
import type { JevEvaluateResult, SystemOneRequest } from "../../../src/jev/transport.ts";

const SKILLS: readonly Capability[] = [
  {
    name: "pdf-processing",
    kind: "skill",
    description: "Extracts text and tables from PDF files, fills PDF forms. Use when working with PDF documents.",
  },
  {
    name: "diagnose-crash",
    kind: "skill",
    description:
      "REQUIRED for end-user diagnosis of a process crash on this machine, from a systemd-coredump core dump. " +
      "Use when a process has segfaulted or aborted.",
  },
  {
    name: "unrelated-tool",
    kind: "tool",
    description: "Formats commit messages for a changelog.",
  },
];

/** Score everything at 0 (not relevant), so any "suggested" entry proves the mock, not the fallback. */
function zeroResponder(): (request: SystemOneRequest) => JevEvaluateResult {
  return (request) => {
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(request.questions)) {
      if (question.type === "score") {
        answers[key] = {
          type: "score",
          score: 0,
          legend: { "0": "a", "1": "b", "2": "c" },
          probabilities: { "0": 0.8, "1": 0.1, "2": 0.1 },
          confidence: 0.9,
        };
      }
    }
    return { kind: "ok", response: { model: "mock", answers, usage: { input_tokens: 1, output_tokens: 1 } }, requestId: "r", attempts: 1, elapsedMs: 1 };
  };
}

/** Score everything at 2 (highly relevant), so a required entry never showing up in `suggested` is provable. */
function highResponder(): (request: SystemOneRequest) => JevEvaluateResult {
  return (request) => {
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(request.questions)) {
      if (question.type === "score") {
        answers[key] = {
          type: "score",
          score: 2,
          legend: { "0": "a", "1": "b", "2": "c" },
          probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 },
          confidence: 0.9,
        };
      }
    }
    return { kind: "ok", response: { model: "mock", answers, usage: { input_tokens: 1, output_tokens: 1 } }, requestId: "r", attempts: 1, elapsedMs: 1 };
  };
}

describe("detectMandatoryTrigger", () => {
  it("matches a REQUIRED for clause sharing a keyword with the task", () => {
    const trigger = detectMandatoryTrigger(
      "diagnose why the process crashed with a segfault",
      SKILLS[1]!.description,
    );
    expect(trigger).not.toBeNull();
    expect(trigger).toContain("crash");
  });

  it("returns null when there is no REQUIRED clause or no keyword overlap", () => {
    expect(detectMandatoryTrigger("format the changelog", SKILLS[0]!.description)).toBeNull();
    expect(detectMandatoryTrigger("plant a garden", SKILLS[1]!.description)).toBeNull();
  });
});

describe("rankCapabilities", () => {
  it("AC: a REQUIRED trigger is marked required regardless of Jev score (mock scores it 0)", async () => {
    const transport = new MockJevTransport({ responder: zeroResponder() });
    const ctx: AskContext = { transport, model: "jev-test" };
    const result = await rankCapabilities(ctx, "diagnose why the process crashed with a segfault", SKILLS);
    expect(result.required.map((r) => r.capability.name)).toContain("diagnose-crash");
    const requiredEntry = result.required.find((r) => r.capability.name === "diagnose-crash");
    expect(requiredEntry?.relevance).toBeNull();
    expect(requiredEntry?.trigger).not.toBeNull();
    // Never double-counted as a suggestion, whatever the mock would have scored it.
    expect(result.suggested.map((r) => r.capability.name)).not.toContain("diagnose-crash");
  });

  it("a required capability stays required even when Jev would have scored it highly relevant", async () => {
    const transport = new MockJevTransport({ responder: highResponder() });
    const ctx: AskContext = { transport, model: "jev-test" };
    const result = await rankCapabilities(ctx, "diagnose why the process crashed with a segfault", SKILLS);
    expect(result.required.map((r) => r.capability.name)).toContain("diagnose-crash");
    expect(result.suggested.map((r) => r.capability.name)).not.toContain("diagnose-crash");
  });

  it("AC: zero suggestions is a valid outcome", async () => {
    const transport = new MockJevTransport({ responder: zeroResponder() });
    const ctx: AskContext = { transport, model: "jev-test" };
    const result = await rankCapabilities(ctx, "plant a garden in the yard", [SKILLS[0]!, SKILLS[2]!]);
    expect(result.required).toEqual([]);
    expect(result.suggested).toEqual([]);
  });

  it("suggests a non-mandatory capability that clears the threshold, sorted highest first", async () => {
    const transport = new MockJevTransport({ responder: highResponder() });
    const ctx: AskContext = { transport, model: "jev-test" };
    const result = await rankCapabilities(ctx, "extract text and tables from a pdf report", [SKILLS[0]!, SKILLS[2]!]);
    expect(result.suggested.length).toBeGreaterThan(0);
    expect(result.suggested[0]?.capability.name).toBe("pdf-processing");
    expect(result.suggested[0]?.relevance?.value).toBeGreaterThanOrEqual(DEFAULT_SUGGEST_THRESHOLD);
  });

  it("with no Jev key, ranking still works from the keyword-overlap fallback", async () => {
    const ctx: AskContext = { transport: new DisabledJevTransport(), model: "jev-test" };
    const result = await rankCapabilities(ctx, "extract text and tables from pdf files", [SKILLS[0]!, SKILLS[2]!]);
    expect(result.suggested.map((r) => r.capability.name)).toContain("pdf-processing");
    expect(result.suggested[0]?.relevance?.source).toBe("fallback");
  });

  it("bounds ranking to maxCandidates, leaving required capabilities unaffected", async () => {
    const transport = new MockJevTransport({ responder: highResponder() });
    const ctx: AskContext = { transport, model: "jev-test" };
    const many: Capability[] = Array.from({ length: 5 }, (_, i) => ({
      name: `tool-${i}`,
      kind: "tool" as const,
      description: `does thing number ${i}`,
    }));
    const result = await rankCapabilities(ctx, "the process crashed with a segfault", [...many, SKILLS[1]!], { maxCandidates: 2 });
    expect(result.suggested).toHaveLength(2);
    expect(result.required.map((r) => r.capability.name)).toEqual(["diagnose-crash"]);
  });
});
