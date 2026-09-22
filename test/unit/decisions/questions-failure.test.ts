/**
 * Issue #52: `failure.classify@1` and `stall.repeated_approach@1` exist,
 * are registered with a pinned hash, and have deterministic fallbacks that
 * never guess (AC1: "unknown must be a real category that asks for
 * evidence").
 */
import { describe, it, expect } from "vitest";
import {
  FAILURE_QUESTION_HASHES,
  failureClassifyQuestion,
  failureQuestionRegistry,
  stallRepeatedApproachQuestion,
  type FailureClassifyState,
  type RepeatedApproachState,
} from "../../../src/decisions/questions/failure.ts";
import { FAILURE_CATEGORIES } from "../../../src/workflow/failure.ts";
import {
  CLASSIFY_TAIL_BYTES,
  classifyFailureWithJev,
  failureClassifyState,
} from "../../../src/workflow/failure-classify.ts";
import { DisabledJevTransport } from "../../../src/jev/disabled.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";

const FAILURE_STATE: FailureClassifyState = {
  command: "npm test",
  exitCode: 1,
  stderrTail: "something happened",
  stdoutTail: "",
  taskGoal: "make the test pass",
};

const APPROACH_STATE: RepeatedApproachState = {
  taskGoal: "make the test pass",
  previousApproach: "patched the assertion",
  currentApproach: "patched the assertion differently",
  previousFailure: "assertion still failed",
};

describe("AC1 failure.classify@1", () => {
  it("AC1 is registered at id@version with its reviewed content hash", () => {
    expect(failureClassifyQuestion.key).toBe("failure.classify@1");
    expect(FAILURE_QUESTION_HASHES["failure.classify@1"]).toBe(failureClassifyQuestion.contentHash);
    expect(failureQuestionRegistry.get("failure.classify@1")).toBe(failureClassifyQuestion);
  });

  it("AC1 offers exactly the taxonomy categories as options", () => {
    const question = failureClassifyQuestion.buildQuestion();
    const options = question.type === "choice" ? Object.keys(question.criteria) : [];
    expect(options.sort()).toEqual([...FAILURE_CATEGORIES].sort());
  });

  it("AC1 falls back to unknown with no key, for every reason", () => {
    for (const reason of ["disabled", "transport_error", "abstained", "invalid_response"] as const) {
      expect(failureClassifyQuestion.fallback(FAILURE_STATE, reason).value).toBe("unknown");
    }
  });

  it("AC1 an out-of-band choice is coerced to unknown, never to a guess", () => {
    const interpreted = failureClassifyQuestion.interpret(
      { type: "choice", choice: "cosmic_rays", confidence: 0.99, probabilities: { cosmic_rays: 0.99 } },
      FAILURE_STATE,
    );
    expect(interpreted?.value).toBe("unknown");
  });

  it("AC1 state sent outbound is minimal: only the declared fields", () => {
    expect(Object.keys(failureClassifyQuestion.buildState(FAILURE_STATE)).sort()).toEqual([
      "command",
      "exitCode",
      "stderrTail",
      "stdoutTail",
      "taskGoal",
    ]);
  });
});

describe("AC2 stall.repeated_approach@1", () => {
  it("AC2 is registered at id@version with its reviewed content hash", () => {
    expect(stallRepeatedApproachQuestion.key).toBe("stall.repeated_approach@1");
    expect(FAILURE_QUESTION_HASHES["stall.repeated_approach@1"]).toBe(stallRepeatedApproachQuestion.contentHash);
    expect(failureQuestionRegistry.get("stall.repeated_approach@1")).toBe(stallRepeatedApproachQuestion);
  });

  it("AC2 falls back to not_repeated, never inventing a stall without a key", () => {
    for (const reason of ["disabled", "transport_error", "abstained", "invalid_response"] as const) {
      expect(stallRepeatedApproachQuestion.fallback(APPROACH_STATE, reason).value).toBe("not_repeated");
    }
  });

  it("AC2 an unrecognised choice becomes unknown, not repeated", () => {
    const interpreted = stallRepeatedApproachQuestion.interpret(
      { type: "choice", choice: "maybe", confidence: 0.9, probabilities: { maybe: 0.9 } },
      APPROACH_STATE,
    );
    expect(interpreted?.value).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// composition with the deterministic layer (src/workflow/failure-classify.ts)
// ---------------------------------------------------------------------------

describe("AC1 classifyFailureWithJev: rules first, unknown never a guess", () => {
  const MODEL = "jev-test";

  function respond(choice: string, confidence: number): MockJevTransport {
    return new MockJevTransport({ responder: (request) => ({
      kind: "ok",
      response: {
        model: MODEL,
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([key, q]) => {
            const options = Object.keys((q as { criteria: Record<string, string> }).criteria);
            const rest = (1 - confidence) / (options.length - 1);
            const probabilities = Object.fromEntries(options.map((o) => [o, o === choice ? confidence : rest]));
            return [key, { type: "choice", choice, probabilities, confidence }];
          }),
        ),
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      requestId: "req-1",
      attempts: 1,
      elapsedMs: 1,
    }) });
  }

  it("AC1 a deterministic match never reaches Jev", async () => {
    let called = false;
    const transport = new MockJevTransport({
      responder: () => {
        called = true;
        throw new Error("should not be asked");
      },
    });
    const result = await classifyFailureWithJev({ transport, model: MODEL }, { httpStatus: 429 });
    expect(result.category).toBe("quota");
    expect(result.source).toBe("rule");
    expect(called).toBe(false);
  });

  it("AC1 with no key the residue is unknown and asks for evidence", async () => {
    const ctx = { transport: new DisabledJevTransport("Jev is disabled: no key configured."), model: MODEL };
    const result = await classifyFailureWithJev(ctx, { exitCode: 1, stderr: "it broke" });
    expect(result.category).toBe("unknown");
    expect(result.needsEvidence).toBe(true);
    expect(result.evidenceRequests.length).toBeGreaterThan(0);
  });

  it("AC1 a confident Jev answer classifies the residue", async () => {
    const result = await classifyFailureWithJev(
      { transport: respond("implementation", 0.92), model: MODEL },
      { exitCode: 1, stderr: "assertion failed somewhere" },
    );
    expect(result.category).toBe("implementation");
    expect(result.source).toBe("jev");
  });

  it("AC1 a Jev unknown stays unknown and still asks for evidence", async () => {
    const result = await classifyFailureWithJev(
      { transport: respond("unknown", 0.95), model: MODEL },
      { exitCode: 1, stderr: "it broke" },
    );
    expect(result.category).toBe("unknown");
    expect(result.needsEvidence).toBe(true);
  });

  it("AC1 outbound state carries only truncated tails of the captured streams", () => {
    const state = failureClassifyState({ stderr: "x".repeat(5000), command: "npm test" }, "goal");
    expect(state.stderrTail.length).toBe(CLASSIFY_TAIL_BYTES);
    expect(state.command).toBe("npm test");
  });
});
